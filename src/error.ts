/**
 * sb.sb 论坛 RSS 订阅推送 —— 本地错误类
 *
 * 本服务的场景仅将其作为带 message 的自定义错误抛出（HTTP 抓取失败、TG 接口异常等），
 * 上层统一 catch 后记日志并安排重试。
 */
export class InternalServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalServerError";
  }
}