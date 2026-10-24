// T19/ym251 入驻机会反例测试（AC2/3/4/5/6）：read 五状态分组与人工优先、review 分权
// fail-closed、私有桥字段零泄漏、公开面零引用、importer 13 列白名单（静态）与未注册
// route 零生成类型引用（静态）。全部跑在 *_test/*_ci 隔离库（setup.ts 守卫）。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { loadOpportunities, pureNewCandidates } from "@aihot/backend/opportunities/read";
import { reviewOpportunity } from "@aihot/backend/opportunities/review";
import type { AdminOpportunityRow } from "@aihot/contracts/site";

const T = tag();

after(async () => {
  await closeDb();
});

const MALLS = (JSON.parse(readFileSync(path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json"), "utf8")) as {
  malls: Array<{ slug: string; name: string; city?: string }>;
}).malls;
const BRANDS = (JSON.parse(readFileSync(path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json"), "utf8")) as {
  brands: Array<{ slug: string; name: string }>;
}).brands;
const [MAL_CONFIRMED, MAL_HIST, MAL_BRIDGED, MAL_REVIEWED_NOTFOUND, MAL_PLAIN, MAL_FEEDBACK] = MALLS.map((m) => m.slug);
const BRAND_SLUG = BRANDS[0].slug;

async function seedGrant(principal: string, capability: string): Promise<void> {
  await sql`INSERT INTO admin_cap_grants (principal, capability, granted_by)
            VALUES (${principal}, ${capability}, ${"t19-test-" + T})
            ON CONFLICT (principal, capability) DO NOTHING`;
}

async function seedBridge(mallSlug: string, storeCode: string, extra = ""): Promise<void> {
  await sql`
    INSERT INTO store_archive_bridge
      (archive_hash, row_ref, store_code, subject_era, city, channel, brand_evidence, open_state, state_basis, mall_slug, mall_confirmed_by, mall_confirmed_at)
    VALUES (${"t19-arc-" + T}, ${"sheet:" + storeCode}, ${storeCode}, ${"关联节点-" + extra}, ${"测试市"},
            ${"MALL"}, ${"店仓类别=总部直营；编号前缀=B(前缀不构成品牌证明)"},
            'pending_review', ${"档案营业状态=正常；同编号多行(转让/合并多主体疑义)待核" + extra},
            ${mallSlug}, ${"t19-confirm-" + T}, now())
    ON CONFLICT (archive_hash, row_ref) DO NOTHING`;
}

test("R4 鉴权 fail-closed：无 grant 拒绝；read/feedback/confirm 分权；admin:operate 超集", async () => {
  await assert.rejects(loadOpportunities("t19-nobody-" + T), /capability_required:channel:read\|admin:operate/);
  await seedGrant("t19-reader-" + T, "channel:read");
  await seedGrant("t19-feeder-" + T, "channel:feedback");
  await seedGrant("t19-confirmer-" + T, "channel:confirm");
  await seedGrant("t19-boss-" + T, "admin:operate");

  await loadOpportunities("t19-reader-" + T); // 可读
  await assert.rejects(
    reviewOpportunity({ principal: "t19-reader-" + T, entityType: "mall", entitySlug: MAL_CONFIRMED, action: "confirm", state: "confirmed_open" }),
    /capability_required:channel:confirm\|admin:operate/,
  );
  const fb = await reviewOpportunity({ principal: "t19-feeder-" + T, entityType: "mall", entitySlug: MAL_FEEDBACK, action: "feedback", feedback: "渠道owner评估中", hubRef: "HUB-ym251" });
  assert.equal(fb.state, "pending_review", "feedback 不得改状态（独立反馈实体从待核起步）");
  assert.equal(fb.feedback, "渠道owner评估中");
  const fbAgain = await reviewOpportunity({ principal: "t19-feeder-" + T, entityType: "mall", entitySlug: MAL_FEEDBACK, action: "feedback" });
  assert.equal(fbAgain.feedback, "渠道owner评估中", "feedback 未传文本=保留既有反馈（不误清）");
  const done = await reviewOpportunity({ principal: "t19-confirmer-" + T, entityType: "mall", entitySlug: MAL_CONFIRMED, action: "confirm", state: "confirmed_open", missing: ["租金未知"] });
  assert.equal(done.state, "confirmed_open");
  const kept = await reviewOpportunity({ principal: "t19-boss-" + T, entityType: "mall", entitySlug: MAL_CONFIRMED, action: "feedback", feedback: "复核" });
  assert.equal(kept.state, "confirmed_open", "admin:operate 反馈动作保留已确认状态");
  assert.ok(kept.missing.includes("租金未知"), "feedback 未传缺项=保留人工缺项（不误清，ISSUE-3）");
  await assert.rejects(
    reviewOpportunity({ principal: "t19-confirmer-" + T, entityType: "mall", entitySlug: MAL_CONFIRMED, action: "confirm", state: "非常适合签约" as never }),
    /invalid_state/,
  );
});

test("R2 五状态互斥分组：人工审阅优先；桥行=待核；未检出≠未入驻注记；已确认在营不入纯新增", async () => {
  await seedBridge(MAL_BRIDGED, "T19-B-001");
  await seedBridge(MAL_REVIEWED_NOTFOUND, "T19-B-002", "（人工标未检出但桥在——尊重人工）");
  await reviewOpportunity({ principal: "t19-boss-" + T, entityType: "mall", entitySlug: MAL_REVIEWED_NOTFOUND, action: "confirm", state: "not_found" });
  await reviewOpportunity({ principal: "t19-boss-" + T, entityType: "mall", entitySlug: MAL_HIST, action: "confirm", state: "historical", hubRef: "HUB-ym251" });
  await reviewOpportunity({ principal: "t19-boss-" + T, entityType: "brand", entitySlug: BRAND_SLUG, action: "confirm", state: "planned" });

  const { rows } = await loadOpportunities("t19-reader-" + T);
  const find = (type: string, slug: string): AdminOpportunityRow => {
    const r = rows.find((x) => x.entity.type === type && x.entity.slug === slug);
    assert.ok(r, `row ${type}:${slug}`);
    return r;
  };
  const confirmed = find("mall", MAL_CONFIRMED);
  assert.equal(confirmed.occupancy, "confirmed_open");
  assert.ok(confirmed.missing.includes("租金未知"), "人工缺项透传");
  assert.equal(find("mall", MAL_HIST).occupancy, "historical");
  assert.equal(find("mall", MAL_BRIDGED).occupancy, "pending_review", "桥行无审阅=待核");
  assert.ok(find("mall", MAL_BRIDGED).missing.some((m) => m.includes("人工核验")), "待核行带核验缺项");
  const notFoundReviewed = find("mall", MAL_REVIEWED_NOTFOUND);
  assert.equal(notFoundReviewed.occupancy, "not_found", "人工 not_found 优先于桥行");
  assert.equal(find("mall", MAL_PLAIN).occupancy, "not_found", "名录内无桥无审=未检出");
  assert.ok(find("mall", MAL_PLAIN).missing.some((m) => m.includes("未检出") && m.includes("未入驻")), "未检出≠未入驻注记");
  assert.equal(find("brand", BRAND_SLUG).occupancy, "planned", "品牌行仅人工审阅出现");

  const pure = pureNewCandidates(rows);
  assert.ok(!pure.some((r) => r.occupancy === "confirmed_open" || r.occupancy === "historical"), "纯新增不含已确认在营/历史");
  assert.ok(pure.some((r) => r.entity.slug === MAL_PLAIN), "未检出的名录 mall 进纯新增候选");
  const states = new Set(rows.map((r) => r.occupancy));
  for (const s of ["confirmed_open", "historical", "planned", "pending_review", "not_found"]) assert.ok(states.has(s as never), `五状态须出现：${s}`);
});

test("R3 私有桥隔离：响应序列化零店仓编号/名称/关联节点；公开面零 opportunities 引用", async () => {
  const { rows } = await loadOpportunities("t19-reader-" + T);
  const text = JSON.stringify(rows);
  for (const secret of ["T19-B-001", "T19-B-002", "store_code", "storeCode", "关联节点", "档案营业状态", "state_basis", "subject_era"]) {
    assert.ok(!text.includes(secret), `响应不得含私有桥字段/值：${secret}`);
  }
  const publicFaces = [
    path.join(REPO_ROOT, "apps/api/src/routes"),
    ...readdirSync(path.join(REPO_ROOT, "apps/web/app/routes")).filter((f) => f.endsWith(".tsx") && !f.startsWith("admin.")).map((f) => path.join(REPO_ROOT, "apps/web/app/routes", f)),
  ];
  for (const face of publicFaces) {
    const files = face.endsWith(".tsx") ? [face] : readdirSync(face).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).map((f) => path.join(face, f));
    for (const f of files) {
      if (f.includes("admin")) continue; // 后台面允许
      assert.ok(!readFileSync(f, "utf8").includes("opportunit"), `公开面文件不得引用机会模块：${f}`);
    }
  }
});

test("R5+R6 静态面：importer 13 列白名单与禁列零出现；未注册 route 零生成类型引用", () => {
  const importer = readFileSync(path.join(REPO_ROOT, "scripts/import-db-occupancy.py"), "utf8");
  for (const col of ["编号", "店仓名称", "省份", "城市", "区县", "渠道类别", "店仓类别", "营业状态", "是否允许零售", "开店时间", "闭店时间", "关联节点", "可用"]) {
    assert.ok(importer.includes(`"${col}"`), `importer 白名单须含允许列：${col}`);
  }
  for (const banned of ["POS", "密码", "联系人", "收货", "加盟商财务", "会员"]) {
    assert.ok(!importer.includes(banned), `importer 不得出现禁列：${banned}`);
  }
  assert.ok(importer.includes("PENDING = \"pending_review\""), "导入器只产 pending_review");
  const page = readFileSync(path.join(REPO_ROOT, "apps/web/app/routes/admin/opportunities.tsx"), "utf8");
  assert.ok(!/^import[^\n]*\+types\/opportunities/m.test(page), "未注册 route 禁引用生成类型（AC6）");
  for (const src of [path.join(REPO_ROOT, "packages/backend/src/opportunities/read.ts"), path.join(REPO_ROOT, "packages/backend/src/opportunities/review.ts")]) {
    const code = readFileSync(src, "utf8");
    assert.ok(!/providers\/|callModel|chat\.completions|openai|invokeModel/.test(code), "机会模块零模型调用（AC6）");
  }
});
