// GitHub 公开 API 的读取面（仓库元信息 / releases / tags / 默认分支 commits）。匿名限额
// 60 req/h，日扫一轮每项目 4 个请求，余量充足；User-Agent 是 GitHub API 的硬要求。
export const GH_API = "https://api.github.com";

export interface GhRepoMeta {
  default_branch: string;
}

export interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  body: string | null;
}

export interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { date: string | null }; committer: { date: string | null } };
}

export interface GhTag {
  name: string;
  commit: { sha: string };
}

/** 只认 github.com 仓库地址，容忍 .git 后缀与尾部路径；解析不出返回 null。 */
export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(repoUrl);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** 匿名 GET 一个 GitHub API 路径。测试经 ScanOptions.fetchJson 注入，生产走这里。 */
export async function ghFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "aihot-oss-watch (private admin module)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${url.replace(GH_API, "")}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** commit 折叠降噪（命主口径：chore/CI 类只计数不出刊）。工具性提交与合并提交折叠；
 *  保留条数超上限时截断，截掉的计入 omitted（payload 里仍见全量口径）。 */
export function foldCommits(commits: GhCommit[], keepCap = 40): { keep: GhCommit[]; folded: number; omitted: number; total: number } {
  const keep: GhCommit[] = [];
  let folded = 0;
  for (const c of commits) {
    const title = (c.commit.message ?? "").split("\n")[0] ?? "";
    if (!title.trim() || /^(chore|ci|build|style|test|docs)\b|^merge (pull request|branch)\b/i.test(title)) {
      folded++;
      continue;
    }
    if (keep.length < keepCap) keep.push(c);
  }
  const total = commits.length;
  return { keep, folded, omitted: total - folded - keep.length, total };
}
