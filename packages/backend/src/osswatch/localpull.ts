// 本地认知源仓「只拉新」钩子（ym697 雷达触发线·松耦合乙案）。
//
// 定位：oss.watch 检出上游新 commit 后，若运行宿主存在该仓的本地 clone，则**只做
// fetch + fast-forward-only 合并**——不判定内容影响、不写认知库、不发通知（拉新不判定）；
// 影响面核验/事件登记归 agent-hub 侧（读时护鲜或 source_pull 的 stale_scan）。
//
// 失败模式（卡面约束）：任何失败（路径不存在/非 git 仓库/工作区脏/非快进/网络不可达/
// 无 git 二进制）只产出指针 {ok:false, action, clone, headBefore, reason}，**绝不抛出**。
//
// 宿主说明（现势）：认知源仓 clone 在站长本机（D:/Zcode/upstream/ZCode）；雷达现态部署
// 在云端（C1-09 试运行），云端 worker 看不到该路径 → 本钩子返回 clone_unreachable 指针
// （云端→本机无反向通道，实测 ssh 隧道为 LocalForward 单向）。本机侧由 agent-hub 的
// scripts/code-cognition/source_pull.py 承载同一「只拉新」动作（同语义、同失败模式）。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** slug → 本机 clone 路径（env `OSS_LOCAL_CLONE_<SLUG>` 可覆盖，便于换机/演练）。 */
const LOCAL_CLONES: Record<string, string> = {
  zcode: "D:/Zcode/upstream/ZCode",
};

export function localCloneFor(slug: string): string | null {
  const env = process.env[`OSS_LOCAL_CLONE_${slug.toUpperCase()}`];
  if (env) return env;
  return LOCAL_CLONES[slug] ?? null;
}

export interface LocalPullOutcome {
  slug: string;
  clone: string;
  ok: boolean;
  /** pulled | up_to_date | clone_unreachable | not_a_git_repo | remote_unreachable
   *  | remote_head_unknown | skipped_dirty | fetch_failed | not_fast_forward */
  action: string;
  headBefore: string | null;
  headAfter: string | null;
  remoteHead: string | null;
  reason: string | null;
}

export interface GitRunResult {
  rc: number;
  stdout: string;
  stderr: string;
}

export interface LocalPullDeps {
  /** 注入 git 执行器（测试/演练用）；缺省=真实 execFile("git", ["-C", clone, ...])。 */
  run?: (clone: string, args: string[], timeoutMs: number) => Promise<GitRunResult>;
  /** 目录存在性检查（测试注入）。 */
  exists?: (p: string) => boolean;
}

const FETCH_TIMEOUT_MS = 300_000;
const MERGE_TIMEOUT_MS = 600_000;

async function runGit(clone: string, args: string[], timeoutMs: number): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", clone, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { rc: 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const rc = typeof e.code === "number" ? e.code : 1;
    return {
      rc,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/** 只拉新单仓；永不抛（失败=指针）。 */
export async function pullLocalClone(
  slug: string,
  deps: LocalPullDeps = {},
): Promise<LocalPullOutcome | null> {
  const clone = localCloneFor(slug);
  if (!clone) return null;
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runGit;
  const out: LocalPullOutcome = {
    slug,
    clone,
    ok: false,
    action: "clone_unreachable",
    headBefore: null,
    headAfter: null,
    remoteHead: null,
    reason: null,
  };
  if (!exists(clone)) {
    out.reason = "clone 目录不存在（本宿主无该仓 clone；指针）";
    return out;
  }
  const gitDir = await run(clone, ["rev-parse", "--git-dir"], 60_000);
  if (gitDir.rc !== 0) {
    out.action = "not_a_git_repo";
    out.reason = (gitDir.stderr || "非 git 仓库").slice(0, 200);
    return out;
  }
  const head = await run(clone, ["rev-parse", "HEAD"], 60_000);
  out.headBefore = head.rc === 0 && head.stdout ? head.stdout : null;
  const symref = await run(clone, ["ls-remote", "--symref", "origin", "HEAD"], FETCH_TIMEOUT_MS);
  if (symref.rc !== 0) {
    out.action = "remote_unreachable";
    out.reason = (symref.stderr || "ls-remote 失败").slice(0, 200);
    return out;
  }
  let branch: string | null = null;
  for (const line of symref.stdout.split("\n")) {
    if (line.startsWith("ref:")) branch = line.split(/\s+/)[1]?.replace("refs/heads/", "") ?? null;
    else if (line.endsWith("HEAD")) out.remoteHead = line.split(/\s+/)[0] ?? null;
  }
  if (!out.remoteHead) {
    out.action = "remote_head_unknown";
    out.reason = "ls-remote 未返回 HEAD";
    return out;
  }
  if (out.headBefore && out.headBefore === out.remoteHead) {
    out.ok = true;
    out.action = "up_to_date";
    out.reason = "本地已是最新（无需拉新）";
    return out;
  }
  const dirty = await run(clone, ["status", "--porcelain"], 60_000);
  if (dirty.rc !== 0) {
    out.action = "fetch_failed";
    out.reason = "git status 失败";
    return out;
  }
  if (dirty.stdout) {
    out.action = "skipped_dirty";
    out.reason = "工作区非干净（不冒险拉取；指针供人工处置）";
    return out;
  }
  const fetched = await run(clone, ["fetch", "origin", branch ?? "HEAD"], FETCH_TIMEOUT_MS);
  if (fetched.rc !== 0) {
    out.action = "fetch_failed";
    out.reason = (fetched.stderr || "fetch 失败").slice(0, 200);
    return out;
  }
  const merged = await run(clone, ["merge", "--ff-only", "FETCH_HEAD"], MERGE_TIMEOUT_MS);
  if (merged.rc !== 0) {
    out.action = "not_fast_forward";
    out.reason = ("非快进（分叉）——零改动保留现场：" + (merged.stderr || merged.stdout)).slice(0, 200);
    return out;
  }
  const newHead = await run(clone, ["rev-parse", "HEAD"], 60_000);
  out.ok = true;
  out.action = "pulled";
  out.headAfter = newHead.rc === 0 && newHead.stdout ? newHead.stdout : null;
  return out;
}

/** 批量只拉新（并发无关：逐仓 await，单仓失败不影响其他仓）。 */
export async function pullLocalClones(
  slugs: string[],
  deps: LocalPullDeps = {},
): Promise<LocalPullOutcome[]> {
  const results: LocalPullOutcome[] = [];
  for (const slug of slugs) {
    const r = await pullLocalClone(slug, deps);
    if (r) results.push(r);
  }
  return results;
}
