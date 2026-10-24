// oss_watch 两张表的读写 + osswatch.* settings 键（水位 / 每轮摘要）。只做存取，不含策略。
import { sql } from "../db.ts";

export interface OssProjectRow {
  slug: string;
  name: string;
  repo_url: string;
  vendor: string;
  active: boolean;
  created_at: Date;
}

export interface OssUpdateRow {
  id: number;
  project_slug: string;
  kind: "release" | "tag" | "commit_batch";
  payload: Record<string, unknown>;
  digest_status: "pending" | "done";
  digest: Record<string, unknown> | null;
  receipt_id: number | null;
  digested_at: Date | null;
  /** ym195 复核轮：null=未复核 | passed | issues */
  review_status: "passed" | "issues" | null;
  review: Record<string, unknown> | null;
  created_at: Date;
}

/** 单项目采集水位：三面各自记「见到哪了」，同窗重跑零重复出刊的依据。 */
export interface OssWatermark {
  releaseId: number | null;
  lastCommitSha: string | null;
  lastCommitAt: string | null;
  tags: string[];
  baselineAt: string | null;
}

export interface OssLastRun {
  at: string;
  ok: boolean;
  error: string | null;
  projects: number;
  updates: number;
  digested: number;
  pending: number;
}

export async function listProjects(activeOnly = true): Promise<OssProjectRow[]> {
  return sql<OssProjectRow[]>`SELECT * FROM oss_projects ${activeOnly ? sql`WHERE active` : sql``} ORDER BY slug`;
}

export async function getProject(slug: string): Promise<OssProjectRow | null> {
  const rows = await sql<OssProjectRow[]>`SELECT * FROM oss_projects WHERE slug = ${slug}`;
  return rows[0] ?? null;
}

/** 登记新项目；slug 已存在返回 false（admin 层转为 400）。 */
export async function insertProject(p: { slug: string; name: string; repo_url: string; vendor: string }): Promise<boolean> {
  const rows = await sql<{ slug: string }[]>`
    INSERT INTO oss_projects (slug, name, repo_url, vendor) VALUES (${p.slug}, ${p.name}, ${p.repo_url}, ${p.vendor})
    ON CONFLICT (slug) DO NOTHING RETURNING slug`;
  return rows.length > 0;
}

export async function listUpdates(limit = 60, slug?: string): Promise<OssUpdateRow[]> {
  return sql<OssUpdateRow[]>`
    SELECT * FROM oss_updates ${slug ? sql`WHERE project_slug = ${slug}` : sql``}
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

/** 待解读行（含上一轮失败标 pending 的），跨项目按时间正序补。 */
export async function listPendingUpdates(limit = 20): Promise<OssUpdateRow[]> {
  return sql<OssUpdateRow[]>`SELECT * FROM oss_updates WHERE digest_status = 'pending' ORDER BY id LIMIT ${limit}`;
}

/** 已解读未复核的行（复核轮 ym195 的对象），时间正序先到先审。 */
export async function listDoneUnreviewed(limit = 20): Promise<OssUpdateRow[]> {
  return sql<OssUpdateRow[]>`SELECT * FROM oss_updates WHERE digest_status = 'done' AND review_status IS NULL ORDER BY id LIMIT ${limit}`;
}

export async function insertUpdate(projectSlug: string, kind: OssUpdateRow["kind"], payload: Record<string, unknown>): Promise<OssUpdateRow> {
  const rows = await sql<OssUpdateRow[]>`
    INSERT INTO oss_updates (project_slug, kind, payload) VALUES (${projectSlug}, ${kind}, ${sql.json(payload as never)})
    RETURNING *`;
  return rows[0]!;
}

export async function saveDigest(id: number, digest: Record<string, unknown>, receiptId: number): Promise<void> {
  await sql`UPDATE oss_updates SET digest_status = 'done', digest = ${sql.json(digest as never)}, receipt_id = ${receiptId}, digested_at = now() WHERE id = ${id}`;
}

/** 复核结论写回（ym195）：passed/issues 定档；复核回执号进 review JSON（receipt_id 列留给解读回执）。 */
export async function saveReview(id: number, status: "passed" | "issues", review: Record<string, unknown>, reviewReceiptId: number | null): Promise<void> {
  const payload = { ...review, reviewReceiptId, reviewedAt: new Date().toISOString() };
  await sql`UPDATE oss_updates SET review_status = ${status}, review = ${sql.json(payload as never)} WHERE id = ${id}`;
}

/** 解读失败：状态留 pending（下轮补），错误进 digest 暂存供后台页展示，成功解读时整块覆写。 */
export async function saveDigestError(id: number, error: string): Promise<void> {
  await sql`UPDATE oss_updates SET digest = ${sql.json({ error } as never)} WHERE id = ${id} AND digest_status = 'pending'`;
}

// ---- settings 键 ----

export async function getWatermarks(): Promise<Record<string, OssWatermark>> {
  const rows = await sql<{ value: Record<string, OssWatermark> | null }[]>`SELECT value FROM settings WHERE key = 'osswatch.watermarks'`;
  return rows[0]?.value ?? {};
}

export async function saveWatermarks(marks: Record<string, OssWatermark>): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('osswatch.watermarks', ${sql.json(marks as never)}, 'system: oss-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function getLastRun(): Promise<OssLastRun | null> {
  const rows = await sql<{ value: OssLastRun | null }[]>`SELECT value FROM settings WHERE key = 'osswatch.lastrun'`;
  return rows[0]?.value ?? null;
}

export async function saveLastRun(run: OssLastRun): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('osswatch.lastrun', ${sql.json(run as never)}, 'system: oss-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}
