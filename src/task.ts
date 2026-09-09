/**
 * sb.sb 论坛 RSS 订阅推送 —— 核心任务逻辑
 *
 * 独立进程模式：index.ts 用 setInterval 每 3 分钟调一次 runSbTick。
 *
 * 刻意使用 console.log 而非 createLogger：本服务配置全部写死（config.ts），
 * 日志直出始终可见。
 *
 * 容错：
 * - 单源失败仅记日志；全部源失败进入指数退避（1min→2min→…→30min 封顶），恢复即重置
 * - TG 发送失败保留 pushed_at IS NULL，下一轮自动重试，不丢消息
 * - ETag 条件请求：内容无变化时服务端返回 304，零解析成本
 */
import { InternalServerError } from "./error";

import { SB_FEEDS, SB_PUSH_GAP_MS, SB_TELEGRAM, SB_USER_AGENT } from "./config";
import {
  closeSbSql,
  ensureSbTable,
  getAllSbKeywords,
  getPendingSbPosts,
  getSbKeywordPushedChats,
  insertSbPosts,
  markAllSbPushed,
  markSbPushed,
  recordSbKeywordPush,
} from "./db";
import { type SbPostItem, parseSbRss } from "./parser";
import { stopSbBotLoop } from "./bot";

/** 带时间戳的统一日志 */
function log(message: string, ...rest: unknown[]): void {
  console.log(`[sb-bot ${new Date().toISOString()}] ${message}`, ...rest);
}

/** HTML 转义：TG parse_mode=HTML 下标题中的 & < > 必须转义 */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ---- ETag 缓存（进程内存即可：重启后多一次全量抓取，无正确性影响） ----
const etagCache = new Map<string, string>();

/** 抓取单个订阅源：304 跳过；200 解析；非 200 抛错由调用方统计 */
async function pollFeed(feed: (typeof SB_FEEDS)[number]): Promise<SbPostItem[]> {
  const etag = etagCache.get(feed.url);
  const res = await fetch(feed.url, {
    headers: {
      "User-Agent": SB_USER_AGENT,
      // 条件请求：内容未变化时服务端返回 304，不重复传输
      ...(etag !== undefined ? { "If-None-Match": etag } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 304) return [];
  // 非 200 响应抛出本地错误类（由上层捕获统计与重试）
  if (!res.ok) throw new InternalServerError(`HTTP ${res.status}`);

  const newEtag = res.headers.get("etag");
  if (newEtag !== null) etagCache.set(feed.url, newEtag);

  return parseSbRss(await res.text());
}

/** 发送一条 TG 消息（chatId 可为频道 @username 或私聊数字 id）；
 *  429 时按 retry_after 等待后重试一次，其余错误抛出 */
async function sendTelegram(chatId: string, text: string): Promise<void> {
  const send = async (): Promise<Response> =>
    fetch(`https://api.telegram.org/bot${SB_TELEGRAM.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // 链接卡片预览：TG Bot API 新参数（disable_web_page_preview 已废弃），
        // is_disabled 不传即启用预览，帖子链接会展示标题/缩略图卡片
        link_preview_options: { is_disabled: false },
      }),
      signal: AbortSignal.timeout(10_000),
    });

  let res = await send();
  if (res.status === 429) {
    // 触发限流：按服务端指示等待后重试一次，仍失败则留给下一轮
    const retryAfter = Number((await res.json().catch(() => ({})))?.["parameters"]?.["retry_after"] ?? 3);
    log(`TG 限流，${retryAfter}s 后重试`);
    await Bun.sleep(retryAfter * 1000);
    res = await send();
  }
  // TG 接口响应异常抛出本地错误类（由上层捕获并安排下轮重试）
  if (!res.ok) throw new InternalServerError(`TG HTTP ${res.status}: ${await res.text()}`);
}

/** 推送所有待推送帖子（按发布时间正序）；单条失败即中断本轮，剩余留待下轮 */
async function pushPending(): Promise<void> {
  const pending = await getPendingSbPosts();
  if (pending.length === 0) return;
  log(`待推送 ${pending.length} 条`);

  for (const post of pending) {
    const text = `${post.category !== "" ? `【${post.category}】` : ""}${escapeHtml(post.title)}\n${post.guid}`;
    try {
      await sendTelegram(SB_TELEGRAM.chatId, text);
      await markSbPushed(post.guid);
    } catch (error) {
      // 中断本轮：避免网络故障时逐条空转，未推送的下轮继续
      log("推送失败，本轮中止，下轮重试", error);
      break;
    }
    // TG 同频道限速约 20 条/分钟，保守间隔
    await Bun.sleep(SB_PUSH_GAP_MS);
  }
}

/** 关键词订阅推送：新帖对全部关键词做不区分大小写正则匹配，命中且未推送过的私聊发送
 *  单条失败仅记日志跳过（该用户此帖留待下轮重试），不影响其他用户 */
async function pushKeywordMatches(posts: SbPostItem[]): Promise<void> {
  if (posts.length === 0) return;
  const keywords = await getAllSbKeywords();
  if (keywords.length === 0) return;

  for (const post of posts) {
    // 标题 + 分类联合文本
    const haystack = `${post.title} ${post.category}`;
    // 每个关键词作为正则表达式匹配（不区分大小写），异常时跳过该关键词
    const hitKeywords = keywords.filter((k) => {
      try {
        return new RegExp(k.keyword, "i").test(haystack);
      } catch (error) {
        log(`正则匹配异常「${k.keyword}」: ${error}`);
        return false;
      }
    });
    if (hitKeywords.length === 0) continue;

    // 该帖已推送过的用户集合（防重复）
    const pushed = await getSbKeywordPushedChats(post.guid);
    const text = `🔔 关键词命中\n${post.category !== "" ? `【${post.category}】` : ""}${escapeHtml(post.title)}\n${post.guid}`;

    for (const { chatId, keyword } of hitKeywords) {
      if (pushed.has(chatId)) continue;
      try {
        await sendTelegram(chatId, text);
        await recordSbKeywordPush(post.guid, chatId);
        log(`关键词「${keyword}」命中推送给 ${chatId}`);
      } catch (error) {
        log(`推送给 ${chatId} 失败（下轮重试）`, error);
      }
      // 私聊限速与频道同级别，保守间隔
      await Bun.sleep(SB_PUSH_GAP_MS);
    }
  }
}

// ---- 轮询状态 ----
let booted = false; // 首轮是否已静默完成（至少一源成功抓取过）
let failStreak = 0; // 连续全败轮数（指数退避用）
let backoffUntil = 0; // 退避截止时间戳
let tableReady = false; // 建表兜底是否已执行
let running = false; // 单轮执行中标记（防重入）

/** 单轮轮询：全量异常捕获，保证定时器回调永不抛出未处理异常 */
export async function runSbTick(): Promise<void> {
  if (running) {
    log("上一轮尚未结束，跳过本轮");
    return;
  }
  running = true;
  try {
    await tickInner();
  } catch (error) {
    log("tick 异常", error);
  } finally {
    running = false;
  }
}

async function tickInner(): Promise<void> {
  if (!tableReady) {
    await ensureSbTable();
    tableReady = true;
  }

  if (Date.now() < backoffUntil) {
    log(`退避中，跳过本轮（剩余 ${Math.ceil((backoffUntil - Date.now()) / 1000)}s）`);
    return;
  }

  const items: SbPostItem[] = [];
  let okCount = 0;
  for (const feed of SB_FEEDS) {
    try {
      items.push(...(await pollFeed(feed)));
      okCount++;
    } catch (error) {
      log(`[${feed.name}] 抓取失败`, error);
    }
    // 源之间礼貌间隔，避免瞬时并发请求
    await Bun.sleep(500);
  }

  // 全部源失败 → 指数退避：1min、2min、4min…30min 封顶；任一成功即重置
  if (okCount === 0) {
    failStreak++;
    const waitMs = Math.min(30 * 60_000, 60_000 * 2 ** (failStreak - 1));
    backoffUntil = Date.now() + waitMs;
    log(`全部源失败（连续 ${failStreak} 轮），退避 ${Math.round(waitMs / 60_000)} 分钟`);
    return;
  }
  failStreak = 0;

  // 新帖入库（ON CONFLICT 去重，仅真正新插入的返回）
  let fresh: SbPostItem[] = [];
  if (items.length > 0) {
    fresh = await insertSbPosts(items);
    log(`解析 ${items.length} 条，新帖 ${fresh.length} 条`);
  }

  // 首轮静默：历史帖全部标记已推送，不刷屏频道；关键词订阅同样不推历史帖
  if (!booted) {
    await markAllSbPushed();
    booted = true;
    log("首轮抓取完成，历史帖已静默入库（不推送）");
    return;
  }

  await pushPending();
  // 频道推送后做关键词匹配推送（fresh 仅本轮真新帖，历史帖不会命中）
  await pushKeywordMatches(fresh);
}

/** 独立进程退出时清理连接池与长轮询 */
export async function stopSbBot(): Promise<void> {
  stopSbBotLoop();
  await closeSbSql();
}