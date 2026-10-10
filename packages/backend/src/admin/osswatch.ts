// Admin「开源项目跟踪」：总览、手动扫描、手动复核、登记新跟踪项目。写操作 audit() 落
// audit_log（登记/扫描/复核都动共享状态；解读与复核走付费链，成本在后台「运行」页按
// purpose=oss_digest / oss_digest_review 可查）。
import { audit } from "./auth.ts";
import { scanOssWatch, type ScanSummary } from "../osswatch/scan.ts";
import { reviewDueDigests, type ReviewSummary } from "../osswatch/review.ts";
import { parseRepo } from "../osswatch/github.ts";
import { getLastRun, insertProject, listProjects, listUpdates } from "../osswatch/store.ts";
import { getLessons } from "../osswatch/review.ts";

export async function ossWatchOverview() {
  const [lastRun, projects, updates, lessons] = await Promise.all([getLastRun(), listProjects(false), listUpdates(60), getLessons()]);
  return {
    lastRun,
    projects,
    updates,
    lessons,
    counts: {
      projects: projects.filter((p) => p.active).length,
      pending: updates.filter((u) => u.digest_status === "pending").length,
      unreviewed: updates.filter((u) => u.digest_status === "done" && !u.review_status).length,
    },
  };
}

/** 手动「立即扫描」：与白天轮同一链路（水位幂等，同窗重跑零重复出刊）。 */
export async function runOssScan(actor: string): Promise<ScanSummary> {
  const summary = await scanOssWatch();
  await audit(actor, "osswatch.scan", "osswatch", null, null, {
    projects: summary.projects, updates: summary.updates, digested: summary.digested, pending: summary.pending, errors: summary.errors,
  });
  return summary;
}

/** 手动「立即复核」：与优惠窗复核轮同一链路（只审 done 未复核行，教训滚动沉淀）。 */
export async function runOssReview(actor: string): Promise<ReviewSummary> {
  const summary = await reviewDueDigests();
  await audit(actor, "osswatch.review", "osswatch", null, null, {
    reviewed: summary.reviewed, passed: summary.passed, issues: summary.issues, failed: summary.failed, lessonsAdded: summary.lessonsAdded,
  });
  return summary;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** 登记新跟踪项目（slug 是表内主键，也是消费方背景与知识件的稳定键）。 */
export async function registerOssProject(
  input: { slug?: unknown; name?: unknown; repoUrl?: unknown; vendor?: unknown },
  actor: string,
): Promise<{ slug: string; name: string; repoUrl: string; vendor: string }> {
  const slug = String(input.slug ?? "").trim();
  const name = String(input.name ?? "").trim();
  const repoUrl = String(input.repoUrl ?? "").trim();
  const vendor = String(input.vendor ?? "").trim();
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("slug 需为小写字母/数字/连字符（2-41 位，字母开头）"), { statusCode: 400 });
  if (!name) throw Object.assign(new Error("项目名称必填"), { statusCode: 400 });
  if (!repoUrl.startsWith("https://github.com/") || !parseRepo(repoUrl)) {
    throw Object.assign(new Error("repoUrl 需为可解析的 github.com 仓库地址"), { statusCode: 400 });
  }
  const created = await insertProject({ slug, name, repo_url: repoUrl, vendor });
  if (!created) throw Object.assign(new Error(`slug 已存在：${slug}`), { statusCode: 400 });
  await audit(actor, "osswatch.register", `oss:${slug}`, null, null, { name, repoUrl, vendor });
  return { slug, name, repoUrl, vendor };
}
