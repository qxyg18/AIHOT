// T14/ym247 编辑联动检查器反例（G00 matrix gap ①，AC1/AC2）：
// AC1 只改榜算法缺规则/详情回归声明 → FAIL；完整闭包 → PASS。
// AC2 未知路径 / 政策hash错 / 漏消费者 / 越界dirty / 假证据 / 普通变更改影响图自放行 均不得通过。
// 另：真政策 docs/change-impact.json 的图完整性（无悬空边/无环/治理节点自持）直接断言。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const CHECKER = join(REPO, "scripts", "check-change-impact.ts");
const REAL_POLICY = join(REPO, "docs", "change-impact.json");
const SELF = "tests/check-change-impact.test.ts"; // 在盘证据路径（假证据反例用它做正例）
const tmp = mkdtempSync(join(tmpdir(), "cci-"));

/** 夹具影响图：L(榜算法,high) → R(规则页) → D(详情页)；U=无关低风险；G=治理(自放行保护面)。 */
const FIXTURE_POLICY = {
  schema: "tzr-impact/1",
  version: 1,
  policy: { unknown_path_risk: "high" },
  nodes: [
    { id: "L", owned_paths: ["apps/worker/src/leaderboard/"], consumer_edges: ["R", "D"], required_checks: ["node --test tests/lb.test.ts"], risk_floor: "high" },
    { id: "R", owned_paths: ["apps/web/app/routes/rules.tsx"], consumer_edges: ["D"], required_checks: [], risk_floor: "high" },
    { id: "D", owned_paths: ["apps/web/app/routes/detail.tsx"], consumer_edges: [], required_checks: [], risk_floor: "high" },
    { id: "U", owned_paths: ["unrelated/thing.ts"], consumer_edges: [], required_checks: [], risk_floor: "low" },
    { id: "G", owned_paths: ["docs/editing-manual.md", "docs/change-impact.json"], consumer_edges: [], required_checks: [], risk_floor: "high" },
  ],
};
const policyPath = join(tmp, "policy.json");
writeFileSync(policyPath, JSON.stringify(FIXTURE_POLICY));
const policySha = createHash("sha256").update(readFileSync(policyPath)).digest("hex");

interface Manifest {
  schema?: string; task_id?: string; kind?: string; risk?: string; release_id?: string; impact_policy_hash?: string;
  changed_hunks?: Array<{ path: string }>; roots?: string[];
  closure?: Array<{ node: string; disposition: string; evidence: string }>;
  checks_run?: Array<{ check: string; exit_code: number }>;
  external?: Array<{ path: string; owner?: string }>; external_policy?: string;
  independent_audit?: { path: string; sha256: string };
}
const base = (over: Manifest): Manifest => ({
  schema: "tzr-change/1",
  task_id: "fixture-task", kind: "change", risk: "high", release_id: "fixture-release",
  impact_policy_hash: policySha,
  changed_hunks: [{ path: "apps/worker/src/leaderboard/weighted.ts" }],
  roots: ["L"],
  closure: [
    { node: "L", disposition: "changed", evidence: "tests/lb-diff.patch → tests/check-change-impact.test.ts" },
    { node: "R", disposition: "checked", evidence: SELF },
    { node: "D", disposition: "checked", evidence: SELF },
  ],
  checks_run: [{ check: "node --test tests/lb.test.ts", exit_code: 0 }],
  ...over,
});

/** 跑检查器：changedPaths=--changed 列表文件；返回 {code, verdict}。 */
function run(manifest: Manifest, changedPaths: string[], extraPolicy?: string) {
  const mPath = join(tmp, `m-${Math.random().toString(36).slice(2)}.json`);
  const cPath = join(tmp, `c-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(mPath, JSON.stringify(manifest));
  writeFileSync(cPath, changedPaths.join("\n") + "\n");
  const r = spawnSync(process.execPath, [CHECKER, "--manifest", mPath, "--policy", extraPolicy ?? policyPath, "--changed", cPath], { encoding: "utf8" });
  let verdict: any = null;
  try {
    verdict = JSON.parse((r.stdout ?? "").split("\n")[0]);
  } catch {
    /* 检查器崩溃/用法错也算 FAIL 面 */
  }
  return { code: r.status, verdict, stderr: r.stderr ?? "" };
}

const LB = "apps/worker/src/leaderboard/weighted.ts";

test("AC1 完整闭包：榜算法变更声明规则/详情回归 → PASS", () => {
  const r = run(base({}), [LB]);
  assert.equal(r.code, 0, `应过却失败: ${r.stderr}`);
  assert.equal(r.verdict.verdict, "PASS");
});

test("AC1 只改榜算法缺规则/详情回归声明 → FAIL 且指名缺口", () => {
  const m = base({ closure: [{ node: "L", disposition: "changed", evidence: SELF }] });
  const r = run(m, [LB]);
  assert.notEqual(r.code, 0, "缺消费者必须不通过");
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E8") && e.includes("R")), `应指名漏 R：${JSON.stringify(r.verdict.errors)}`);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E8") && e.includes("D")), "应指名漏 D");
});

test("AC2 未知路径（不属任何 owned_paths）→ FAIL fail-closed", () => {
  const m = base({
    changed_hunks: [{ path: "mystery/new-thing.ts" }, { path: LB }],
    roots: ["L", "U"],
  });
  // mystery 路径须在闭包里兜处置或让 E7 报未申报——两种都判 FAIL；此处直接看 E6。
  const r = run(m, ["mystery/new-thing.ts", LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E6") && e.includes("mystery/new-thing.ts")));
});

test("AC2 政策版本 hash 错 → FAIL", () => {
  const r = run(base({ impact_policy_hash: "deadbeef" }), [LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E3")));
});

test("AC2 越界 dirty hunk（diff 有、manifest 未声明）→ FAIL", () => {
  const r = run(base({}), [LB, "apps/other/dirty.ts"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E5") && e.includes("apps/other/dirty.ts")));
});

test("AC2 假证据：evidence 为空 → FAIL", () => {
  const m = base({});
  m.closure![1] = { node: "R", disposition: "checked", evidence: "" };
  const r = run(m, [LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E8") && e.includes("假证据")));
});

test("AC2 假证据：checked 指向不存在文件 → FAIL", () => {
  const m = base({});
  m.closure![2] = { node: "D", disposition: "checked", evidence: "no/such/file.md" };
  const r = run(m, [LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E8") && e.includes("未指向在盘文件")));
});

test("AC2 自放行：普通变更 diff 触及影响图政策 → FAIL", () => {
  const m = base({ changed_hunks: [{ path: LB }, { path: "docs/change-impact.json" }], roots: ["L", "G"] });
  const r = run(m, [LB, "docs/change-impact.json"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E4") && e.includes("自放行")));
});

test("policy_install：带在盘独立审计件（hash 吻合）→ PASS；hash 不符 → FAIL", () => {
  const auditPath = join(tmp, "audit.md");
  writeFileSync(auditPath, "# independent audit fixture\nPASS\n");
  const auditSha = createHash("sha256").update(readFileSync(auditPath)).digest("hex");
  const m = base({
    kind: "policy_install",
    risk: "high",
    changed_hunks: [{ path: "docs/editing-manual.md" }],
    roots: ["G"],
    closure: [{ node: "G", disposition: "changed", evidence: SELF }],
    independent_audit: { path: auditPath, sha256: auditSha },
  });
  const ok = run(m, ["docs/editing-manual.md", "docs/change-impact.json"]);
  assert.equal(ok.code, 0, `policy_install 正例应过: ${JSON.stringify(ok.verdict?.errors)}`);
  const bad = run(base({ ...m, independent_audit: { path: auditPath, sha256: "0".repeat(64) } }), ["docs/editing-manual.md", "docs/change-impact.json"]);
  assert.notEqual(bad.code, 0);
  assert.ok(bad.verdict.errors.some((e: string) => e.startsWith("E4") && e.includes("independent_audit")));
});

test("AC2 风险档低于节点下限 → FAIL", () => {
  const m = base({ risk: "low" });
  const r = run(m, [LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E9")));
});

test("AC2 假 root（roots 含未被命中的节点）→ FAIL", () => {
  const m = base({ roots: ["L", "U"] });
  const r = run(m, [LB]);
  assert.notEqual(r.code, 0);
  assert.ok(r.verdict.errors.some((e: string) => e.startsWith("E7") && e.includes("U")));
});

test("E5b external 逃逸闸：缺 owner / 图外无旗标 → FAIL；带旗标+high → PASS 且计数披露", () => {
  // 缺 owner：external 条目必须归属他方，不得覆盖自己的改动
  const noOwner = base({ external: [{ path: "unrelated/thing.ts", owner: "" }] });
  const r1 = run(noOwner, [LB, "unrelated/thing.ts"]);
  assert.notEqual(r1.code, 0);
  assert.ok(r1.verdict.errors.some((e: string) => e.startsWith("E5b") && e.includes("owner")), JSON.stringify(r1.verdict.errors));
  // 图外路径 + 无 external_policy 旗标：未知待归属不得静默放行
  const noFlag = base({ external: [{ path: "mystery/inflight.ts", owner: "parallel-card-x" }] });
  const r2 = run(noFlag, [LB, "mystery/inflight.ts"]);
  assert.notEqual(r2.code, 0);
  assert.ok(r2.verdict.errors.some((e: string) => e.startsWith("E5b") && e.includes("图外路径未获放行")), JSON.stringify(r2.verdict.errors));
  // 图外路径 + 显式旗标 + risk=high：放行但强制计数披露
  const flagged = base({ external_policy: "allow_unattributed", external: [{ path: "mystery/inflight.ts", owner: "parallel-card-x" }] });
  const r3 = run(flagged, [LB, "mystery/inflight.ts"]);
  assert.equal(r3.code, 0, `带旗标正例应过: ${JSON.stringify(r3.verdict?.errors)}`);
  assert.equal(r3.verdict.stats.external_unattributed, 1, "图外在途必须计数披露");
  // 图内路径 external（归属节点明确）无需旗标
  const graphKnown = base({ external: [{ path: "unrelated/thing.ts", owner: "parallel-card-x" }] });
  const r4 = run(graphKnown, [LB, "unrelated/thing.ts"]);
  assert.equal(r4.code, 0, `图内外部件应过: ${JSON.stringify(r4.verdict?.errors)}`);
});

test("真政策图完整性：docs/change-impact.json 无悬空边/无环，治理节点自持政策面", () => {
  const policy = JSON.parse(readFileSync(REAL_POLICY, "utf8"));
  assert.equal(policy.schema, "tzr-impact/1");
  const ids = new Set(policy.nodes.map((n: any) => n.id));
  assert.ok(ids.size >= 16, `节点数应≥16，实得 ${ids.size}`);
  for (const n of policy.nodes) {
    for (const t of n.consumer_edges ?? []) assert.ok(ids.has(t), `悬空边 ${n.id}->${t}`);
  }
  const color = new Map<string, number>([...ids].map((id): [string, number] => [id as string, 0]));
  const visit = (id: string, stack: string[]) => {
    color.set(id, 1);
    for (const t of policy.nodes.find((n: any) => n.id === id)?.consumer_edges ?? []) {
      assert.ok(!(color.get(t) === 1 && stack.includes(t)), `环: ${[...stack, t].join("->")}`);
      if (color.get(t) === 0) visit(t, [...stack, t]);
    }
    color.set(id, 2);
  };
  for (const id of ids) if (color.get(id as string) === 0) visit(id as string, []);
  const gov = policy.nodes.find((n: any) => n.id === "governance.autonomy");
  assert.ok(gov, "缺治理节点");
  for (const p of ["AGENTS.md", "docs/editing-manual.md", "docs/change-impact.json", "scripts/check-change-impact.ts"]) {
    assert.ok(gov.owned_paths.includes(p), `治理节点应自持 ${p}`);
  }
  const lb = policy.nodes.find((n: any) => n.id === "leaderboard");
  assert.equal(lb?.risk_floor, "high", "榜算法节点风险下限须为 high（AC1 语义根）");
});

after(() => rmSync(tmp, { recursive: true, force: true }));
