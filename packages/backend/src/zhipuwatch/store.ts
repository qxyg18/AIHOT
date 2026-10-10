// zhipu_updates 单表读写 + zhipuwatch.* settings 键（水位 / 每轮摘要）。只做存取，不含策略。
import { sql } from "../db.ts";
import type { ZhipuKind } from "./sources.ts";

export interface ZhipuUpdateRow {
  id: number;
  kind: ZhipuKind;
  title: string;
  url: string;
  published_at: Date | null;
  payload: Record<string, unknown>;
  dedup_key: string;
  digest_status: "pending" | "done";
  digest: Record<string, unknown> | null;
  receipt_id: number | null;
  digested_at: Date | null;
  review_status: "passed" | "issues" | null;
  review: Record<string, unknown> | null;
  /** ym438：信号→路由动作留痕（pool_onboarded / window_written / window_refused / noted…）。 */
  routing_action: Record<string, unknown> | null;
  created_at: Date;
}

/** 单页水位：整页 content-hash（快路径跳过）+ 已出刊条目的指纹表（key→hash，条目改了=出更新刊）。 */
export interface PageWatermark {
  hash: string;
  items: Record<string, string>;
}

export interface SitemapWatermark {
  /** 受盯路径的 url→lastmod（处理过才推进；失败保持旧值下轮重试）。 */
  lastmods: Record<string, string>;
  baselineAt: string | null;
}

export interface ZhipuWatermarks {
  pages: Record<string, PageWatermark>;
  sitemap: SitemapWatermark | null;
  baselineAt: string | null;
}

export interface ZhipuLastRun {
  at: string;
  ok: boolean;
  error: string | null;
  sources: number;
  updates: number;
  digested: number;
  pending: number;
  /** ym438：本轮写入的信号→路由动作数（新出刊 + 存量回填）。 */
  actions: number;
  /** 运行观察（如「sitemap 还有 N 条待下轮」「pricing 有 N 行退出免费清单」）。 */
  notes: string[];
}

export async function listUpdates(limit = 60): Promise<ZhipuUpdateRow[]> {
  return sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

/** 待解读行（含上一轮失败标 pending 的），时间正序补。 */
export async function listPendingUpdates(limit = 20): Promise<ZhipuUpdateRow[]> {
  return sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates WHERE digest_status = 'pending' ORDER BY id LIMIT ${limit}`;
}

/** 已解读未复核的行（复核轮对象），时间正序先到先审。 */
export async function listDoneUnreviewed(limit = 20): Promise<ZhipuUpdateRow[]> {
  return sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates WHERE digest_status = 'done' AND review_status IS NULL ORDER BY id LIMIT ${limit}`;
}

/** ym438：待处理信号的行（存量回填；routing_action IS NULL 即未处理）。 */
export async function listRowsMissingRoutingAction(limit = 50): Promise<ZhipuUpdateRow[]> {
  return sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates WHERE routing_action IS NULL ORDER BY id LIMIT ${limit}`;
}

/** ym438：条件写回信号动作——routing_action IS NULL 才写（同窗重扫/并发回填零重复动作）。 */
export async function saveRoutingActionIfMissing(id: number, action: Record<string, unknown>): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE zhipu_updates SET routing_action = ${sql.json(action as never)}
    WHERE id = ${id} AND routing_action IS NULL RETURNING id`;
  return rows.length > 0;
}

/** 出刊一行；dedup_key 撞唯一约束返回 null（同窗重跑零重复的兜底，水位丢失也不重出）。 */
export async function insertUpdate(input: {
  kind: ZhipuKind;
  title: string;
  url: string;
  publishedAt: string | null;
  payload: Record<string, unknown>;
  dedupKey: string;
}): Promise<ZhipuUpdateRow | null> {
  const rows = await sql<ZhipuUpdateRow[]>`
    INSERT INTO zhipu_updates (kind, title, url, published_at, payload, dedup_key)
    VALUES (${input.kind}, ${input.title}, ${input.url}, ${input.publishedAt}, ${sql.json(input.payload as never)}, ${input.dedupKey})
    ON CONFLICT (dedup_key) DO NOTHING RETURNING *`;
  return rows[0] ?? null;
}

export async function saveDigest(id: number, digest: Record<string, unknown>, receiptId: number): Promise<void> {
  await sql`UPDATE zhipu_updates SET digest_status = 'done', digest = ${sql.json(digest as never)}, receipt_id = ${receiptId}, digested_at = now() WHERE id = ${id}`;
}

/** 解读失败：状态留 pending（下轮补），错误进 digest 暂存供后台页展示，成功解读时整块覆写。 */
export async function saveDigestError(id: number, error: string): Promise<void> {
  await sql`UPDATE zhipu_updates SET digest = ${sql.json({ error } as never)} WHERE id = ${id} AND digest_status = 'pending'`;
}

/** 复核结论写回：passed/issues 定档；复核回执号进 review JSON（receipt_id 列留给解读回执）。 */
export async function saveReview(id: number, status: "passed" | "issues", review: Record<string, unknown>, reviewReceiptId: number | null): Promise<void> {
  const payload = { ...review, reviewReceiptId, reviewedAt: new Date().toISOString() };
  await sql`UPDATE zhipu_updates SET review_status = ${status}, review = ${sql.json(payload as never)} WHERE id = ${id}`;
}

// ---- settings 键 ----

export async function getWatermarks(): Promise<ZhipuWatermarks> {
  const rows = await sql<{ value: ZhipuWatermarks | null }[]>`SELECT value FROM settings WHERE key = 'zhipuwatch.watermarks'`;
  return rows[0]?.value ?? { pages: {}, sitemap: null, baselineAt: null };
}

export async function saveWatermarks(marks: ZhipuWatermarks): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('zhipuwatch.watermarks', ${sql.json(marks as never)}, 'system: zhipu-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function getLastRun(): Promise<ZhipuLastRun | null> {
  const rows = await sql<{ value: ZhipuLastRun | null }[]>`SELECT value FROM settings WHERE key = 'zhipuwatch.lastrun'`;
  return rows[0]?.value ?? null;
}

export async function saveLastRun(run: ZhipuLastRun): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('zhipuwatch.lastrun', ${sql.json(run as never)}, 'system: zhipu-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}
