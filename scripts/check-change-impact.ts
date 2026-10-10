// T14/ym247 编辑联动检查器（tzr-change/1 manifest × tzr-impact/1 影响图）：只读核验
// diff→传递闭包→manifest 一致性。本脚本与 docs/change-impact.json 受自放行禁令保护：
// 普通变更的 diff 触及二者即 FAIL；政策升级走 kind=policy_install 且须带在盘独立审计件。
// 只读：不写任何文件、不改政策；exit 0=PASS，exit 1=FAIL（逐条列原因）。
//
//   node scripts/check-change-impact.ts --manifest <change-manifest.json> [--policy <change-impact.json>] [--changed <paths.txt>]
//
// 缺省 --policy = 仓库 docs/change-impact.json；缺省 --changed = git 工作树实际变更
// （git diff --name-only HEAD + status 未跟踪，去重归一为仓库相对正斜杠路径）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PROTECTED = ["docs/change-impact.json", "scripts/check-change-impact.ts"];
const RISK_ORDER = { low: 0, high: 1 } as const;
type Risk = keyof typeof RISK_ORDER;

// ── args ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argOf(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const manifestPath = argOf("manifest");
const policyPath = argOf("policy") ?? join(REPO_ROOT, "docs", "change-impact.json");
const changedFile = argOf("changed");
if (!manifestPath) {
  console.error("用法: node scripts/check-change-impact.ts --manifest <change-manifest.json> [--policy …] [--changed <paths.txt>]");
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const errors: string[] = [];
const fail = (code: string, detail: string) => errors.push(`${code}: ${detail}`);

function toRepoRel(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (!s || s.startsWith("#")) return "";
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) {
    const rel = relative(REPO_ROOT, resolve(s));
    s = rel.split(sep).join("/");
  }
  return s.replace(/^\.\//, "");
}

function gitChangedPaths(): string[] {
  const out = new Set<string>();
  for (const cmd of [
    ["git", ["diff", "--name-only", "HEAD"]],
    ["git", ["status", "--porcelain"]],
  ] as const) {
    const r = spawnSync(cmd[0], [...cmd[1]], { cwd: REPO_ROOT, encoding: "utf8" });
    if (r.status !== 0 && !r.stdout) continue;
    for (const line of r.stdout.split("\n")) {
      // porcelain: "XY path"（含 rename 的 "R old -> new" 取 new）；diff 输出即纯路径
      const m = line.trim().match(/^(?:[MADRCU?!.,]{1,2}\s+)?(.+?)(?: -> (.+))?$/);
      if (!m) continue;
      const p = toRepoRel(m[2] ?? m[1]);
      if (p) out.add(p);
    }
  }
  return [...out];
}

// ── load inputs ─────────────────────────────────────────────────────────────────────────────
type Node = { id: string; owned_paths: string[]; consumer_edges: string[]; required_checks: string[]; risk_floor: string };
let manifest: any;
let policy: any;
let policyBytes: Buffer;
try {
  manifest = JSON.parse(readFileSync(resolve(manifestPath!), "utf8"));
} catch (e) {
  console.error(`manifest 不可读/非法 JSON: ${manifestPath} — ${e}`);
  process.exit(1);
}
try {
  policyBytes = readFileSync(resolve(policyPath));
  policy = JSON.parse(policyBytes.toString("utf8"));
} catch (e) {
  console.error(`影响图政策不可读/非法 JSON: ${policyPath} — ${e}`);
  process.exit(1);
}
const changedPaths: string[] = changedFile
  ? readFileSync(resolve(changedFile), "utf8").split(/\r?\n/).map(toRepoRel).filter(Boolean)
  : gitChangedPaths();

// ── E1/E2: shape & graph integrity ──────────────────────────────────────────────────────────
if (manifest.schema !== "tzr-change/1") fail("E1", `manifest.schema 应为 tzr-change/1，实得 ${manifest.schema}`);
const kind: string = manifest.kind ?? "change";
if (kind !== "change" && kind !== "policy_install") fail("E1", `kind 非法：${kind}（合法 change|policy_install）`);
for (const f of ["task_id", "changed_hunks", "roots", "closure", "impact_policy_hash", "risk", "release_id"]) {
  if (manifest[f] == null || manifest[f] === "") fail("E1", `manifest 缺必填字段 ${f}`);
}
if (manifest.risk != null && !(manifest.risk in RISK_ORDER)) fail("E1", `risk 非法：${manifest.risk}（消费面/费用不明属 unknown=禁止申报，先补证据）`);

if (policy.schema !== "tzr-impact/1") fail("E2", `政策 schema 应为 tzr-impact/1，实得 ${policy.schema}`);
const nodes: Node[] = Array.isArray(policy.nodes) ? policy.nodes : [];
const byId = new Map<string, Node>();
for (const n of nodes) {
  if (byId.has(n.id)) fail("E2", `节点 id 重复：${n.id}`);
  byId.set(n.id, n);
}
for (const n of nodes) {
  for (const t of n.consumer_edges ?? []) {
    if (!byId.has(t)) fail("E2", `悬空 consumer_edge：${n.id} -> ${t}（目标节点不存在）`);
  }
}
// 环检测（consumer_edges 有向图）
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map<string, number>(nodes.map((n): [string, number] => [n.id, WHITE]));
let dfsStack: string[] = [];
const dfs = (id: string) => {
  color.set(id, GRAY);
  dfsStack.push(id);
  for (const t of byId.get(id)?.consumer_edges ?? []) {
    if (!byId.has(t)) continue;
    const c = color.get(t);
    if (c === GRAY) fail("E2", `影响图存在环：${[...dfsStack.slice(dfsStack.indexOf(t)), t].join(" -> ")}`);
    else if (c === WHITE) dfs(t);
  }
  dfsStack.pop();
  color.set(id, BLACK);
};
for (const n of nodes) if (color.get(n.id) === WHITE) dfs(n.id);

// ── E3: policy hash ─────────────────────────────────────────────────────────────────────────
const policySha = sha256(policyBytes);
if (manifest.impact_policy_hash != null && manifest.impact_policy_hash !== policySha) {
  fail("E3", `impact_policy_hash 不符：manifest=${String(manifest.impact_policy_hash).slice(0, 16)}… 政策实算=${policySha.slice(0, 16)}…（政策已变更或 hash 抄错；改政策须另立任务）`);
}

// ── E4: protected paths / self-approval ─────────────────────────────────────────────────────
const policyRel = toRepoRel(policyPath);
const touchedProtected = changedPaths.filter((p) => PROTECTED.includes(p) || p === policyRel);
if (touchedProtected.length > 0) {
  if (kind !== "policy_install") {
    fail("E4", `自放行禁令：普通变更 diff 触及政策/检查器（${touchedProtected.join(", ")}）；影响图升级须另立高风险任务（kind=policy_install+独立审计）`);
  } else {
    const aud = manifest.independent_audit;
    if (!aud || !aud.path || !aud.sha256) {
      fail("E4", "policy_install 缺 independent_audit {path, sha256}");
    } else if (!existsSync(resolve(REPO_ROOT, aud.path)) || sha256(readFileSync(resolve(REPO_ROOT, aud.path))) !== aud.sha256) {
      fail("E4", `independent_audit 与在盘文件不符：${aud.path}（须与将发布审计件同 hash）`);
    }
  }
}

// ── E5: scope（越界 dirty hunk） ────────────────────────────────────────────────────────────
const declaredHunks: string[] = Array.isArray(manifest.changed_hunks) ? manifest.changed_hunks.map((h: any) => toRepoRel(h.path ?? "")) : [];
const externalEntries: Array<any> = Array.isArray(manifest.external) ? manifest.external : [];
const external: string[] = externalEntries.map((h: any) => toRepoRel(h.path ?? ""));
const allowed = new Set<string>([...declaredHunks, ...external, ...(kind === "policy_install" ? touchedProtected : [])]);
for (const p of changedPaths) {
  if (!allowed.has(p)) fail("E5", `越界变更：${p} 在实际 diff 中但 manifest 未声明（changed_hunks/external 均无）`);
}
const dupHunk = declaredHunks.find((p, i) => declaredHunks.indexOf(p) !== i);
if (dupHunk) fail("E5", `changed_hunks 重复声明：${dupHunk}`);

// ── E6: ownership（未知路径 fail-closed） ────────────────────────────────────────────────────
const ownerOf = (path: string): Node | null => {
  let best: Node | null = null;
  let bestLen = -1;
  for (const n of nodes) {
    for (const op of n.owned_paths ?? []) {
      const hit = op.endsWith("/") ? path.startsWith(op) : path === op;
      if (hit && op.length > bestLen) {
        best = n;
        bestLen = op.length;
      }
    }
  }
  return best;
};
const hitNodes = new Set<string>();
let unknownPath = false;
for (const p of declaredHunks) {
  const owner = ownerOf(p);
  if (!owner) {
    unknownPath = true;
    fail("E6", `未知路径：${p} 不属任何影响图节点 owned_paths（默认高风险；先另立任务把路径归属进影响图再施工）`);
  } else hitNodes.add(owner.id);
}

// ── E5b: external 声明面（跨族终审 P1 销项：external 不得静默削弱 E6） ────────────────────────
// 规则：每条 external 须带非空 owner（≠本任务）；路径须能归属影响图节点；图外路径仅在
// manifest 显式声明 external_policy=allow_unattributed 且 risk=high 时放行，且计数进
// stats.external_unattributed 并强制 E9 下限 high——「未知待归属」必须响亮，不得沉默通过。
let externalUnattributed = 0;
const allowUnattributed = manifest.external_policy === "allow_unattributed";
for (const e of externalEntries) {
  const p = toRepoRel(e.path ?? "");
  if (!p) continue;
  const owner = String(e.owner ?? "").trim();
  if (!owner || owner === manifest.task_id) {
    fail("E5b", `external 条目缺 owner 或 owner=本任务（${p}）：外部声明必须归属他方，不得用来覆盖自己的改动`);
    continue;
  }
  if (!ownerOf(p)) {
    if (!allowUnattributed || manifest.risk !== "high") {
      fail("E5b", `external 图外路径未获放行：${p}（须 manifest.external_policy="allow_unattributed" 且 risk=high 才能声明图外在途件）`);
    } else {
      externalUnattributed++;
    }
  }
}
if (externalUnattributed > 0) unknownPath = true;

// ── E7: roots 真实性 ────────────────────────────────────────────────────────────────────────
const roots: string[] = Array.isArray(manifest.roots) ? manifest.roots : [];
for (const r of roots) {
  if (!byId.has(r)) fail("E7", `roots 含未知节点：${r}`);
  else if (!hitNodes.has(r)) fail("E7", `假 root：${r} 未被任何 changed_hunk 命中（root 必须对应实际变更根）`);
}
const closureEntries = new Map<string, any>();
for (const c of Array.isArray(manifest.closure) ? manifest.closure : []) {
  if (!byId.has(c.node)) fail("E7", `closure 含未知节点：${c.node}`);
  if (closureEntries.has(c.node)) fail("E7", `closure 重复节点：${c.node}`);
  closureEntries.set(c.node, c);
}
for (const h of hitNodes) {
  if (!roots.includes(h) && !(closureEntries.get(h)?.disposition === "changed")) {
    fail("E7", `命中节点未申报：${h} 的 owned_paths 被改动，须列入 roots 或 closure(disposition=changed)`);
  }
}

// ── E8: 传递闭包（漏消费者/假证据） ─────────────────────────────────────────────────────────
const closure = new Set<string>();
const queue = [...roots];
while (queue.length > 0) {
  const id = queue.shift()!;
  if (closure.has(id)) continue;
  closure.add(id);
  for (const t of byId.get(id)?.consumer_edges ?? []) if (byId.has(t) && !closure.has(t)) queue.push(t);
}
const evidencePathExists = (ev: string): boolean => {
  const m = ev.match(/[\w./\\-]+\.(?:md|txt|json|log|ts|tsx|py|sql|patch|jsonl)/);
  if (!m) return false;
  return existsSync(resolve(REPO_ROOT, m[0])) || existsSync(resolve(m[0]));
};
for (const id of closure) {
  const c = closureEntries.get(id);
  if (!c) {
    fail("E8", `漏消费者：闭包节点 ${id} 在 manifest.closure 无处置（changed/checked/n_a 三选一+证据）`);
    continue;
  }
  if (!["changed", "checked", "n_a"].includes(c.disposition)) {
    fail("E8", `closure[${id}].disposition 非法：${c.disposition}`);
    continue;
  }
  if (!c.evidence || String(c.evidence).trim() === "") {
    fail("E8", `假证据：closure[${id}].disposition=${c.disposition} 但 evidence 为空`);
    continue;
  }
  if (c.disposition === "changed" && !hitNodes.has(id)) {
    fail("E8", `closure[${id}] 声称 changed 但无对应 changed_hunk 命中该节点`);
  }
  if ((c.disposition === "checked" || c.disposition === "n_a") && !evidencePathExists(String(c.evidence))) {
    fail("E8", `假证据：closure[${id}] evidence 未指向在盘文件（${String(c.evidence).slice(0, 60)}…）`);
  }
}

// ── E9: risk floor ──────────────────────────────────────────────────────────────────────────
let floor: Risk = manifest.risk === "high" ? "high" : "low";
for (const id of [...hitNodes, ...closure]) {
  const rf = byId.get(id)?.risk_floor;
  if (rf === "high") floor = "high";
}
if (unknownPath) floor = "high";
if (manifest.risk in RISK_ORDER && RISK_ORDER[manifest.risk as Risk] < RISK_ORDER[floor]) {
  fail("E9", `风险档低于下限：申报 ${manifest.risk}，命中/闭包节点与未知路径下限=${floor}`);
}

// ── E10: required checks ────────────────────────────────────────────────────────────────────
const checksRun = new Map<string, any>();
for (const cr of Array.isArray(manifest.checks_run) ? manifest.checks_run : []) checksRun.set(String(cr.check), cr);
for (const id of closure) {
  for (const req of byId.get(id)?.required_checks ?? []) {
    const cr = checksRun.get(req);
    if (!cr) fail("E10", `缺检查记录：闭包节点 ${id} 要求「${req}」，manifest.checks_run 未登记`);
    else if (cr.exit_code !== 0) fail("E10", `检查未过：闭包节点 ${id} 要求「${req}」，登记 exit_code=${cr.exit_code}`);
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────
const verdict = errors.length === 0 ? "PASS" : "FAIL";
const stats = {
  changed: changedPaths.length, declared: declaredHunks.length, external: external.length,
  external_unattributed: externalUnattributed,
  roots: roots.length, closure: closure.length, hit: [...hitNodes].length, policy_sha256: policySha.slice(0, 16),
};
console.log(JSON.stringify({ verdict, errors, stats, manifest: manifest.task_id, kind, risk: manifest.risk, risk_floor: floor }));
if (verdict === "FAIL") {
  console.error(`check-change-impact FAIL（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-change-impact PASS：${stats.declared} hunk / ${closure.size} 闭包节点全处置 / 风险 ${manifest.risk} ≥ 下限 ${floor}${externalUnattributed > 0 ? ` / external 图外在途 ${externalUnattributed} 条（已计未知面）` : ""}`);
