// ym326 NAV 显隐与五状态单源防回潮（纯函数面，零 DB 依赖——contract-dto.test.ts 同款先例）。
// 显隐判定独立在 features/admin/nav.ts（无 react 依赖链），本文件钉住：
// ①入驻机会入口=channel:read ∪ admin:operate 并集显示（与 /api/admin/opportunities 路由层
// 并集门同语义，T06B 审计 P3-4/遗留③收口）；②默认单值门与空组剔除不回退；③五状态词汇
// 单源（ym326 审计 P2-2）后，路由/模块三处不得再起本地副本（静态文本断言防回潮）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { navGroupsFor, type NavPrincipal } from "../apps/web/app/features/admin/nav.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const flatFor = (me: NavPrincipal) => navGroupsFor(me).flatMap((g) => g.items);
const OPP = (me: NavPrincipal) => flatFor(me).some((i) => i.to === "/admin/opportunities");

test("N1 operator（admin:operate，compat 与 grant 行同形）→ 入驻机会入口可见", () => {
  // NAV 层拿到的是 /api/admin/me 的权威判定；compat operator（无行）与已授行 operator
  // 的 capabilities 同形，显示语义一致——API 面的授行收口见 ym326 探针复测。
  assert.equal(OPP({ capabilities: ["admin:operate"] }), true);
});

test("N2 channel viewer（channel:read）→ 入驻机会入口可见（并集显示）", () => {
  assert.equal(OPP({ capabilities: ["channel:read", "channel:feedback"] }), true);
});

test("N3 未知身份（空/缺失 capabilities）→ 不显示，默认门入口全隐（fail-closed 表现层）", () => {
  assert.equal(OPP({ capabilities: [] }), false);
  assert.equal(OPP({}), false);
  assert.deepEqual(navGroupsFor({}), [], "无任何能力=无任何入口（空组剔除到底）");
});

test("N4 confirm-only（仅 channel:confirm）→ 入驻机会入口不可见（与 API read 并集不含 confirm-only 对齐，W7）", () => {
  assert.equal(OPP({ capabilities: ["channel:confirm"] }), false);
});

test("N5 viewer 不见系统组（默认 admin:operate 单值门不回退）；operator 内容组完整", () => {
  const viewerGroups = navGroupsFor({ capabilities: ["channel:read"] });
  assert.equal(viewerGroups.some((g) => g.group === "系统"), false, "viewer 无 admin:operate：系统组整组隐藏");
  const opContent = navGroupsFor({ capabilities: ["admin:operate"] }).find((g) => g.group === "内容");
  assert.ok(opContent, "operator 应见内容组");
  assert.ok(opContent.items.some((i) => i.to === "/admin/opportunities"), "operator 内容组含入驻机会");
  assert.ok(opContent.items.some((i) => i.to === "/admin/feedback"), "既有反馈入口不受影响");
});

test("S1 五状态词汇单源防回潮：路由与模块三处不得再起本地副本，且都消费 ADMIN_OCCUPANCY_STATES", () => {
  const consumers = [
    "apps/api/src/routes/admin.ts",
    "packages/backend/src/opportunities/read.ts",
    "packages/backend/src/opportunities/review.ts",
  ] as const;
  for (const rel of consumers) {
    const src = readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
    assert.equal(src.includes("const OCCUPANCY_WORDS"), false, `${rel} 不得再定义本地词表副本`);
    assert.equal(src.includes("const OCCUPANCY_STATES"), false, `${rel} 不得再定义本地词表副本`);
    assert.equal(src.includes("ADMIN_OCCUPANCY_STATES"), true, `${rel} 须消费 contracts 单源常量`);
  }
});
