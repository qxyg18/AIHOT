// 复核轮（ym437 卡面 S05）：清晨轮由免费通道快速写出的解读，23:36 用显式指派的强模型
// （zhipuDigestReview，代码级排除免费路由，保复核与被复核不同源）对照原始材料逐条复核，
// passed/issues 写回行供后台页展示。失败不写回、下轮再试。
import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { strList } from "./scan.ts";
import { listDoneUnreviewed, saveReview } from "./store.ts";
import type { ZhipuUpdateRow } from "./store.ts";

export const ZHIPU_REVIEW_PROMPT_VERSION = promptVersion("zhipu-watch-review");
const REVIEW_SYSTEM = promptText("zhipu-watch-review");

export const ReviewSchema = z.object({
  verdict: z.enum(["passed", "issues"]),
  // 与解读同宽容：模型偶把 issues 写成对象数组（见 scan.ts strList）。
  issues: strList,
  confidence: z.number().min(0).max(1),
});
export type ZhipuReview = z.infer<typeof ReviewSchema>;

export interface ReviewOutcome {
  ok: boolean;
  review: ZhipuReview | null;
  receiptId: number | null;
  error: string | null;
}

const REVIEW_MAX_TOKENS = 3000;

/** 单条复核（付费链：modelFor("zhipuDigestReview") + chatJson，永不抛错）。 */
export async function reviewUpdate(row: Pick<ZhipuUpdateRow, "id" | "kind" | "title" | "payload" | "digest">): Promise<ReviewOutcome> {
  try {
    const model = await modelFor("zhipuDigestReview");
    const user = `信源：智谱开放平台文档站 ·「${String(row.payload.sourceLabel ?? "")}」（kind=${row.kind}）\n` +
      `条目：${row.title}\n\n原始材料（唯一事实来源）：\n${String(row.payload.text ?? "")}\n\n` +
      `待复核的解读：\n${JSON.stringify(row.digest, null, 1)}`;
    const res = await chatJson({
      model,
      purpose: "zhipu_digest_review",
      subject: `zhipuwatch#${row.id}`,
      promptVersion: ZHIPU_REVIEW_PROMPT_VERSION,
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
}

export interface ReviewOptions {
  /** 注入单条复核（测试）；缺省走 chatJson 付费链。 */
  reviewOne?: (row: ZhipuUpdateRow) => ReviewOutcome | Promise<ReviewOutcome>;
  now?: Date;
}

/** 复核轮主循环（cron zhipu.review 调用；后台页可手动触发）。失败不打断本轮。 */
export async function reviewDueDigests(opts: ReviewOptions = {}): Promise<ReviewSummary> {
  const reviewOne = opts.reviewOne ?? reviewUpdate;
  const summary: ReviewSummary = {
    at: (opts.now ?? new Date()).toISOString(), ok: true, error: null,
    reviewed: 0, passed: 0, issues: 0, failed: 0,
  };
  for (const row of await listDoneUnreviewed()) {
    const out = await reviewOne(row);
    if (!out.ok || !out.review) {
      summary.failed++;
      continue; // 不写回：行保持未复核，下轮再试
    }
    await saveReview(row.id, out.review.verdict === "passed" ? "passed" : "issues", { ...out.review }, out.receiptId);
    summary.reviewed++;
    if (out.review.verdict === "passed") summary.passed++;
    else summary.issues++;
  }
  return summary;
}
