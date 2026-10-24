// 开源项目跟踪：仓库地址解析、commit 折叠降噪（纯函数），加上注入拉取与解读的完整扫描链
// 差分三态（空库首轮全量 / 同窗重跑零出刊 / 构造新 release 出一刊）与解读失败标 pending
// 下轮补。全程零网络：GitHub 三面与模型解读都从注入进来。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { foldCommits, parseRepo, type GhCommit, type GhRelease, type GhTag } from "@aihot/backend/osswatch/github";
import { scanOssWatch, type DigestOutcome } from "@aihot/backend/osswatch/scan";
import { getLessons, lessonsBlock, reviewDueDigests, type LessonEntry, type ReviewOutcome } from "@aihot/backend/osswatch/review";
import { getWatermarks, insertProject, insertUpdate, listUpdates, saveDigest, type OssProjectRow } from "@aihot/backend/osswatch/store";

const T = tag();
const SLUG = `t-${T}`;
const REPO = `https://github.com/test-org/${T}`;

// ---- 纯函数 ----

test("parseRepo: 只认 github.com 仓库地址，容忍 .git 与尾部路径", () => {
  assert.deepEqual(parseRepo("https://github.com/zai-org/ZCode"), { owner: "zai-org", repo: "ZCode" });
  assert.deepEqual(parseRepo("https://github.com/zai-org/ZCode.git"), { owner: "zai-org", repo: "ZCode" });
  assert.deepEqual(parseRepo("https://github.com/zai-org/ZCode/releases"), { owner: "zai-org", repo: "ZCode" });
  assert.equal(parseRepo("https://gitlab.com/a/b"), null);
  assert.equal(parseRepo("https://github.com/only-org"), null);
});

test("foldCommits: chore/ci 类折叠计数，feat/fix 保留，上限截断计数 omitted", () => {
  const c = (sha: string, message: string): GhCommit => ({
    sha, html_url: "", commit: { message, author: { date: "2026-10-03T00:00:00Z" }, committer: { date: "2026-10-03T00:00:00Z" } },
  });
  const out = foldCommits([c("a", "feat: 新能力"), c("b", "chore: bump deps"), c("c", "ci: fix workflow"), c("d", "fix: 崩溃修复"), c("e", "Merge pull request #1")]);
  assert.deepEqual(out.keep.map((k) => k.sha), ["a", "d"]);
  assert.equal(out.folded, 3);
  assert.equal(out.total, 5);
  const many = Array.from({ length: 45 }, (_, i) => c(`s${i}`, "feat: 批量"));
  const capped = foldCommits(many, 40);
  assert.equal(capped.keep.length, 40);
  assert.equal(capped.omitted, 5);
});

// ---- 扫描链（注入拉取与解读） ----

const release = (id: number, tagName: string, daysAgo: number): GhRelease => ({
  id, tag_name: tagName, name: tagName, prerelease: false,
  published_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  html_url: `${REPO}/releases/tag/${tagName}`, body: `Release ${tagName}`,
});
const commit = (sha: string, message: string, hoursAgo: number): GhCommit => ({
  sha, html_url: `${REPO}/commit/${sha}`,
  commit: { message, author: { date: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() }, committer: { date: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } },
});

// 可变的远端状态：测试里改造它构造增量。
const remote = {
  defaultBranch: "main",
  releases: [release(1001, "v1.1.0", 2), release(1000, "v1.0.0", 40)],
  tags: [{ name: "v1.1.0", commit: { sha: "a1" } }, { name: "v1.0.0", commit: { sha: "a0" } }] as GhTag[],
  commits: [commit("sha-new", "feat: 新增导出面板", 12), commit("sha-old", "fix: 修复列表翻页", 36)],
};

const fetchJson = async (url: string): Promise<unknown> => {
  const u = new URL(url);
  assert.equal(u.pathname.split("/")[2]!, "test-org");
  if (u.pathname === `/repos/test-org/${T}`) return { default_branch: remote.defaultBranch };
  if (u.pathname === `/repos/test-org/${T}/releases`) return remote.releases;
  if (u.pathname === `/repos/test-org/${T}/tags`) return remote.tags;
  if (u.pathname === `/repos/test-org/${T}/commits`) return remote.commits;
  throw new Error(`unexpected GitHub path ${u.pathname}`);
};

const okDigest = (row: { id: number }): DigestOutcome => ({
  ok: true,
  digest: { overview: `第 ${row.id} 期概览`, items: [{ title: "条目", plain: "说明" }], adopt: [], caution: [], confidence: 0.9 },
  receiptId: 900_000 + row.id,
  error: null,
});

const project = async (): Promise<OssProjectRow> => {
  const rows = await sql<OssProjectRow[]>`SELECT * FROM oss_projects WHERE slug = ${SLUG}`;
  return rows[0]!;
};

const rowCount = async (): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oss_updates WHERE project_slug = ${SLUG}`;
  return r!.n;
};

before(async () => {
  await insertProject({ slug: SLUG, name: "测试项目", repo_url: REPO, vendor: "test" });
});

after(async () => {
  await sql`DELETE FROM oss_projects WHERE slug = ${SLUG}`;
  await sql`DELETE FROM settings WHERE key IN ('osswatch.watermarks', 'osswatch.lastrun', 'osswatch.lessons')`;
  await closeDb();
});

test("空库首轮全量：基线出刊（近 30 天 release + commit 批次），水位落库，解读直接写回", async () => {
  const s = await scanOssWatch({ fetchJson, digestOne: okDigest });
  assert.equal(s.ok, true);
  assert.equal(s.updates, 2, "v1.1.0（2 天前）进基线，v1.0.0（40 天前）不追；两笔 commit 出一批");
  const rows = await listUpdates(100, SLUG);
  const kinds = rows.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["commit_batch", "release"]);
  const rel = rows.find((r) => r.kind === "release")!;
  assert.equal(rel.payload.tag, "v1.1.0");
  assert.equal(rel.digest_status, "done");
  assert.equal(rel.receipt_id, 900_000 + rel.id);
  const marks = await getWatermarks();
  assert.equal(marks[SLUG]!.releaseId, 1001);
  assert.equal(marks[SLUG]!.lastCommitSha, "sha-new");
  assert.deepEqual([...marks[SLUG]!.tags].sort(), ["v1.0.0", "v1.1.0"]);
  assert.ok(marks[SLUG]!.baselineAt);
});

test("同窗重跑零出刊：水位幂等，不重复出刊不重复解读", async () => {
  const before = await rowCount();
  const s = await scanOssWatch({ fetchJson, digestOne: okDigest });
  assert.equal(s.ok, true);
  assert.equal(s.updates, 0);
  assert.equal(await rowCount(), before);
});

test("构造新 release 出一刊：tag 随 release 合并不单独出刊", async () => {
  remote.releases.unshift(release(1002, "v1.2.0", 0));
  remote.tags.unshift({ name: "v1.2.0", commit: { sha: "a2" } });
  const s = await scanOssWatch({ fetchJson, digestOne: okDigest });
  assert.equal(s.updates, 1);
  const rows = await listUpdates(100, SLUG);
  assert.equal(rows[0]!.kind, "release");
  assert.equal(rows[0]!.payload.tag, "v1.2.0");
});

test("解读失败只标 pending 不阻塞采集，下一轮补解读且不再出刊", async () => {
  remote.commits.unshift(commit("sha-newer", "feat: 又一个功能", 2));
  const s = await scanOssWatch({ fetchJson, digestOne: async () => ({ ok: false, digest: null, receiptId: null, error: "模型熔断" }) });
  assert.equal(s.updates, 1);
  assert.equal(s.pending, 1);
  const pending = (await listUpdates(100, SLUG)).find((r) => r.digest_status === "pending")!;
  assert.ok(pending, "有 pending 行");
  const before = await rowCount();
  const retry = await scanOssWatch({ fetchJson, digestOne: okDigest });
  assert.equal(retry.updates, 0, "水位未动，不出新刊");
  assert.equal(retry.digested, 1, "pending 被补解读");
  assert.equal(await rowCount(), before);
  assert.equal((await listUpdates(100, SLUG)).find((r) => r.digest_status === "pending"), undefined);
});

// ---- 复核轮（ym195：白天免费先写，优惠窗复核教训沉淀） ----

test("lessonsBlock: 空教训返回空串，有教训逐行注入", () => {
  assert.equal(lessonsBlock([]), "");
  const lessons: LessonEntry[] = [
    { date: "2026-10-03", lesson: "材料未提破坏性变更时禁止断言无破坏性变更" },
    { date: "2026-10-02", lesson: "数字必须来自材料本体" },
  ];
  const block = lessonsBlock(lessons);
  assert.ok(block.startsWith("历史教训"), "块头");
  assert.ok(block.includes("禁止断言") && block.includes("材料本体"), "逐条在列");
});

test("复核轮：done 未复核行全被审，结果写回+教训沉淀；再跑幂等不再审", async () => {
  const dueBefore = (await listUpdates(200, SLUG)).filter((r) => r.digest_status === "done" && !r.review_status).length;
  assert.ok(dueBefore >= 1, "有未复核行");
  const review: ReviewOutcome = {
    ok: true,
    review: { verdict: "issues", issues: ["解读断言「无破坏性变更」但材料未提及"], lessons: ["材料未提及破坏性变更时禁止断言无破坏性变更"], confidence: 0.9 },
    receiptId: 950_001,
    error: null,
  };
  const s = await reviewDueDigests({ reviewOne: async () => review });
  assert.equal(s.reviewed, dueBefore);
  assert.equal(s.issues, dueBefore);
  assert.equal(s.lessonsAdded, 1, "教训去重后只进一条");
  const after = (await listUpdates(200, SLUG)).filter((r) => r.digest_status === "done");
  assert.ok(after.length >= dueBefore);
  assert.equal(after.filter((r) => !r.review_status).length, 0, "全行有复核态");
  assert.ok(after.every((r) => r.review!.verdict === "issues"));
  assert.ok((await getLessons()).some((l) => l.lesson.includes("禁止断言")), "教训已沉淀");
  // 幂等：再跑不再审（无未复核行）
  const again = await reviewDueDigests({ reviewOne: async () => review });
  assert.equal(again.reviewed, 0);
});

test("复核轮：新建 passed 样本单独审，写 passed 且空教训不入池", async () => {
  const fresh = await insertUpdate(SLUG, "release", { tag: "v9.9.9-review-pass" });
  await saveDigest(fresh.id, { overview: "概览", items: [{ title: "条目", plain: "说明" }], adopt: [], caution: [], confidence: 0.9 }, 123);
  const s = await reviewDueDigests({
    reviewOne: async () => ({ ok: true, review: { verdict: "passed", issues: [], lessons: [], confidence: 0.85 }, receiptId: 950_002, error: null }),
  });
  assert.equal(s.reviewed, 1);
  assert.equal(s.passed, 1);
  const after = (await listUpdates(200, SLUG)).find((r) => r.id === fresh.id)!;
  assert.equal(after.review_status, "passed");
});

test("复核失败：行保持未复核（review_status 不动），错误进 summary 下轮再试", async () => {
  const fresh = await insertUpdate(SLUG, "tag", { tags: ["v9.9.8-review-fail"] });
  await saveDigest(fresh.id, { overview: "概览", items: [{ title: "条目", plain: "说明" }], adopt: [], caution: [], confidence: 0.9 }, 124);
  const s = await reviewDueDigests({
    reviewOne: async () => ({ ok: false, review: null, receiptId: null, error: "复核模型熔断" }),
  });
  assert.equal(s.reviewed, 0);
  assert.equal(s.failed, 1);
  const after = (await listUpdates(200, SLUG)).find((r) => r.id === fresh.id)!;
  assert.equal(after.review_status, null, "保持未复核，下轮再试");
});
