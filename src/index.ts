/**
 * sb.sb 论坛 RSS 订阅推送 —— 独立进程入口
 *
 * 运行：bun run start
 *
 * 本入口作为独立进程常驻，setInterval 每 3 分钟一轮轮询 + TG 私聊长轮询。
 */
import { SB_FEEDS, SB_POLL_INTERVAL_MS, SB_TELEGRAM } from "./config";
import { runSbTick, stopSbBot } from "./task";
import { startSbBotLoop } from "./bot";

/** 带时间戳的统一日志（与 task.ts 保持同格式） */
function log(message: string): void {
  console.log(`[sb-bot ${new Date().toISOString()}] ${message}`);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("退出中…");
  await stopSbBot().catch(() => {});
  process.exit(0);
}

// 启动前校验必填凭据（密钥只从 env 读取，缺失即空；空值直接退出，避免带空凭据运行）
if (!SB_TELEGRAM.token || !SB_TELEGRAM.chatId || !process.env.SB_DB_PASSWORD) {
  log("缺少必填凭据：请检查 .env 中的 SB_DB_PASSWORD / SB_TELEGRAM_TOKEN / SB_TELEGRAM_CHAT_ID");
  process.exit(1);
}

log(`启动：${SB_FEEDS.length} 个源，轮询 ${SB_POLL_INTERVAL_MS / 1000}s`);
// 私聊交互：getUpdates 长轮询
void startSbBotLoop();
// 首轮立即执行（含建表兜底 + 历史帖静默入库），之后按间隔轮询
await runSbTick();
setInterval(() => void runSbTick(), SB_POLL_INTERVAL_MS);