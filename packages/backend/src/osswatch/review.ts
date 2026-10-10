// 复核轮（ym195 命主令）：白天免费模型先写先出（scan.ts 解读链不变），优惠窗用显式指派的
// 强模型（ossDigestReview，默认指派部署计划模型，不吃免费路由保独立性）对照原始材料复核，
// 问题提炼成教训沉淀（settings 键 osswatch.lessons 滚动），次日白天解读注入教训段——
// 上下文学习闭环，无需微调即持续改进免费模型的输出。
import { z } from "zod";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { getProject, listDoneUnreviewed, saveReview } from "./store.ts";
import type { OssProjectRow, OssUpdateRow } from "./store.ts";

export const OSS_REVIEW_PROMPT_VERSION = promptVersion("oss-watch-review");
const REVIEW_SYSTEM = promptText("oss-watch-review");

export const ReviewSchema = z.object({
  verdict: z.enum(["passed", "issues"]),
  issues: z.array(z.string()),
  lessons: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type OssReview = z.infer<typeof ReviewSchema>;

export interface ReviewOutcome {
  ok: boolean;
  review: OssReview | null;
  receiptId: number | null;
  error: string | null;
}

const REVIEW_MAX_TOKENS = 3000;
const LESSONS_CAP = 30;

// ---- 教训沉淀（settings 键 osswatch.lessons，滚动窗口） ----

export interface LessonEntry {
  date: string;
  lesson: string;
}

export async function getLessons(): Promise<LessonEntry[]> {
  const rows = await sql<{ value: LessonEntry[] | null }[]>`SELECT value FROM settings WHERE key = 'osswatch.lessons'`;
  return rows[0]?.value ?? [];
}

async function saveLessons(next: LessonEntry[]): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('osswatch.lessons', ${sql.json(next as never)}, 'system: oss-review')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** 复核教训入池：按内容去重、新的在前、封顶 LESSONS_CAP。返回新增条数。 */
export async function addLessons(lessons: string[]): Promise<number> {
  const fresh = [...new Set(lessons.map((l) => l.trim()).filter(Boolean))];
  if (fresh.length === 0) return 0;
  const stored = await getLessons();
  const known = new Set(stored.map((l) => l.lesson));
  const date = new Date().toISOString().slice(0, 10);
  const added = fresh.filter((l) => !known.has(l)).map((lesson) => ({ date, lesson } satisfies LessonEntry));
  if (added.length === 0) return 0;
  await saveLessons([...added, ...stored].slice(0, LESSONS_CAP));
  return added.length;
}

/** 次日解读的 user 消息注入段（纯函数便于测试）：空教训返回空串。 */
export function lessonsBlock(lessons: LessonEntry[]): string {
  if (lessons.length === 0) return "";
  return `历史教训（此前复核轮沉淀，本次解读必须遵守）：\n${lessons.map((l) => `- ${l.lesson}`).join("\n")}`;
}

/** 单条复核（付费链：modelFor("ossDigestReview") + chatJson，永不抛错）。 */
export async function reviewUpdate(row: Pick<OssUpdateRow, "id" | "project_slug" | "kind" | "payload" | "digest">, project: OssProjectRow): Promise<ReviewOutcome> {
  try {
    const model = await modelFor("ossDigestReview");
    const user = `项目：${project.name}（${project.repo_url}）\n\n原始材料（唯一事实来源，kind=${row.kind}）：\n${JSON.stringify(row.payload, null, 1)}\n\n白天的解读（待复核）：\n${JSON.stringify(row.digest, null, 1)}`;
    const res = await chatJson({
      model,
      purpose: "oss_digest_review",
      subject: `${project.slug}#${row.id}`,
      promptVersion: OSS_REVIEW_PROMPT_VERSION,
      system: REVIEW_SYSTEM,
      user,
      schema: ReviewSchema,
      temperature: 0.1,
      maxTokens: REVIEW_MAX_TOKENS,
    });
    return { ok: true, review: res.data, receiptId: res.receiptId, error: null };
  } catch (error) {
    return { ok: false, review: null, receiptId: null, error: String(error).slice(0, 300) };
  }
}

export interface ReviewSummary {
  at: string;
  ok: boolean;
  error: string | null;
  reviewed: number;
  passed: number;
  issues: number;
  failed: number;
  lessonsAdded: number;
}

export interface ReviewOptions {
  /** 注入单条复核（测试）；缺省走 chatJson 付费链。 */
  reviewOne?: (row: OssUpdateRow, project: OssProjectRow) => ReviewOutcome | Promise<ReviewOutcome>;
  now?: Date;
}

/** 复核轮主循环（优惠窗 cron oss.review 调用；后台页可手动触发）。失败不打断本轮。 */
export async function reviewDueDigests(opts: ReviewOptions = {}): Promise<ReviewSummary> {
  const reviewOne = opts.reviewOne ?? reviewUpdate;
  const summary: ReviewSummary = { at: (opts.now ?? new Date()).toISOString(), ok: true, error: null, reviewed: 0, passed: 0, issues: 0, failed: 0, lessonsAdded: 0 };
  const due = await listDoneUnreviewed();
  for (const row of due) {
    const project = await getProject(row.project_slug);
    if (!project) continue;
    const out = await reviewOne(row, project);
    if (!out.ok || !out.review) {
      summary.failed++;
      continue; // 不写回：行保持未复核，下轮再试
    }
    await saveReview(row.id, out.review.verdict === "passed" ? "passed" : "issues", { ...out.review }, out.receiptId);
    summary.reviewed++;
    if (out.review.verdict === "passed") summary.passed++;
    else summary.issues++;
    summary.lessonsAdded += await addLessons(out.review.lessons);
  }
  return summary;
}
