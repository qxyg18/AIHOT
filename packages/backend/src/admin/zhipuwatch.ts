// Admin「智谱关注·智谱发布」：总览、手动扫描、手动复核。写操作 audit() 落 audit_log
// （扫描/复核都动共享状态；解读与复核走模型链，成本在后台「运行」页按 purpose=zhipu_digest /
// zhipu_digest_review 可查）。
import { audit } from "./auth.ts";
import { scanZhipuWatch, type ScanSummary } from "../zhipuwatch/scan.ts";
import { reviewDueDigests, type ReviewSummary } from "../zhipuwatch/review.ts";
import { getZhipuPool } from "../zhipuwatch/pool.ts";
import { getPlanWindowRule } from "../lib/windows.ts";
import { getLastRun, listUpdates } from "../zhipuwatch/store.ts";

export async function zhipuWatchOverview() {
  // ym438：pool（免费池清单）与 planWindow（套餐窗规则）随总览露出——联动状态后台可查，
  // 与 routing_action 行级留痕互补。
  const [lastRun, updates, pool, planWindow] = await Promise.all([getLastRun(), listUpdates(60), getZhipuPool(), getPlanWindowRule()]);
  return {
    lastRun,
    updates,
    pool,
    planWindow,
    counts: {
      pending: updates.filter((u) => u.digest_status === "pending").length,
      unreviewed: updates.filter((u) => u.digest_status === "done" && !u.review_status).length,
    },
  };
}

/** 手动「立即扫描」：与清晨轮同一链路（水位幂等，同窗重跑零重复出刊）。 */
export async function runZhipuScan(actor: string): Promise<ScanSummary> {
  const summary = await scanZhipuWatch();
  await audit(actor, "zhipuwatch.scan", "zhipuwatch", null, null, {
    sources: summary.sources, updates: summary.updates, digested: summary.digested,
    pending: summary.pending, errors: summary.errors, notes: summary.notes,
  });
  return summary;
}

/** 手动「立即复核」：与复核轮同一链路（只审 done 未复核行）。 */
export async function runZhipuReview(actor: string): Promise<ReviewSummary> {
  const summary = await reviewDueDigests();
  await audit(actor, "zhipuwatch.review", "zhipuwatch", null, null, {
    reviewed: summary.reviewed, passed: summary.passed, issues: summary.issues, failed: summary.failed,
  });
  return summary;
}
