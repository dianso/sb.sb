/**
 * sb.sb 论坛 RSS 解析：基于 Bun 1.4 内置 Bun.XML.parse（零依赖）
 *
 * 该站 RSS 结构规整：<rss><channel><item>guid/title/category/pubDate</item></channel></rss>
 * 注意 Bun.XML.parse 的 compact 形态：
 * - 单条 item 是对象、多条是数组（one-or-many），需 flat 处理
 * - 带属性的节点（如 <guid isPermaLink="true">）是对象，文本在 "#text"
 * - CDATA 与实体引用已自动展开为纯文本
 */
import { XML } from "bun";

/** 解析后的帖子条目 */
export interface SbPostItem {
  /** 帖子链接（guid），去重主键 */
  guid: string;
  title: string;
  category: string;
  publishedAt: Date;
}

/** 防御性读取 XML 节点文本：字符串直接返回；对象取 #text；数组取首个 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return textOf(value[0]);
  if (value !== null && typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

/**
 * 解析 RSS XML 为帖子列表。
 * XML 非良构时 Bun.XML.parse 抛 SyntaxError，由调用方按抓取失败退避处理。
 */
export function parseSbRss(xml: string): SbPostItem[] {
  const doc = XML.parse(xml) as Record<string, unknown>;
  const channel = (doc["rss"] as Record<string, unknown> | undefined)?.["channel"] as
    | Record<string, unknown>
    | undefined;
  const rawItems = channel?.["item"];
  // one-or-many：单条是对象，多条是数组，统一成数组
  const items = Array.isArray(rawItems) ? rawItems : rawItems !== undefined ? [rawItems] : [];

  const list: SbPostItem[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const guid = textOf(item["guid"]);
    const title = textOf(item["title"]);
    // 缺少链接或标题的脏数据直接跳过，不入库不推送
    if (!guid || !title) continue;
    const pubRaw = textOf(item["pubDate"]);
    const parsed = pubRaw !== "" ? new Date(pubRaw) : new Date(NaN);
    list.push({
      guid,
      title,
      category: textOf(item["category"]),
      // RFC822 时间解析失败时兜底为当前时间，保证可入库
      publishedAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
    });
  }
  return list;
}