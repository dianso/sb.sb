/**
 * sb_posts 表数据访问：Bun SQL（postgres）+ 模块级单例连接池
 *
 * 去重策略：guid 主键 + INSERT ... ON CONFLICT (guid) DO NOTHING RETURNING，
 * 仅真正新插入的行会返回，天然区分"新帖"与"已见帖"。
 * 推送与入库解耦：pushed_at IS NULL 的记录每轮重试，TG 失败不丢消息。
 */
import { SQL } from "bun";

import type { SbPostItem } from "./parser";
import { SB_DB_URL } from "./config";

let sbSql: SQL | null = null;

/** 获取 sb 库连接池（单进程低频查询，池上限 2 足够） */
export function getSbSql(): SQL {
  if (sbSql === null) {
    sbSql = new SQL({ url: SB_DB_URL, max: 2, idleTimeout: 60 });
  }
  return sbSql;
}

/** 关闭连接池（进程退出时调用） */
export async function closeSbSql(): Promise<void> {
  if (sbSql !== null) {
    await sbSql.end();
    sbSql = null;
  }
}

/** 数据库行 → SbPostItem 的映射（Bun SQL 返回弱类型行，统一转换） */
function toPostItem(row: Record<string, unknown>): SbPostItem {
  return {
    guid: String(row["guid"]),
    title: String(row["title"]),
    category: row["category"] === null ? "" : String(row["category"]),
    publishedAt: new Date(String(row["published_at"])),
  };
}

/** 建表兜底（幂等，与根目录 sb.sql 保持一致；部署新环境无需手动执行 SQL） */
export async function ensureSbTable(): Promise<void> {
  const db = getSbSql();
  await db`
    CREATE TABLE IF NOT EXISTS sb_posts (
      guid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pushed_at TIMESTAMPTZ
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_sb_posts_published_at ON sb_posts(published_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS idx_sb_posts_pushed_at ON sb_posts(pushed_at) WHERE pushed_at IS NULL`;

  // 关键词订阅相关表
  await db`
    CREATE TABLE IF NOT EXISTS sb_keywords (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, keyword)
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_sb_keywords_chat_id ON sb_keywords(chat_id)`;
  await db`
    CREATE TABLE IF NOT EXISTS sb_keyword_pushes (
      guid TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guid, chat_id)
    )
  `;
}

/** 批量入库，返回真正新插入的帖子（已存在的被 ON CONFLICT 静默跳过）
 *  注：Bun SQL 无 sql.join 辅助函数，逐条参数化插入；每轮增量仅 0~50 条，性能足够 */
export async function insertSbPosts(items: SbPostItem[]): Promise<SbPostItem[]> {
  const db = getSbSql();
  const fresh: SbPostItem[] = [];
  for (const item of items) {
    const rows = (await db`
      INSERT INTO sb_posts (guid, title, category, published_at)
      VALUES (${item.guid}, ${item.title}, ${item.category}, ${item.publishedAt})
      ON CONFLICT (guid) DO NOTHING
      RETURNING guid, title, category, published_at
    `) as unknown as Array<Record<string, unknown>>;
    if (rows.length > 0) fresh.push(toPostItem(rows[0]!));
  }
  return fresh;
}

/** 查询待推送帖子（按发布时间正序，TG 发送失败留在下轮重试） */
export async function getPendingSbPosts(): Promise<SbPostItem[]> {
  const db = getSbSql();
  const rows = (await db`
    SELECT guid, title, category, published_at
    FROM sb_posts
    WHERE pushed_at IS NULL
    ORDER BY published_at ASC
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map(toPostItem);
}

/** 标记单条已推送 */
export async function markSbPushed(guid: string): Promise<void> {
  const db = getSbSql();
  await db`UPDATE sb_posts SET pushed_at = NOW() WHERE guid = ${guid}`;
}

/** 首轮启动静默：把当前全部记录标记为已推送，避免历史 ~550 条刷屏频道 */
export async function markAllSbPushed(): Promise<void> {
  const db = getSbSql();
  await db`UPDATE sb_posts SET pushed_at = NOW() WHERE pushed_at IS NULL`;
}

// ---------------- 关键词订阅 ----------------

/** 用户的关键词记录 */
export interface SbKeywordRow {
  id: number;
  keyword: string;
}

/** 添加关键词；已存在（UNIQUE 冲突）返回 false */
export async function addSbKeyword(chatId: string, keyword: string): Promise<boolean> {
  const db = getSbSql();
  const rows = (await db`
    INSERT INTO sb_keywords (chat_id, keyword)
    VALUES (${chatId}, ${keyword})
    ON CONFLICT (chat_id, keyword) DO NOTHING
    RETURNING id
  `) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/** 某用户的关键词列表（按创建时间正序，配合 /del 编号使用） */
export async function listSbKeywords(chatId: string): Promise<SbKeywordRow[]> {
  const db = getSbSql();
  const rows = (await db`
    SELECT id, keyword FROM sb_keywords WHERE chat_id = ${chatId} ORDER BY id ASC
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r["id"]), keyword: String(r["keyword"]) }));
}

/** 按编号删除某用户的关键词；不存在返回 false */
export async function deleteSbKeyword(chatId: string, id: number): Promise<string | null> {
  const db = getSbSql();
  const rows = (await db`
    DELETE FROM sb_keywords WHERE chat_id = ${chatId} AND id = ${id} RETURNING keyword
  `) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0 ? String(rows[0]!["keyword"]) : null;
}

/** 全量关键词（新帖匹配用；用户量小，全量拉取后内存匹配即可） */
export async function getAllSbKeywords(): Promise<Array<{ chatId: string; keyword: string }>> {
  const db = getSbSql();
  const rows = (await db`
    SELECT chat_id, keyword FROM sb_keywords
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ chatId: String(r["chat_id"]), keyword: String(r["keyword"]) }));
}

/** 查询某帖子已推送过的 chat_id 集合（防重复推送） */
export async function getSbKeywordPushedChats(guid: string): Promise<Set<string>> {
  const db = getSbSql();
  const rows = (await db`
    SELECT chat_id FROM sb_keyword_pushes WHERE guid = ${guid}
  `) as unknown as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => String(r["chat_id"])));
}

/** 记录关键词命中推送成功（发送失败不写入，下轮自动重试） */
export async function recordSbKeywordPush(guid: string, chatId: string): Promise<void> {
  const db = getSbSql();
  await db`
    INSERT INTO sb_keyword_pushes (guid, chat_id) VALUES (${guid}, ${chatId})
    ON CONFLICT (guid, chat_id) DO NOTHING
  `;
}