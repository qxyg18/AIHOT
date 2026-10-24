// T15/ym248 文章审核面反例测试（G00 指引：单位/基准保留/聚簇不伪装独立佐证反例）。
// 纯函数零模型调用（BUILD 禁用态）；AC4 样本集依赖不在本件（G00=WAITING_SAMPLE，卡 hold 候样本）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGroundedAction,
  checkMacroQualified,
  checkUnitPreservation,
  detectConflicts,
  independentEventCount,
  reviewArticleEvidence,
  reviewHash,
  reviewLeadParagraph,
  reviewSoWhatLine,
  snapshotMetrics,
} from "@aihot/backend/editorial/article-review";

test("T15/AC1: £ and $ are preserved — cross-currency rewrite flags unit_mismatch", () => {
  const metrics = snapshotMetrics("LVMH 三季度时装部门有机收入增长 6%，按固定汇率；英镑计价 £12 亿");
  // 下游把 £ 换写成 $：失真
  const flags = checkUnitPreservation("LVMH 收入 $12 亿", metrics);
  assert.ok(flags.includes("unit_mismatch"), `£→$ 换写必须失真（实际 ${flags}）`);
  // 原币种照抄：通过（百分比未引用不带 mismatch）
  const ok = checkUnitPreservation("LVMH 收入 £12 亿", metrics);
  assert.ok(!ok.includes("unit_mismatch"), "£ 照抄不得误报");
});

test("T15/AC1: 22% nominal and 26% fixed-rate coexist as separate baselines, never averaged", () => {
  const text = "Burberry 上半财年收入下滑 22%（名义），按固定汇率口径则增长 26%";
  const metrics = snapshotMetrics(text);
  const pct = metrics.filter((m) => m.raw.includes("%"));
  assert.equal(pct.length, 2, "两个百分比各自快照");
  const bases = pct.flatMap((m) => m.basisContext);
  assert.ok(bases.includes("名义") && bases.includes("固定汇率"), "各自基准词入快照");
  const conflicts = detectConflicts(metrics, "item-1");
  assert.equal(conflicts.length, 1, "同主体多值并列");
  assert.equal(conflicts[0]!.values.length, 2, "两条并列不平均造第三值");
  // 整条审核：conflict_pending 待核
  const r = reviewArticleEvidence({ itemId: "item-1", title: "Burberry 上半年", summary: text, sourceName: "时尚商业网" });
  assert.ok(r.flags.includes("conflict_pending"), "多值不同基准=冲突并列待核");
  // 下游引用其一必须保真：引用 25%（两边都不是）=失真
  const flags = checkUnitPreservation("Burberry 收入变动 25%", metrics);
  assert.ok(flags.includes("unit_mismatch"), "引用原文不存在的百分比=失真");
});

test("T15/AC1: same-event cluster is one independent event, not multi-source corroboration", () => {
  const entries = [
    { itemId: "a1", sameEventKey: "f-99" },
    { itemId: "a2", sameEventKey: "f-99" },
    { itemId: "a3", sameEventKey: null },
    { itemId: "a4", sameEventKey: "f-42" },
  ];
  assert.equal(independentEventCount(entries), 3, "同簇 f-99 两条算一事件，共 3 个独立事件");
});

test("T15/AC2: action without channel evidence is ungrounded; with evidence passes", () => {
  const materialNoEvidence = "LVMH 三季度收入增长 6%（标题）奢侈品巨头财报（摘要）路透社";
  assert.ok(!checkGroundedAction("建议巴拉巴拉立即扩店抢占市场", materialNoEvidence), "材料无渠道证据的行动指令=无据");
  const materialWithEvidence = "巴拉巴拉全国门店突破 2000 家，渠道加盟持续开放";
  assert.ok(checkGroundedAction("巴拉巴拉扩店节奏或影响童装格局", materialWithEvidence), "材料含门店/加盟证据=有据");
  // 无行动动词的点评不受此闸
  assert.ok(checkGroundedAction("奢侈品降温或影响高端童装消费情绪", materialNoEvidence), "无行动动词不受闸");
});

test("T15/AC2: macro-category so-what must carry a qualifier, else dropped", () => {
  assert.ok(!checkMacroQualified("奢侈品增长 6%，童装品牌应立即调价", "market-data"), "宏观条目无限定词的经营指令=不过");
  assert.ok(checkMacroQualified("奢侈品增速回升，对童装定价影响尚待核验", "market-data"), "带待核限定=过");
  assert.ok(checkMacroQualified("巴拉巴拉门店增长明确", "brand-moves"), "非宏观类不受此闸");
});

test("T15/AC2: reviewSoWhatLine composes all gates (action grounding + macro qualifier + unit fidelity)", () => {
  const entry = { title: "奢侈品集团三季度收入增长 6%", summary: "按固定汇率口径；欧元计价", sourceName: "路透社", category: "market-data" };
  const bad = reviewSoWhatLine("奢侈品回暖，建议童装品牌全面调价 10%", entry);
  assert.ok(!bad.ok && bad.flags.length > 0, "无据+缺限定+百分比失真多闸齐下");
  const good = reviewSoWhatLine("奢侈品增速回升，对童装影响尚待核验", entry);
  assert.ok(good.ok, `带限定且无失真引用应通过（实际 ${good.flags}）`);
});

test("T15/idempotency: reviewHash is stable per identical input and differs on change", () => {
  const a = { itemId: "x1", title: "t", summary: "s", sourceName: "n" };
  const b = { ...a, summary: "s2" };
  assert.equal(reviewHash(a), reviewHash({ ...a }), "同输入同哈希（幂等键）");
  assert.notEqual(reviewHash(a), reviewHash(b), "输入变哈希变");
});

test("T15: reviewArticleEvidence snapshots metrics and records sameEventKey", () => {
  const r = reviewArticleEvidence({ itemId: "i9", title: "营收 20 亿元", summary: "同比增长 5%", sourceName: "联商网", sameEventKey: "f-7" });
  assert.equal(r.itemId, "i9");
  assert.equal(r.sameEventKey, "f-7");
  assert.ok(r.metrics.some((m) => m.raw.includes("5%")), "百分比入快照");
  assert.match(r.inputHash, /^[0-9a-f]{64}$/, "inputHash 为 sha256");
});

// ── 审计销项反例（P1/P2/P3）──────────────────────────────────────────────

test("T15/audit-P1: verbatim same-value percent quote passes (no missing_unit false positive)", () => {
  const material = "巴拉巴拉前三季度营收增长 6%，表现强劲";
  const metrics = snapshotMetrics(material);
  const flags = checkUnitPreservation("巴拉巴拉营收增长 6%，表现强劲", metrics);
  assert.equal(flags.length, 0, `照抄同值百分比是合规引用（实际 ${flags}）`);
});

test("T15/audit-P2: CJK currency words snapshot (亿元/万元) and rewrite to $ flags", () => {
  const metrics = snapshotMetrics("某集团全年营收 6 亿元，净利 3000 万元");
  assert.ok(metrics.some((m) => m.raw.includes("亿")), `中文计价词必须入快照（实际 ${JSON.stringify(metrics)}）`);
  assert.ok(metrics.some((m) => m.raw.includes("万")));
  // 亿元→$ 换写漏报堵住：原文只有中文计价词，下游出现 $ 符号=失真
  const flags = checkUnitPreservation("该集团营收 $6 亿", metrics);
  assert.ok(flags.includes("unit_mismatch"), `亿元→$ 换写应失真（实际 ${flags}）`);
});

test("T15/audit-P1: reviewLeadParagraph gates lead prose (unit fidelity + grounded action)", () => {
  const entries = [
    { title: "奢侈品集团三季度有机收入增长 6%", summary: "按固定汇率", sourceName: "路透社", category: "market-data" },
    { title: "某童装品牌门店调整", summary: "全国门店持续经营", sourceName: "联商网", category: "brand-moves" },
  ];
  // 百分比失真（8% 原文没有）
  const bad = reviewLeadParagraph("奢侈品增长 8%，带动行业", entries);
  assert.ok(!bad.ok && bad.flags.includes("unit_mismatch"), "导语引用原文不存在的百分比=降级");
  // 照抄同值+无行动词=过
  const okLead = reviewLeadParagraph("奢侈品增长 6%，对童装影响尚待核验", entries);
  assert.ok(okLead.ok, `照抄同值导语应通过（实际 ${okLead.flags}）`);
  // 全宏观条目导语无限定词=降级
  const macroOnly = [entries[0]!];
  const unq = reviewLeadParagraph("奢侈品增长 6%，童装品牌应全面调价", macroOnly);
  assert.ok(!unq.ok && unq.flags.includes("macro_inference_unqualified"), "纯宏观导语的无据指令=降级");
});

// ── delta 二审销项反例（导语宏观闸生产接线 + CNY/USD 缩写快照） ─────────────

test("T15/delta-P1: macro qualifier gate fires for production-shaped entries (category via map)", () => {
  // 生产签名复刻：entries 无 category 字段（ReportEntry），category 由外部 map 提供——闸必须活。
  const entries = [
    { title: "奢侈品集团三季度有机收入增长 6%", summary: "按固定汇率", sourceName: "路透社" },
    { title: "欧洲消费温和复苏", summary: "区域市场观察", sourceName: "华衣网" },
  ];
  const cats = new Map([["a", "market-data"], ["b", "market-data"]]);
  const withCats = entries.map((e, i) => ({ ...e, category: cats.get(i === 0 ? "a" : "b") ?? null }));
  const flags = reviewLeadParagraph("奢侈品回暖，童装品牌应全面调价", withCats);
  assert.ok(!flags.ok && flags.flags.includes("macro_inference_unqualified"), `纯宏观条目导语的无据指令必须降级（实际 ${flags.flags}）`);
  const qualified = reviewLeadParagraph("奢侈品增速回升，对童装影响尚待核验", withCats);
  assert.ok(qualified.ok, `带限定导语应通过（实际 ${qualified.flags}）`);
});

test("T15/delta-P1: CNY/USD/GBP abbreviations enter the snapshot (word boundary alive)", () => {
  const metrics = snapshotMetrics("集团营收 CNY 7 亿，另计 USD 500 万与 GBP 3 千万");
  const raws = metrics.map((m) => m.raw);
  for (const abbr of ["CNY", "USD", "GBP"]) {
    assert.ok(raws.some((r) => r.includes(abbr)), `${abbr} 缩写必须入快照（实际 ${JSON.stringify(raws)}）`);
  }
  // 词内误配防护：小写词中含 cny 不触发（\b 边界）
  const noFalse = snapshotMetrics("内部字母串 xCNYx 与 usdUSD 词内嵌套");
  assert.ok(!noFalse.some((m) => /CNY|USD|GBP/.test(m.raw)), "词边界外的字母串不误配");
});
