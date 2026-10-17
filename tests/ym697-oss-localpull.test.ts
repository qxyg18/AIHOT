// ym697：oss.watch「只拉新」钩子单测（注入 git 执行器；不打真网络、不动真 clone、不写库）。
// 与 tests/setup.ts 无耦合：本文件不 import setup（纯内存单测），可用
//   node --test tests/ym697-oss-localpull.test.ts
// 直接运行（与 rador 其余不变量测试共享 runner 时同样通过）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { localCloneFor, pullLocalClone, pullLocalClones, type GitRunResult } from "../packages/backend/src/osswatch/localpull.ts";

type Run = (clone: string, args: string[], timeoutMs: number) => Promise<GitRunResult>;

const ok = (stdout: string): GitRunResult => ({ rc: 0, stdout, stderr: "" });
const bad = (stderr: string, rc = 1): GitRunResult => ({ rc, stdout: "", stderr });

const SYMREF = "ref: refs/heads/main\nabc123abc123abc123abc123abc123abc123abc1\tHEAD";

function runner(map: Record<string, GitRunResult>): Run {
  return async (_clone, args) => {
    const key = args[0] === "ls-remote" ? "ls-remote" : args.slice(0, 2).join(" ");
    return map[key] ?? bad("unexpected git call: " + args.join(" "));
  };
}

test("localpull: 未登记 slug 不触发（null）", async () => {
  assert.equal(localCloneFor("no-such-project"), null);
  assert.equal(await pullLocalClone("no-such-project", { exists: () => true }), null);
});

test("localpull: clone 目录不存在 → clone_unreachable 指针（不抛）", async () => {
  const out = await pullLocalClone("zcode", { exists: () => false });
  assert.equal(out?.ok, false);
  assert.equal(out?.action, "clone_unreachable");
  assert.equal(out?.clone, "D:/Zcode/upstream/ZCode");
});

test("localpull: 非 git 仓库 → not_a_git_repo 指针", async () => {
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: runner({ "rev-parse --git-dir": bad("fatal: not a git repository") }),
  });
  assert.equal(out?.action, "not_a_git_repo");
});

test("localpull: 远端已最新 → up_to_date（不 fetch/不 merge）", async () => {
  const sha = "abc123abc123abc123abc123abc123abc123abc1";
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: runner({ "rev-parse --git-dir": ok(".git"), "rev-parse HEAD": ok(sha), "ls-remote": ok(SYMREF) }),
  });
  assert.equal(out?.ok, true);
  assert.equal(out?.action, "up_to_date");
});

test("localpull: 工作区脏 → skipped_dirty 指针（零改动）", async () => {
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: runner({
      "rev-parse --git-dir": ok(".git"), "rev-parse HEAD": ok("old123"),
      "ls-remote": ok(SYMREF), "status --porcelain": ok(" M src/app.ts"),
    }),
  });
  assert.equal(out?.ok, false);
  assert.equal(out?.action, "skipped_dirty");
});

test("localpull: fetch 失败 → fetch_failed 指针", async () => {
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: runner({
      "rev-parse --git-dir": ok(".git"), "rev-parse HEAD": ok("old123"),
      "ls-remote": ok(SYMREF), "status --porcelain": ok(""),
      "fetch origin": bad("fatal: unable to access"),
    }),
  });
  assert.equal(out?.action, "fetch_failed");
});

test("localpull: 非快进（分叉） → not_fast_forward 指针", async () => {
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: runner({
      "rev-parse --git-dir": ok(".git"), "rev-parse HEAD": ok("old123"),
      "ls-remote": ok(SYMREF), "status --porcelain": ok(""),
      "fetch origin": ok(""), "merge --ff-only": bad("fatal: Not possible to fast-forward"),
    }),
  });
  assert.equal(out?.action, "not_fast_forward");
  assert.equal(out?.headAfter, null);
});

test("localpull: 正路 → fetch + --ff-only 合并，head 推进（只拉新）", async () => {
  const calls: string[][] = [];
  const out = await pullLocalClone("zcode", {
    exists: () => true,
    run: async (_clone, args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return calls.length < 6 ? ok("old123") : ok("new456");
      if (args[0] === "ls-remote") return ok(SYMREF);
      if (args[0] === "status") return ok("");
      if (args[0] === "fetch") return ok("");
      if (args[0] === "merge") return ok("Fast-forward");
      return bad("unexpected");
    },
  });
  assert.equal(out?.ok, true);
  assert.equal(out?.action, "pulled");
  assert.equal(out?.headBefore, "old123");
  assert.equal(out?.headAfter, "new456");
  assert.ok(calls.some((c) => c[0] === "merge" && c[1] === "--ff-only"));
});

test("localpull: 批量跳过未登记 slug，逐仓返回", async () => {
  const out = await pullLocalClones(["nope", "zcode"], { exists: () => false });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.slug, "zcode");
});
