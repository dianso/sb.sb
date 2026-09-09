/**
 * sb-bot 私聊交互：TG getUpdates 长轮询
 *
 * 连接常驻挂在 TG 服务器上（timeout 25s）：用户发消息的瞬间 TG 即返回，
 * 机器人 ~1s 内回复，体验等同 webhook 且无需公网域名/证书。
 *
 * 命令（仅私聊生效，群组消息忽略）：
 * - /start 或 /help  使用说明
 * - /list            查看我的关键词（带编号）
 * - /del <编号>      按编号删除关键词
 * - 其他任意文本      作为正则关键词订阅（新帖标题/分类正则命中即推送给你）
 */
import { SB_TELEGRAM } from "./config";
import { addSbKeyword, deleteSbKeyword, listSbKeywords } from "./db";
import { InternalServerError } from "./error";

/** 帮助文案（HTML 模式） */
const HELP_TEXT = [
  "<b>sb.sb 论坛关键词订阅</b>",
  "",
  "直接发送文本 = 添加正则关键词（新帖标题/分类命中即推送）",
  "示例：",
  "  <code>ai|gpt</code> - 匹配 ai 或 gpt",
  "  <code>python|rust</code> - 匹配 python 或 rust",
  "  <code>C\\+\\+</code> - 匹配 C++（特殊字符需转义）",
  "",
  "/list - 查看我的关键词",
  "/del 编号 - 删除关键词（编号见 /list）",
].join("\n");

/** 带时间戳的统一日志（与 task.ts 保持同格式） */
function log(message: string, ...rest: unknown[]): void {
  console.log(`[sb-bot ${new Date().toISOString()}] ${message}`, ...rest);
}

/** HTML 转义：用户提交的关键词 / 回复内容中的 & < > 必须转义 */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 回复私聊消息（失败仅记日志，不影响长轮询循环） */
async function reply(chatId: number, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${SB_TELEGRAM.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log(`回复失败 HTTP ${res.status}`, await res.text());
  } catch (error) {
    log("回复异常", error);
  }
}

/** 构建正则关键词预览文案（中文含义） */
function buildRegexPreview(pattern: string): string {
  let desc = "";
  if (pattern.includes("|")) {
    const parts = pattern.split("|").slice(0, 5);
    desc = `匹配 "${parts.join('" 或 "')}"`;
    if (pattern.split("|").length > 5) desc += " 等";
  } else if (pattern === "\\d") {
    desc = "匹配任意数字";
  } else if (pattern === "\\w") {
    desc = "匹配字母、数字、下划线";
  } else if (pattern === "\\s") {
    desc = "匹配空白字符";
  } else {
    desc = `匹配包含 "${pattern}" 的内容`;
  }
  return `📝 ${desc}`;
}

/** 处理单条私聊消息 */
async function handleMessage(chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();

  if (trimmed === "/start" || trimmed === "/help") {
    await reply(chatId, HELP_TEXT);
    return;
  }

  if (trimmed === "/list") {
    const rows = await listSbKeywords(String(chatId));
    if (rows.length === 0) {
      await reply(chatId, "还没有订阅任何关键词，直接发送文本即可添加。");
      return;
    }
    const lines = rows.map((r, i) => `${i + 1}. <code>${escapeHtml(r.keyword)}</code>`);
    await reply(chatId, `<b>我的关键词（${rows.length}）</b>\n${lines.join("\n")}\n\n删除：/del 编号`);
    return;
  }

  // /del 2 或 /del@BotName 2
  if (trimmed.startsWith("/del")) {
    const part = trimmed.replace(/^\/del(@\w+)?\s*/, "");
    const index = Number.parseInt(part, 10);
    if (!Number.isInteger(index) || index < 1) {
      await reply(chatId, "用法：/del 编号（编号见 /list）");
      return;
    }
    const rows = await listSbKeywords(String(chatId));
    const target = rows[index - 1];
    if (target === undefined) {
      await reply(chatId, `编号 ${index} 不存在，请先 /list 查看。`);
      return;
    }
    const removed = await deleteSbKeyword(String(chatId), target.id);
    await reply(chatId, removed !== null ? `🗑 已删除：<code>${escapeHtml(removed)}</code>` : "删除失败，请重试。");
    return;
  }

  // 其余命令（未知 /xxx）提示
  if (trimmed.startsWith("/")) {
    await reply(chatId, "未知命令。直接发送文本添加关键词，/list 查看，/del 编号删除。");
    return;
  }

  // 普通文本 = 添加正则关键词（长度约束：太短误命中率高，太长基本无意义）
  const pattern = trimmed.slice(0, 100);
  if (pattern.length < 1) {
    await reply(chatId, "关键词不能为空。");
    return;
  }

  // 校验正则合法性
  try {
    new RegExp(pattern);
  } catch (error) {
    await reply(
      chatId,
      `❌ 无效正则：${error}\n\n提示：\n- 要匹配 + 号请写 \\+\n- 要匹配 (x) 请写 \\(x\\)\n- 要匹配 | 请写 \\|`,
    );
    return;
  }

  // 直接保存并显示含义预览
  const added = await addSbKeyword(String(chatId), pattern);
  if (added) {
    const total = (await listSbKeywords(String(chatId))).length;
    const desc = buildRegexPreview(pattern);
    await reply(
      chatId,
      `✅ 已订阅：<code>${escapeHtml(pattern)}</code>\n${desc}\n（当前共 ${total} 个，/list 查看，/del 编号删除）`,
    );
  } else {
    await reply(chatId, `该关键词已存在：<code>${escapeHtml(pattern)}</code>`);
  }
}

/** TG update 的最小结构（仅取需要的字段） */
interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    text?: string;
  };
}

// ---- 长轮询循环状态 ----
let botRunning = false;

/** getUpdates 长轮询循环：常驻挂起等消息，收到即处理并立即回复 */
export async function startSbBotLoop(): Promise<void> {
  if (botRunning) return;
  botRunning = true;
  log("私聊机器人已启动（getUpdates 长轮询）");

  let offset = 0; // 已确认的最大 update_id + 1（TG 据此确认消费）
  while (botRunning) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${SB_TELEGRAM.token}/getUpdates?timeout=25&offset=${offset}`,
        // 挂起等待上限 25s + 网络余量
        { signal: AbortSignal.timeout(60_000) },
      );
      // TG getUpdates 接口异常抛出本地错误类（由外层 catch 捕获并延迟重试）
      if (!res.ok) throw new InternalServerError(`HTTP ${res.status}`);

      const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      const updates = body.result ?? [];
      for (const u of updates) {
        offset = u.update_id + 1;
        // 仅处理私聊文本消息，群组/频道/非文本一律忽略
        if (u.message?.chat.type === "private" && typeof u.message.text === "string") {
          await handleMessage(u.message.chat.id, u.message.text);
        }
      }
    } catch (error) {
      // 网络抖动/超时：短暂等待后重连，循环永不退出
      if (botRunning) {
        log("getUpdates 异常，3s 后重试", error);
        await Bun.sleep(3_000);
      }
    }
  }
}

/** 停止长轮询循环（进程退出时调用） */
export function stopSbBotLoop(): void {
  botRunning = false;
}