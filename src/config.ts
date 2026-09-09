/**
 * sb.sb 论坛 RSS 订阅推送 —— 运行配置
 *
 * 数据库连接参数与 Telegram 凭据从 .env 读取（Bun 自动加载）。
 * 非敏感参数（host/port/user/name）缺失时回退本地默认值便于开发；
 * 敏感凭据（密码、token、频道）不做明文兜底，缺失即为空，让连接失败尽早暴露。
 * 独立项目运行：bun run start
 */

/** 数据库连接各参数 */
const SB_DB_HOST = process.env.SB_DB_HOST ?? "127.0.0.1";
const SB_DB_PORT = process.env.SB_DB_PORT ?? "5555";
const SB_DB_USER = process.env.SB_DB_USER ?? "dianso";
const SB_DB_PASSWORD = process.env.SB_DB_PASSWORD ?? "";
const SB_DB_NAME = process.env.SB_DB_NAME ?? "sb";

/** 数据库连接串（密码含特殊字符需 encodeURIComponent 转义后拼接） */
export const SB_DB_URL = `postgres://${encodeURIComponent(SB_DB_USER)}:${encodeURIComponent(
  SB_DB_PASSWORD,
)}@${SB_DB_HOST}:${SB_DB_PORT}/${SB_DB_NAME}`;

/** Telegram 机器人与目标频道（公开频道可直接用 @username） */
export const SB_TELEGRAM = {
  token: process.env.SB_TELEGRAM_TOKEN ?? "",
  chatId: process.env.SB_TELEGRAM_CHAT_ID ?? "",
} as const;

/** 订阅源列表：全站 + 各分类节点，guid 主键去重，谁先抓到算谁的 */
export const SB_FEEDS = [
  { name: "全站", url: "https://sb.sb/rss.xml" },
  { name: "综合", url: "https://sb.sb/go/general/rss.xml" },
  { name: "AI", url: "https://sb.sb/go/ai/rss.xml" },
  { name: "域名", url: "https://sb.sb/go/domains/rss.xml" },
  { name: "主机", url: "https://sb.sb/go/hosting/rss.xml" },
  { name: "硬件", url: "https://sb.sb/go/hardware/rss.xml" },
  { name: "交易", url: "https://sb.sb/go/trade/rss.xml" },
  { name: "优惠", url: "https://sb.sb/go/discounts/rss.xml" },
  { name: "拼车", url: "https://sb.sb/go/cosub/rss.xml" },
  { name: "分享", url: "https://sb.sb/go/share/rss.xml" },
  { name: "推广", url: "https://sb.sb/go/promotion/rss.xml" },
  { name: "工作", url: "https://sb.sb/go/jobs/rss.xml" },
  { name: "投资", url: "https://sb.sb/go/invest/rss.xml" },
  { name: "水区", url: "https://sb.sb/go/off-topic/rss.xml" },
  { name: "公告", url: "https://sb.sb/go/announcement/rss.xml" },
] as const;

/** 轮询间隔：官方 feed 缓存 5 分钟 + 支持 304 条件请求，3 分钟轮询对目标站友好且延迟可接受 */
export const SB_POLL_INTERVAL_MS = 180_000;

/** 同一轮多帖推送的间隔：TG 对同一频道限速约 20 条/分钟 */
export const SB_PUSH_GAP_MS = 1_500;

/** 请求 UA：普通浏览器标识，降低被目标站 WAF 拦截概率 */
export const SB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";