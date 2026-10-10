// 开源项目跟踪主循环（日扫一轮，worker 的 oss.watch 调度；后台页面可手动触发）：
//   登记项目 → 拉 GitHub 三面（仓库元信息 / releases / tags / 默认分支 commits）→ 水位差分 →
//   出刊（一条 release / 一批 tag / 一批 commit）→ 逐条 chatJson 大白话解读（含对本站
//   施工的适配提示）→ 写回 digest。口径（命主 2026-10-03）：
//   - 日扫 + 有料才出刊：无变更零模型成本；chore/CI 类 commit 折叠计数不出刊；
//   - 水位幂等：同窗重跑零重复出刊；首轮全量只做基线（近 30 天），不追全部历史；
//   - LLM 失败只标 pending 下轮补，不阻塞采集；付费链唯一入口 chatJson（receipts/budgets）。
import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { GH_API, foldCommits, ghFetchJson, parseRepo, type GhCommit, type GhRelease, type GhTag } from "./github.ts";
import { getLessons, lessonsBlock } from "./review.ts";
import {
  getWatermarks, insertUpdate, listPendingUpdates, listProjects, saveDigest, saveDigestError,
  saveLastRun, saveWatermarks, type OssProjectRow, type OssUpdateRow,
} from "./store.ts";

export const OSS_WATCH_PROMPT_VERSION = promptVersion("oss-watch");

const SYSTEM = promptText("oss-watch");

const DigestItem = z.object({ title: z.string().min(1), plain: z.string().min(1) });
export const OssDigestSchema = z.object({
  overview: z.string().min(1),
  items: z.array(DigestItem).min(1),
  adopt: z.array(z.string()),
  caution: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type OssDigest = z.infer<typeof OssDigestSchema>;

export interface DigestOutcome {
  ok: boolean;
  digest: OssDigest | null;
  receiptId: number | null;
  error: string | null;
}

const DIGEST_MAX_TOKENS = 3000;
const BASELINE_DAYS = 30;
const BASELINE_RELEASE_CAP = 3;
const BASELINE_COMMIT_CAP = 60;
const COMMITS_PER_PAGE = 50;
const DAY_MS = 86_400_000;

/** 消费方背景（user 消息里带给模型）：解读的「适配提示」面面向谁。按 slug 登记，未登记给通用语。 */
const CONSUMER_CONTEXT: Record<string, string> = {
  zcode: "本站内容系统与 agent 协作 HUB 的施工都围绕 ZCode 生态展开，本机在用其桌面端 3.x；适配提示请面向「是否要跟进新版本、对现有施工有什么影响」。",
};
const DEFAULT_CONSUMER = "暂无特定联动背景，面向站长本人的技术决策解读。";

const withinDays = (iso: string | null, now: Date, days: number): boolean => !!iso && now.getTime() - Date.parse(iso) <= days * DAY_MS;

export interface ScanOptions {
  /** 注入 GitHub 拉取（测试/演练）；入参是完整 URL。 */
  fetchJson?: (url: string) => Promise<unknown>;
  /** 注入单条解读（测试）；缺省走 chatJson 付费链。 */
  digestOne?: (row: Pick<OssUpdateRow, "id" | "kind" | "payload">, project: OssProjectRow) => DigestOutcome | Promise<DigestOutcome>;
  now?: Date;
}

export interface ScanSummary {
  at: string;
  ok: boolean;
  error: string | null;
  projects: number;
  updates: number;
  digested: number;
  pending: number;
  errors: string[];
}

/** 一次采集的全部材料（三面 + 默认分支名）。 */
interface Collected {
  defaultBranch: string;
  releases: GhRelease[];
  tags: GhTag[];
  commits: GhCommit[];
}

async function collectProject(repo: { owner: string; repo: string }, fetchJson: (url: string) => Promise<unknown>): Promise<Collected> {
  const base = `${GH_API}/repos/${repo.owner}/${repo.repo}`;
  const meta = (await fetchJson(base)) as { default_branch?: string };
  const [releases, tags, commits] = await Promise.all([
    fetchJson(`${base}/releases?per_page=20`) as Promise<GhRelease[]>,
    fetchJson(`${base}/tags?per_page=100`) as Promise<GhTag[]>,
    fetchJson(`${base}/commits?sha=${encodeURIComponent(meta.default_branch ?? "main")}&per_page=${COMMITS_PER_PAGE}`) as Promise<GhCommit[]>,
  ]);
  return { defaultBranch: meta.default_branch ?? "main", releases, tags, commits };
}

/** 增量 commit：从最新往回走到已知水位；水位 sha 不在页内（单轮增量超 50 条）退回按时间过滤。 */
function newCommitsSince(commits: GhCommit[], wm: { lastCommitSha: string | null; lastCommitAt: string | null }): GhCommit[] {
  if (!wm.lastCommitSha) return commits;
  const idx = commits.findIndex((c) => c.sha === wm.lastCommitSha);
  if (idx > 0) return commits.slice(0, idx);
  if (idx === 0) return [];
  if (wm.lastCommitAt) return commits.filter((c) => (c.commit.author.date ?? "") > wm.lastCommitAt!);
  return commits;
}

/** 本期 commit 批次的 payload：保留条目（标题首行）+ 折叠/截断计数。 */
function commitBatchPayload(keep: GhCommit[], folded: number, omitted: number, total: number, window: string): Record<string, unknown> {
  return {
    window,
    total,
    folded,
    omitted,
    commits: keep.map((c) => ({
      sha: c.sha.slice(0, 10),
      date: c.commit.author.date,
      title: (c.commit.message ?? "").split("\n")[0]!.slice(0, 120),
      url: c.html_url,
    })),
  };
}

/** 单条出刊的大白话解读（付费链：modelFor + chatJson，永不抛错，失败由调用方标 pending）。 */
export async function digestUpdate(row: Pick<OssUpdateRow, "id" | "kind" | "payload">, project: OssProjectRow): Promise<DigestOutcome> {
  try {
    const model = await modelFor("ossDigest");
    // ym195 教训注入：复核轮沉淀的教训（免费模型的常见翻车点）带进上下文，循环改进输出。
    const lessons = lessonsBlock(await getLessons());
    const user = `项目：${project.name}（${project.repo_url}${project.vendor ? `，维护方 ${project.vendor}` : ""}）\n` +
      `消费方背景：${CONSUMER_CONTEXT[project.slug] ?? DEFAULT_CONSUMER}\n` +
      (lessons ? `${lessons}\n\n` : "") +
      `本期更新（kind=${row.kind}）：\n${JSON.stringify(row.payload, null, 1)}`;
    const res = await chatJson({
      model,
      purpose: "oss_digest",
      subject: `${project.slug}#${row.id}`,
      promptVersion: OSS_WATCH_PROMPT_VERSION,
      system: SYSTEM,
      user,
      schema: OssDigestSchema,
      temperature: 0.2,
      maxTokens: DIGEST_MAX_TOKENS,
    });
    return { ok: true, digest: res.data, receiptId: res.receiptId, error: null };
  } catch (error) {
    return { ok: false, digest: null, receiptId: null, error: String(error).slice(0, 300) };
  }
}

/** 单轮扫描。单项目失败不打断其他项目（错误进 summary.errors）；全部失败才向上抛由 job_runs 兜底。 */
export async function scanOssWatch(opts: ScanOptions = {}): Promise<ScanSummary> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();
  const fetchJson = opts.fetchJson ?? ghFetchJson;
  const digestOne = opts.digestOne ?? digestUpdate;
  const summary: ScanSummary = { at: startedAt, ok: false, error: null, projects: 0, updates: 0, digested: 0, pending: 0, errors: [] };

  const runDigest = async (row: OssUpdateRow, project: OssProjectRow): Promise<void> => {
    const out = await digestOne(row, project);
    if (out.ok && out.digest) {
      await saveDigest(row.id, out.digest, out.receiptId ?? 0);
      summary.digested++;
    } else {
      await saveDigestError(row.id, out.error ?? "digest failed");
      summary.pending++;
    }
  };

  try {
    const projects = await listProjects(true);
    summary.projects = projects.length;
    if (projects.length === 0) {
      summary.ok = true;
      await saveLastRun({ at: summary.at, ok: true, error: null, projects: 0, updates: 0, digested: 0, pending: 0 });
      return summary;
    }

    // 先补上一轮 pending 的解读（水位不动、不出新刊；项目可能已被停用，从全量名单找）。
    const pendingRows = await listPendingUpdates();
    if (pendingRows.length) {
      const known = new Map((await listProjects(false)).map((p) => [p.slug, p]));
      for (const row of pendingRows) {
        const project = known.get(row.project_slug);
        if (project) await runDigest(row, project);
      }
    }

    const marks = await getWatermarks();
    for (const project of projects) {
      try {
        const repo = parseRepo(project.repo_url);
        if (!repo) throw new Error(`仓库地址解析失败：${project.repo_url}`);
        const wm = marks[project.slug] ?? null;
        const baseline = !wm;
        const col = await collectProject(repo, fetchJson);

        // releases：基线取近 30 天（封顶 3 条），增量取 id 大于水位的全部。
        const seenReleaseId = wm?.releaseId ?? 0;
        const maxReleaseId = Math.max(seenReleaseId, ...col.releases.map((r) => r.id), 0);
        const newReleases = baseline
          ? col.releases.filter((r) => withinDays(r.published_at, now, BASELINE_DAYS)).slice(0, BASELINE_RELEASE_CAP)
          : col.releases.filter((r) => r.id > seenReleaseId);

        // tags：基线只记水位不出刊；增量排除本轮已随 release 出刊的同名 tag。
        const tagNames = col.tags.map((t) => t.name);
        const knownTags = new Set(wm?.tags ?? []);
        const releaseTagNames = new Set(newReleases.map((r) => r.tag_name));
        const newTags = baseline ? [] : tagNames.filter((n) => !knownTags.has(n) && !releaseTagNames.has(n));

        // commits：基线取近 30 天（封顶 60 条），增量从水位 sha 往回走。
        const newCommits = baseline
          ? col.commits.filter((c) => withinDays(c.commit.author.date, now, BASELINE_DAYS)).slice(0, BASELINE_COMMIT_CAP)
          : newCommitsSince(col.commits, { lastCommitSha: wm!.lastCommitSha, lastCommitAt: wm!.lastCommitAt });
        const fold = foldCommits(newCommits);

        const fresh: OssUpdateRow[] = [];
        for (const r of newReleases) {
          fresh.push(await insertUpdate(project.slug, "release", {
            tag: r.tag_name, name: r.name, prerelease: r.prerelease, publishedAt: r.published_at,
            url: r.html_url, notes: (r.body ?? "").slice(0, 800) || null,
          }));
        }
        if (newTags.length) fresh.push(await insertUpdate(project.slug, "tag", { tags: newTags, defaultBranch: col.defaultBranch }));
        if (fold.keep.length > 0) {
          fresh.push(await insertUpdate(project.slug, "commit_batch", commitBatchPayload(fold.keep, fold.folded, fold.omitted, fold.total, baseline ? "baseline" : "incremental")));
        }
        summary.updates += fresh.length;

        // 出刊行落库即推进水位（先于解读）：进程中断只留下 pending 行，下轮补读，绝不重出刊。
        const newest = col.commits[0];
        marks[project.slug] = {
          releaseId: maxReleaseId,
          lastCommitSha: newest?.sha ?? wm?.lastCommitSha ?? null,
          lastCommitAt: newest?.commit.author.date ?? wm?.lastCommitAt ?? null,
          tags: [...new Set([...(wm?.tags ?? []), ...tagNames])],
          baselineAt: baseline ? startedAt : wm!.baselineAt,
        };
        await saveWatermarks(marks);

        for (const row of fresh) await runDigest(row, project);
      } catch (error) {
        summary.errors.push(`${project.slug}: ${String(error).slice(0, 200)}`);
      }
    }

    if (summary.errors.length === projects.length) throw new Error(summary.errors[0]!);
    summary.ok = true;
    summary.error = summary.errors.length ? summary.errors[0]! : null;
    await saveLastRun({ at: summary.at, ok: true, error: summary.error, projects: summary.projects, updates: summary.updates, digested: summary.digested, pending: summary.pending });
    return summary;
  } catch (error) {
    summary.error = String(error).slice(0, 300);
    await saveLastRun({ at: summary.at, ok: false, error: summary.error, projects: summary.projects, updates: summary.updates, digested: summary.digested, pending: summary.pending }).catch(() => {});
    throw error;
  }
}
