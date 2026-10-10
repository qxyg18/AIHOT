// weighted v4.6（2026-10-02 命主定值：商业体榜 50/30/10/10、首店快闪维取消；v4.5=2026-10-02 命主令：并列按原始业绩定序 +
// 商场名录全量入池；v4.4=ym58 体量复合覆盖率闸、v4.3=命主 2026-10-01 18:18 看板裁定「断点及以上＝满值」）纯函数测试：
// 分层锚点边界组/权重和=1/扩张零残留/滚客流回归/并列定序 +
// v4 承接面（条件填充/成色折价/体量复合/先验分档/分位归一——营收/门店类已改分层锚点，分位仅剩体量分位） +
// v3 承接面（门槛/缺数计零统一分母/业绩滚客流/直榜分支/置信级透传/空转滚动）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRAND_DIMENSIONS,
  COVERAGE_MIN,
  FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE,
  FOOTFALL_TIER_SHARE,
  MALL_DIMENSIONS,
  MALL_FOOTFALL_MACHINE_METRICS,
  MENTION_GATED_METRICS,
  MENTION_MIN,
  METHOD_VERSION,
  METRIC_OPERATORS,
  METRIC_SOURCE_TIER,
  SOURCE_TIER_DISCOUNT,
  TIER_ANCHORS,
  affinityBrandScore,
  affinityPrior,
  computeBoard,
  computeBoards,
  dimensionScores,
  fillMissingRevenue,
  inputFingerprint,
  percentileRank,
  tierAnchoredScore,
  type BoardInput,
  type DimensionSpec,
  type SourceTier,
} from "@aihot/backend/leaderboard/method/weighted";

const reg = (family: string, weight: number, operator = "test", tier: SourceTier = "machine") => ({ family, weight, operator, protocol: "test", direction: "HIGHER" as const, interval_sd: null, tier });
const sig = (key: string, entries: Array<[string, number]>) => ({ key, rows: entries.map(([modelSlug, score]) => ({ modelSlug, score, lowerBound: null, upperBound: null, configuration: "" })) });
const valueSig = (key: string, entries: Array<[string, number, SourceTier]>) => ({
  key,
  rows: entries.map(([modelSlug, score, tier]) => ({ modelSlug, score, lowerBound: null, upperBound: null, configuration: "", tier })),
});

function boardInput(o: Partial<BoardInput> & { registry: BoardInput["registry"]; signals: BoardInput["signals"] }): BoardInput {
  return { board: "brand", names: {}, models: [], mode: "weighted", ...o };
}

/** 浮点容差断言（锚点插值含 0.1 等非二进制精确小数，精确等值断言会误红）。 */
const near = (actual: number, expected: number, msg?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""}（实际 ${actual}，期望 ${expected}）`);

test("mention-gated metrics drop entities below MENTION_MIN, directory-style metrics keep them", () => {
  const dims: DimensionSpec[] = [
    { key: "volume", name: "声量", weight: 0.5, metrics: ["brand-volume"], logScale: false },
    { key: "stores", name: "规模", weight: 0.5, metrics: ["brand-stores"], logScale: false },
  ];
  const input = boardInput({
    registry: { "brand-volume": reg("volume", 0.5), "brand-stores": reg("stores", 0.5) },
    signals: [
      sig("brand-volume", [["big", 10], ["small", MENTION_MIN - 1], ["zero", 0]]),
      sig("brand-stores", [["big", 100], ["small", 50], ["zero", 10]]),
    ],
  });
  const perDim = dimensionScores(input, dims);
  assert.ok(perDim.get("volume")!.has("big"));
  assert.ok(!perDim.get("volume")!.has("small"), "低于提及门槛的实体该维度不计分");
  assert.ok(!perDim.get("volume")!.has("zero"));
  assert.equal(perDim.get("stores")!.size, 3, "名录类指标不卡门槛");
});

test("missing dimensions score zero contribution under the fixed total-weight denominator", () => {
  // v2（命主 2026-09-30「业绩与规模不交叉参考」）：a 两维都有数；b 只有规模。
  // 统一分母后 b 缺声量维度计 0 贡献，不把权重摊给规模。rd12 起门店换分层锚点（绝对口径）：
  // a 门店 100→12.5 分（<200 段线性）、b 门店 200→25 分（首锚点值）。
  const dims: DimensionSpec[] = [
    { key: "volume", name: "声量", weight: 0.2, metrics: ["brand-volume"], logScale: false },
    { key: "stores", name: "规模", weight: 0.3, metrics: ["brand-stores"], logScale: false },
  ];
  const input = boardInput({
    registry: { "brand-volume": reg("volume", 0.2), "brand-stores": reg("stores", 0.3) },
    signals: [
      sig("brand-volume", [["a", 10]]),
      sig("brand-stores", [["a", 100], ["b", 200]]),
    ],
  });
  const out = computeBoard(input, dims);
  const a = out.entries.find((e) => e.slug === "a")!;
  const b = out.entries.find((e) => e.slug === "b")!;
  assert.equal(a.coverage, 1);
  assert.equal(b.coverage, Math.round((0.3 / 0.5) * 100) / 100);
  assert.equal(a.dimensions.stores, 12.5);
  assert.equal(b.dimensions.stores, 25);
  // a=(0.2×100+0.3×12.5)/0.5=47.5；b=0.3×25/0.5=15（缺声量计零后仍低于 a——锚点绝对分下单维实体优势被摊平）。
  assert.equal(a.score, 47.5);
  assert.equal(b.score, 15);
  assert.ok(!b.sampleInsufficient);
});

test("coverage below COVERAGE_MIN flags sampleInsufficient (entity-level missing data)", () => {
  // rd7 语义：全榜无数据的维度会被空转滚动条款移出权重体系；「样本不足」由实体级缺数触发。
  const dims: DimensionSpec[] = [
    { key: "revenue", name: "业绩", weight: 0.9, metrics: ["brand-revenue"], logScale: false },
    { key: "stores", name: "规模", weight: 0.1, metrics: ["brand-stores"], logScale: false },
  ];
  const input = boardInput({
    registry: { "brand-revenue": reg("revenue", 0.9), "brand-stores": reg("stores", 0.1) },
    signals: [sig("brand-revenue", [["full", 20]]), sig("brand-stores", [["thin", 10], ["full", 20]])],
  });
  const out = computeBoard(input, dims);
  const thin = out.entries.find((e) => e.slug === "thin")!;
  const full = out.entries.find((e) => e.slug === "full")!;
  assert.ok(thin.coverage < COVERAGE_MIN);
  assert.equal(thin.sampleInsufficient, true, "覆盖度过低标样本不足");
  assert.equal(full.sampleInsufficient, false, "全维在役实体不受影响");
});

test("rd8: percentile rank spreads the pool uniformly and the pool bottom is no longer pinned to zero", () => {
  // 分位名次归一（并列取平均名次）：四个值 → 12.5/37.5/62.5/87.5，均匀铺开；
  // min-max 的「池底恒 0」与「极值绑架中段」两个病在分位下同时消失（rd7 对数化只救中段）。
  // rd12 起本函数只服务商场体量分位（mallAdjustments.areaPct）——营收/门店/商场营收已改分层锚点。
  assert.deepEqual(percentileRank([1, 3, 20, 262.4]), [12.5, 37.5, 62.5, 87.5]);
  const tied = percentileRank([5, 5, 9]);
  assert.ok(Math.abs(tied[0]! - 100 / 3) < 1e-9 && tied[0] === tied[1], "并列取平均名次，同分同分位");
  assert.ok(Math.abs(tied[2]! - 250 / 3) < 1e-9);
});

test("rd12: tier anchors — 品牌门店边界组 0/200/201/600/601/999/1000/1001/5000 单调不减且锚点值精确", () => {
  // 命主第9条断点 200/600/1000 + v4.3 裁「1000 家及以上满值」：恰 1000→100 分，999→1000 为断点跳变（999≈74.94）。
  const stores = [0, 200, 201, 600, 601, 999, 1000, 1001, 5000].map((v) => tierAnchoredScore("brand-stores", v)!);
  assert.deepEqual(stores, [0, 25, 25.0625, 50, 50.0625, 74.9375, 100, 100, 100]);
  for (let i = 1; i < stores.length; i++) assert.ok(stores[i]! >= stores[i - 1]!, "门店锚点单调不减");
  near(tierAnchoredScore("brand-stores", 100)!, 12.5, "首锚之前 0→0.25 线性");
  near(tierAnchoredScore("brand-stores", 400)!, 37.5, "段内按实际值线性插值");
  assert.equal(tierAnchoredScore("brand-stores", -5)!, 0, "负值钳到 0");

  // 命主第10条：品牌营收 3/5/10/20 亿→25/50/75/100 分，<3 亿线性 0~25，20 亿及以上封顶（锚点即满值点，v4.3 零行为变化）。
  assert.deepEqual([0, 3, 5, 10, 20, 20.1, 108].map((v) => tierAnchoredScore("brand-revenue", v)!), [0, 25, 50, 75, 100, 100, 100]);
  near(tierAnchoredScore("brand-revenue", 17.5)!, 93.75, "戴维贝拉 17.5 亿落在 10~20 亿段内插值");
  near(tierAnchoredScore("brand-revenue", 1.5)!, 12.5);

  // v4.7（命主 2026-10-03 直令定稿）：商场营收六档连续插值——10/20/50/150/200/250 亿→20/40/60/80/90/100 分，
  // 下一档最低分=上一档最高分（档间连续），档内线性涨至档顶，250 亿及以上满分。
  const mallTiers = [0, 10, 20, 50, 150, 200, 250, 262.4].map((v) => tierAnchoredScore("mall-revenue", v)!);
  assert.deepEqual(mallTiers, [0, 20, 40, 60, 80, 90, 100, 100]);
  for (let i = 1; i < mallTiers.length; i++) assert.ok(mallTiers[i]! >= mallTiers[i - 1]!, "商场营收档位单调不减");
  near(tierAnchoredScore("mall-revenue", 25)!, 130 / 3, "命主例子：25 亿落 20~50 亿档 = 40+20×(25-20)/(50-20) ≈ 43.33");
  near(tierAnchoredScore("mall-revenue", 12)!, 24, "实测中位数 12 亿落 10~20 亿档（20+20×2/10）");

  assert.equal(tierAnchoredScore("brand-volume", 10), null, "非锚点指标返回 null（走池内归一）");
  assert.equal(Object.keys(TIER_ANCHORS).length, 3, "锚点表恰为营收/门店/商场营收三指标");
});

test("v4.8: mall affinity scores by distinct co-occurring brands — 10 points each, capped at 100", () => {
  // 命主 2026-10-03 直令：每有一个榜内品牌+10 分，满分 100（10 个品牌及以上满分）。
  assert.deepEqual([0, 1, 5, 9, 10, 15, -3].map((v) => affinityBrandScore(v)), [0, 10, 50, 90, 100, 100, 0]);
  for (let i = 1; i <= 20; i++) assert.ok(affinityBrandScore(i) >= affinityBrandScore(i - 1), "亲和档位单调不减");
  // 绝对口径：同值同分——池内新增/剔除实体不改变他人亲和分。
  const dims: DimensionSpec[] = [{ key: "affinity", name: "亲和", weight: 1, metrics: ["mall-affinity"], logScale: false }];
  const scored = dimensionScores(
    boardInput({ registry: { "mall-affinity": reg("affinity", 1) }, signals: [sig("mall-affinity", [["tiny", 1], ["mid", 5], ["giant", 12]])] }),
    dims,
  );
  assert.deepEqual([...scored.get("affinity")!].map(([, v]) => v), [10, 50, 100], "1/5/12 品牌 → 10/50/100 分（v4.8）");
  const plusPool = dimensionScores(
    boardInput({ registry: { "mall-affinity": reg("affinity", 1) }, signals: [sig("mall-affinity", [["tiny", 1], ["mid", 5], ["giant", 12], ["extra", 7]])] }),
    dims,
  );
  assert.equal(plusPool.get("affinity")!.get("mid")!, 50, "池内新增实体不改变既有实体亲和分（绝对口径）");
});

test("rd12: tier-anchored metrics are absolute (pool-independent) and pass through dimensionScores", () => {
  // 绝对口径：同值同分——池内新增/剔除实体不再改变他人营收/门店分（对照 rd8 分位的池内相对性）。
  const dims: DimensionSpec[] = [{ key: "revenue", name: "业绩", weight: 1, metrics: ["mall-revenue"], logScale: true }];
  const scored = dimensionScores(
    boardInput({ registry: { "mall-revenue": reg("revenue", 1) }, signals: [sig("mall-revenue", [["tiny", 1], ["small", 3], ["mid", 20], ["giant", 262.4]])] }),
    dims,
  );
  const absScores = [...scored.get("revenue")!].map(([, v]) => v);
  near(absScores[0]!, 2, "1 亿=20×1/10（v4.7，near 容差吞浮点尾差）");
  assert.equal(absScores[1]!, 6, "3 亿=6 分（v4.7）");
  assert.equal(absScores[2]!, 40, "20 亿恰 10~20 亿档顶=40 分（v4.7）");
  assert.equal(absScores[3]!, 100, "262.4 亿≥250 亿满分");
  const plusPool = dimensionScores(
    boardInput({ registry: { "mall-revenue": reg("revenue", 1) }, signals: [sig("mall-revenue", [["tiny", 1], ["small", 3], ["mid", 20], ["giant", 262.4], ["extra", 45]])] }),
    dims,
  );
  assert.equal(plusPool.get("revenue")!.get("small")!, 6, "池内新增实体不改变既有实体分数（绝对口径；3 亿=6 分 v4.7）");
  near(plusPool.get("revenue")!.get("extra")!, 170 / 3, "45 亿落 20~50 亿档 = 40+20×25/30 ≈ 56.67（v4.7）");
  // logScale 开关与锚点计分无关（口径一致性自证）。
  const plain = dimensionScores(
    boardInput({ registry: { "mall-revenue": reg("revenue", 1) }, signals: [sig("mall-revenue", [["tiny", 1], ["small", 3]])] }),
    [{ key: "revenue", name: "业绩", weight: 1, metrics: ["mall-revenue"], logScale: false }],
  );
  assert.equal(plain.get("revenue")!.get("small")!, 6, "3 亿=20×3/10=6 分（v4.7），logScale 开关与锚点计分无关");
});

test("rd7: a board-wide idle dimension rolls out and its weight is shared proportionally", () => {
  // media 两实体都低于提及门槛 → 维度全榜空转 → 滚出权重体系（v4.6 定稿权重 50/30/10/10，
  // totalWeight=0.50+0.30+0.10=0.90）。v4.8 起亲和摘提及门槛（每品牌 10 分绝对档）不再可能空转，
  // 空转制造者改用 media。m1 三维在役：营收 300 亿满分 100、客流 100、亲和 3 品牌=30 分。
  const dims = MALL_DIMENSIONS;
  const input = boardInput({
    board: "mall",
    registry: {
      "mall-footfall": reg("footfall", 0.3),
      "mall-affinity": reg("affinity", 0.1),
      "mall-revenue": reg("revenue", 0.5),
      "mall-media": reg("media", 0.1),
    },
    signals: [
      sig("mall-footfall", [["m1", 10], ["m2", 5]]),
      sig("mall-affinity", [["m1", 3], ["m2", 0]]),
      sig("mall-revenue", [["m1", 300], ["m2", 50]]),
      sig("mall-media", [["m1", MENTION_MIN - 1], ["m2", MENTION_MIN - 1]]),
    ],
  });
  const out = computeBoard(input, dims);
  const m1 = out.entries.find((e) => e.slug === "m1")!;
  const m2 = out.entries.find((e) => e.slug === "m2")!;
  assert.equal(m1.coverage, 1, "空转维滚出后全维实体覆盖度=1");
  // m1=(0.50×100+0.30×100+0.10×30)÷0.90=92.22…→92.2（营收 ≥250 亿满分；亲和 3 品牌=30 分）
  assert.equal(m1.score, 92.2);
  // m2：营收 50 亿→恰 50~150 亿档顶 60 分 → (0.50×60+0.30×0+0.10×0)÷0.90=33.33…→33.3；
  // 客流 5 是池底 min-max 0 分（层级值仍线性归一），0 分但有值仍占在役权重；亲和 0 品牌=0 分（有行实测，不垫底）。
  assert.equal(m2.score, 33.3, "营收档顶 60 分（50 亿恰档顶）+亲和 0 品牌计 0，媒体空转");
  assert.equal(m2.coverage, 1, "m2 客流(0 分但有值)/营收/亲和三维全有效：0.90÷0.90=1");
  assert.ok(!("media" in out.tiers), "空转维度滚出置信级披露");
  assert.ok(!("media" in m1.dimensions), "空转维度不再出现在维度分里");
});

test("rd7: value-level revenue tier overrides the dimension badge per entity", () => {
  // 营收值级成色：annual 行→report 档、estimate 行→seed 档，仅覆盖带值级行的实体。
  const input = boardInput({
    board: "mall",
    registry: {
      "mall-footfall": reg("footfall", 0.3, "manual-supplement", "seed"),
      "mall-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
      "mall-affinity": reg("affinity", 0.1, "internal-signal", "machine"),
      "mall-media": reg("media", 0.1, "internal-signal", "machine"),
    },
    signals: [
      sig("mall-footfall", [["m1", 8], ["m2", 6], ["m3", 4]]),
      valueSig("mall-revenue", [["m1", 242, "report"], ["m2", 30, "seed"], ["m3", 10, "seed"]]),
      sig("mall-affinity", [["m1", MENTION_MIN], ["m2", MENTION_MIN], ["m3", MENTION_MIN]]),
      sig("mall-media", [["m2", MENTION_MIN]]),
    ],
  });
  const out = computeBoard(input, MALL_DIMENSIONS);
  assert.equal(out.tiers.revenue, "report", "榜级营收档取在役指标最高档");
  assert.equal(out.entityTiers.m1?.revenue, "report", "annual 行=研报提取档");
  assert.equal(out.entityTiers.m2?.revenue, "seed", "estimate 行=人工档");
  assert.equal(out.entityTiers.m1?.footfall, "seed", "其余维度沿用榜级档");
});

test("rd8: conditional fill backfills missing revenue by tier median with infer tier (truth wins)", () => {
  // 商场缺营收按同客流档取 log 空间中位数填充：tier-10 池 [100,50] → expm1(median(log1p)) = √(101×51) ≈ 71.77；
  // tier-5 池 [10] → 10。填充行 tier=infer；有真值的实体不产生填充行（真值入场自动覆盖是结构性保证）。
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2", "m3", "m4", "m5"],
    facts: {
      m1: { footfallTier: 10 }, m2: { footfallTier: 10 }, m3: { footfallTier: 10 },
      m4: { footfallTier: 5 }, m5: { footfallTier: 5 },
    },
    registry: { "mall-revenue": reg("revenue", 0.4, "manual-supplement", "report") },
    signals: [
      sig("mall-footfall", [["m1", 10], ["m2", 10], ["m3", 10], ["m4", 5], ["m5", 5]]),
      sig("mall-revenue", [["m1", 100], ["m2", 50], ["m4", 10]]),
    ],
  });
  const filled = fillMissingRevenue(input);
  assert.equal(filled, 2, "缺营收的 m3/m5 各补一行");
  const rows = input.signals.find((s) => s.key === "mall-revenue")!.rows;
  const m3 = rows.find((r) => r.modelSlug === "m3")!;
  const m5 = rows.find((r) => r.modelSlug === "m5")!;
  assert.equal(m3.tier, "infer", "填充值带 infer 角标");
  assert.ok(Math.abs(m3.score - (Math.sqrt(101 * 51) - 1)) < 0.01, "同档 log 空间中位数填充（几何均值 −1）");
  assert.ok(Math.abs(m5.score - 10) < 1e-9, "tier-5 池只有真值 10，中位数=10");
  assert.equal(rows.filter((r) => r.modelSlug === "m1").length, 1, "有真值实体不产生填充行");
  const out = computeBoard(input, MALL_DIMENSIONS);
  assert.equal(out.entityTiers.m3?.revenue, "infer", "填充实体营收维角标=推断填充");
  assert.ok(out.entries.find((e) => e.slug === "m3")!.dimensions.revenue != null, "填充后营收维有分（缺数不罚零）");
});

test("rd8: brand fill uses the stores quintile band; empty bands and store-less brands stay unfilled", () => {
  // 品牌缺营收按同门店量级带（log 分位五带）中位数填充；同带无真值参考、或门店本身缺数的品牌，不填充。
  // 门店 10..100 十档 → 分位切点 30/50/70/90：band1={30,40} band2={50,60} band3={70,80} band4={90,100}，
  // band0={10,20} 无真值。真值：b03=40、b05=60、b07=80、b09=100 → 同带缺数者取该带中位数。
  const stores: Array<[string, number]> = ["b01", "b02", "b03", "b04", "b05", "b06", "b07", "b08", "b09", "b10"].map((s, i) => [s, (i + 1) * 10]);
  const input = boardInput({
    models: [...stores.map(([s]) => s), "b11"],
    registry: { "brand-revenue": reg("revenue", 0.5, "manual-supplement", "report"), "brand-stores": reg("stores", 0.3, "manual-supplement", "seed") },
    signals: [
      sig("brand-stores", stores),
      sig("brand-revenue", [["b03", 40], ["b05", 60], ["b07", 80], ["b09", 100]]),
    ],
  });
  const filled = fillMissingRevenue(input);
  assert.equal(filled, 4, "同带缺数者 b04/b06/b08/b10 各补一行");
  const rows = input.signals.find((s) => s.key === "brand-revenue")!.rows;
  const of = (slug: string) => rows.find((r) => r.modelSlug === slug);
  assert.equal(of("b04")?.tier, "infer");
  assert.ok(Math.abs(of("b04")!.score - 40) < 1e-9, "b04 取 band1 真值中位数 40");
  assert.ok(Math.abs(of("b10")!.score - 100) < 1e-9, "b10 取 band4 真值中位数 100");
  assert.equal(of("b01"), undefined, "band0 无真值参考：不凭空造数");
  assert.equal(of("b11"), undefined, "无门店量级的品牌保持缺数计零");
});

test("rd8: confidence discount — same dimension score, different tiers, different contribution", () => {
  // 成色折价进分数：营收同值（v4.7 锚点下 100 亿同=70 分，50~150 亿档中点）的两家商场，annual(report 0.85) 与 estimate(seed 0.7) 得分不同。
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2"],
    registry: { "mall-revenue": reg("revenue", 1, "manual-supplement", "report") },
    signals: [valueSig("mall-revenue", [["m1", 100, "report"], ["m2", 100, "seed"]])],
  });
  const out = computeBoard(input, [{ key: "revenue", name: "业绩", weight: 1, metrics: ["mall-revenue"], logScale: false }]);
  const m1 = out.entries.find((e) => e.slug === "m1")!;
  const m2 = out.entries.find((e) => e.slug === "m2")!;
  assert.equal(m1.dimensions.revenue, m2.dimensions.revenue, "维度分同值同分（100 亿 v4.7=70 分）");
  assert.equal(m1.score, 59.5, "研报提取档 ×0.85（70×0.85）");
  assert.equal(m2.score, 49, "人工档 ×0.7——同分不同权");
  assert.notEqual(SOURCE_TIER_DISCOUNT.report, SOURCE_TIER_DISCOUNT.seed);
  assert.equal(SOURCE_TIER_DISCOUNT.infer, 0.5, "推断填充档折价 0.5");
});

test("rd8: area joins the footfall dimension as a 0.6/0.4 composite, missing area falls back to tier-only", () => {
  // 体量复合：档位归一分×0.6+体量 log 分位分×0.4。
  // 档位池 [10,5,5] → m1=100,m2=0,m3=0；体量池 [10,30] → m1=25,m2=75；m3 无体量回退档位全额。
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2", "m3"],
    facts: { m1: { area: 10 }, m2: { area: 30 }, m3: {} },
    registry: { "mall-footfall": reg("footfall", 0.25, "manual-supplement", "seed") },
    signals: [sig("mall-footfall", [["m1", 10], ["m2", 5], ["m3", 5]])],
  });
  const out = computeBoard(input, [{ key: "footfall", name: "客流", weight: 1, metrics: ["mall-footfall"], logScale: false }]);
  const dimsOf = (slug: string) => out.entries.find((e) => e.slug === slug)!.dimensions.footfall!;
  assert.equal(dimsOf("m1"), 100 * FOOTFALL_TIER_SHARE + 25 * (1 - FOOTFALL_TIER_SHARE), "档位 100 ×0.6 + 体量分位 25 ×0.4 = 70");
  assert.equal(dimsOf("m2"), 0 * FOOTFALL_TIER_SHARE + 75 * (1 - FOOTFALL_TIER_SHARE), "档位 0 + 体量分位 75 → 30");
  assert.equal(dimsOf("m3"), 0, "无体量回退档位全额（0），不参与体量分位池");
  assert.ok(2 / 3 >= FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE, "本例覆盖率 2/3 过 v4.4 闸（达标例，复合照常启用）");
});

test("v4.4: area composite coverage gate — below half the footfall dimension falls back to tier-only across the board", () => {
  // ym58 乙案闸（命主 2026-10-01 17:43 裁 d-rd8-area-composite-caliber）：有体量 1/4=25% < 50% → 复合整体不启用，
  // 有体量者 m1 也保持档位归一分（不再 0.6/0.4 复合成 70），全维度口径可比。
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2", "m3", "m4"],
    facts: { m1: { area: 10 }, m2: {}, m3: {}, m4: {} },
    registry: { "mall-footfall": reg("footfall", 0.25, "manual-supplement", "seed") },
    signals: [sig("mall-footfall", [["m1", 10], ["m2", 5], ["m3", 5], ["m4", 5]])],
  });
  const out = computeBoard(input, [{ key: "footfall", name: "客流", weight: 1, metrics: ["mall-footfall"], logScale: false }]);
  const dimsOf = (slug: string) => out.entries.find((e) => e.slug === slug)!.dimensions.footfall!;
  assert.ok(1 / 4 < FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE, "本例覆盖率 1/4 未达 v4.4 闸");
  assert.equal(dimsOf("m1"), 100, "未达线：有体量者回退档位全额 100（无体量复合的 70）");
  assert.equal(dimsOf("m2"), 0, "档位归一分不变");
});

test("rd8: affinity prior fills unmeasured malls (infer 0.5) and never overrides measured co-occurrence", () => {
  // 先验分档垫底（v4.8 起只兜底 mall-affinity 源整体缺席）：购物中心×中端=100、百货=50；
  // 实测在役商场（m3，有行即实测——v4.8 摘提及门槛）不被先验覆盖，5 品牌=50 分。
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2", "m3"],
    facts: {
      m1: { mallType: "购物中心", positioning: "中端" },
      m2: { mallType: "百货", positioning: "中端" },
      m3: { mallType: "购物中心", positioning: "高端" },
    },
    registry: { "mall-affinity": reg("affinity", 1, "internal-signal", "machine") },
    signals: [sig("mall-affinity", [["m3", 5]])],
  });
  const out = computeBoard(input, [{ key: "affinity", name: "亲和", weight: 1, metrics: ["mall-affinity"], logScale: false }]);
  const m1 = out.entries.find((e) => e.slug === "m1")!;
  const m2 = out.entries.find((e) => e.slug === "m2")!;
  const m3 = out.entries.find((e) => e.slug === "m3")!;
  assert.equal(m1.dimensions.affinity, 100, "先验 100 进维度分（原始 0-100 尺度）");
  assert.equal(m2.dimensions.affinity, 50, "百货先验 50");
  assert.equal(m3.dimensions.affinity, 50, "实测 5 品牌=50 分（v4.8 每品牌 10 分），不被先验（60）覆盖");
  assert.equal(m1.score, 50, "先验档成色折价 0.5");
  assert.equal(m2.score, 25);
  assert.equal(m3.score, 50, "实测 machine 档不折价");
  assert.equal(out.entityTiers.m1?.affinity, "infer", "先验垫底角标=推断填充");
  assert.equal(out.entityTiers.m3, undefined, "实测无值级行的实体回落榜级 tiers");
  assert.equal(out.tiers.affinity, "machine", "榜级亲和档=机器源（实测指标）");
  assert.equal(m3.coverage, 1, "缺失的亲和维不再借「全榜空转」滚出——先验让维度在役");
  assert.equal(affinityPrior("购物中心", "中低端"), 100, "中低端按大众向最高档");
  assert.equal(affinityPrior("奥特莱斯", "中端"), 40);
  assert.equal(affinityPrior(undefined, undefined), null, "未列组合不造先验");
});

test("rd8: score is recomputable from dimension scores × tier discount × weights", () => {
  // 验收即证据：成色折价后 mall-footfall(seed) 维贡献 ≠ mall-revenue(report) 同分数同权。
  const dims = MALL_DIMENSIONS.filter((d) => d.key === "footfall" || d.key === "revenue");
  const input = boardInput({
    board: "mall",
    models: ["m1", "m2"],
    registry: {
      "mall-footfall": reg("footfall", 0.3, "manual-supplement", "seed"),
      "mall-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
    },
    signals: [
      sig("mall-footfall", [["m1", 10], ["m2", 5]]),
      valueSig("mall-revenue", [["m1", 100, "report"], ["m2", 50, "seed"]]),
    ],
  });
  const out = computeBoard(input, dims);
  const m1 = out.entries.find((e) => e.slug === "m1")!;
  const total = 0.3 + 0.5;
  const expected = (0.3 * 100 * SOURCE_TIER_DISCOUNT.seed + 0.5 * 70 * SOURCE_TIER_DISCOUNT.report) / total;
  assert.equal(m1.score, Math.round(expected * 10) / 10, "总分=Σ(维度分×成色系数×权重)÷权重总和");
  const m2 = out.entries.find((e) => e.slug === "m2")!;
  const revM2 = tierAnchoredScore("mall-revenue", 50)!;
  const expected2 = (0.3 * 0 * SOURCE_TIER_DISCOUNT.seed + 0.5 * revM2 * SOURCE_TIER_DISCOUNT.seed) / total;
  assert.equal(m2.score, Math.round(expected2 * 10) / 10);
  assert.notEqual(0.3 * 100 * SOURCE_TIER_DISCOUNT.seed, 0.5 * 70 * SOURCE_TIER_DISCOUNT.report, "客流(seed)×0.30 的贡献 ≠ 业绩(report)×0.50");
});

test("rd8: facts participate in the input fingerprint (seed area/tier change must trigger a new run)", () => {
  const base = boardInput({ models: ["m1"], registry: { "mall-footfall": reg("footfall", 0.25) }, signals: [sig("mall-footfall", [["m1", 5]])] });
  const withFacts = { ...base, facts: { m1: { area: 10 } } };
  const withMoreArea = { ...base, facts: { m1: { area: 20 } } };
  const fp = (b: BoardInput) => inputFingerprint({ at: new Date(0), snapshotIds: [], boards: [b], evidence: {} });
  assert.notEqual(fp(base), fp(withFacts), "facts 首次入场改变指纹");
  assert.notEqual(fp(withFacts), fp(withMoreArea), "体量数值变化也改变指纹（否则判重短路会吞掉重算）");
  assert.equal(fp(withFacts), fp({ ...base, facts: { m1: { area: 10 } } }), "同输入幂等");
});

test("mall board: empty revenue rolls its weight to footfall; footfall-only mode ranks by footfall alone", () => {
  // 业绩源缺席 → 权重滚给客流（v4.6 定稿 0.30+0.50=0.80），实体级缺数按 v2 计零统一分母。
  const dims = MALL_DIMENSIONS;
  const inputMall: BoardInput = boardInput({
    board: "mall",
    mode: "weighted",
    registry: {
      "mall-footfall": reg("footfall", 0.3),
      "mall-media": reg("media", 0.1),
      "mall-affinity": reg("affinity", 0.1),
    },
    signals: [
      sig("mall-footfall", [["m1", 10], ["m2", 5]]),
      sig("mall-media", [["m1", MENTION_MIN], ["m2", MENTION_MIN]]),
      sig("mall-affinity", [["m1", 10]]),
    ],
  });
  const out = computeBoard(inputMall, dims);
  assert.equal(out.mode, "weighted");
  assert.equal(out.entries[0]!.slug, "m1");
  const rolledDims: DimensionSpec[] = [
    { ...MALL_DIMENSIONS.find((d) => d.key === "footfall")!, weight: 0.8 },
    { ...MALL_DIMENSIONS.find((d) => d.key === "affinity")! },
    { ...MALL_DIMENSIONS.find((d) => d.key === "media")! },
  ];
  const viaEngine = computeBoards({ at: new Date(), snapshotIds: [], boards: [{ ...inputMall, dims: rolledDims }], evidence: {} })[0]!;
  assert.equal(viaEngine.entries.find((e) => e.slug === "m1")!.score, 100, "滚客流后 m1 满维满分（客流80+亲和10+声量10）");
  assert.equal(viaEngine.entries.find((e) => e.slug === "m2")!.score, 10, "滚客流后 m2 只有声量贡献（亲和缺数计零）");
  assert.equal(viaEngine.entries[0]!.slug, "m1");

  // footfall-only 降级：只按客流维度排，其余维度不进权重。
  const degraded: BoardInput = boardInput({
    board: "mall",
    mode: "footfall-only",
    registry: { "mall-footfall": reg("footfall", 1) },
    signals: [sig("mall-footfall", [["m1", 10], ["m2", 5], ["m3", 8]])],
  });
  const out2 = computeBoard(degraded, dims);
  assert.equal(out2.mode, "footfall-only");
  assert.deepEqual(out2.entries.map((e) => e.slug), ["m1", "m3", "m2"]);
  assert.equal(out2.entries[0]!.coverage, 1, "直榜覆盖度按 1 展示");
  assert.deepEqual(Object.keys(out2.entries[0]!.dimensions), ["footfall"], "直榜只计客流维度");
});

test("M1 regression: winshang snapshot presence upgrades the mall board out of footfall-only", () => {
  const footfall = MALL_DIMENSIONS.find((d) => d.key === "footfall")!;
  const machine = footfall.metrics.filter((m) => MALL_FOOTFALL_MACHINE_METRICS.has(m));
  assert.deepEqual(machine, ["winshang-mall"], "winshang-mall 必须挂在 footfall 维度 metrics 里");
  assert.ok(footfall.metrics.includes("mall-footfall"), "人工客流种子仍在维度定义中");

  const dims = MALL_DIMENSIONS.map((d) => (d.key === "footfall" ? { ...d, metrics: ["winshang-mall"] } : d));
  const input: BoardInput = boardInput({
    board: "mall",
    mode: "weighted",
    registry: { "winshang-mall": reg("footfall", 0.25) },
    signals: [sig("winshang-mall", [["m1", 500], ["m2", 300]])],
  });
  const out = computeBoard(input, dims);
  assert.equal(out.mode, "weighted");
  assert.equal(out.entries[0]!.slug, "m1");
  assert.equal(out.entries[0]!.dimensions.footfall, 100);
});

test("weights: v4.6 定稿 brand 50/30/20（业绩置首）; mall 50/30/10/10（业绩第一、首店已取消）", () => {
  const sum = (xs: DimensionSpec[]) => xs.reduce((a, d) => a + d.weight, 0);
  assert.equal(Math.round(sum(BRAND_DIMENSIONS) * 100), 100, "品牌榜 50/30/20");
  assert.equal(Math.round(sum(MALL_DIMENSIONS) * 100), 100, "商业体榜 50/30/10/10");
  assert.equal(BRAND_DIMENSIONS[0]!.key, "revenue", "品牌榜业绩置首");
  assert.equal(Math.round(BRAND_DIMENSIONS.find((d) => d.key === "revenue")!.weight * 100), 50, "品牌业绩 50");
  assert.equal(MALL_DIMENSIONS[0]!.key, "revenue", "商场榜业绩置首");
  assert.equal(Math.round(MALL_DIMENSIONS.find((d) => d.key === "revenue")!.weight * 100), 50, "商场业绩 50");
  assert.equal(Math.round(MALL_DIMENSIONS.find((d) => d.key === "footfall")!.weight * 100), 30, "客流 30");
  assert.equal(Math.round(MALL_DIMENSIONS.find((d) => d.key === "media")!.weight * 100), 10, "声量 10");
  assert.equal(Math.round(MALL_DIMENSIONS.find((d) => d.key === "affinity")!.weight * 100), 10, "亲和 10");
  assert.ok(!MALL_DIMENSIONS.some((d) => d.key === "firststore"), "首店快闪维已取消（v4.6）");
});

test("rd12: expansion dimension removed from the scoring face (zero residual)", async () => {
  assert.ok(!("brand-expansion" in METRIC_OPERATORS), "METRIC_OPERATORS 无 brand-expansion");
  assert.ok(!MENTION_GATED_METRICS.has("brand-expansion"), "提及门槛集无 brand-expansion");
  assert.ok(!("brand-expansion" in METRIC_SOURCE_TIER), "置信级映射无 brand-expansion");
  assert.ok(!BRAND_DIMENSIONS.some((d) => d.key === "expansion" || d.metrics.includes("brand-expansion")), "品牌维度无扩张");
  const { SOURCE_GROUPS } = await import("@aihot/backend/leaderboard/registry");
  assert.ok(
    SOURCE_GROUPS.every((g) => !g.key.includes("expansion") && !g.name.includes("扩张") && g.sources.every((s) => !s.key.includes("expansion"))),
    "来源登记分组无扩张残留",
  );
  // 第8条展示拆分：业绩与规模为两个独立分组面板（不再是合并组）。
  // T13（ym246）：分组标题不再带权重百分比副本（权重正本=方法页本轮 run 投影），两组独立的语义断言保留。
  const names = SOURCE_GROUPS.map((g) => g.name);
  assert.ok(names.includes("品牌榜 · 业绩") && names.includes("品牌榜 · 规模"), "业绩/规模两组独立");
  assert.ok(!names.some((n) => n.includes("业绩与规模")), "合并组已消除");
  assert.ok(!names.some((n) => /[（(]\d+%[）)]/.test(n)), "分组标题无权重百分比副本（T13）");
});

test("rd4/rd8: every metric carries a source tier; mall revenue=report, footfall seed, winshang machine", () => {
  for (const m of Object.keys(METRIC_OPERATORS)) {
    assert.ok(METRIC_SOURCE_TIER[m], `${m} 缺置信级映射`);
  }
  assert.equal(METRIC_SOURCE_TIER["mall-revenue"], "report", "联商网营收盘点=研报提取档");
  assert.equal(METRIC_SOURCE_TIER["mall-footfall"], "seed", "人工客流层级=人工种子档");
  assert.equal(METRIC_SOURCE_TIER["winshang-mall"], "machine", "机器客流源=机器源档");
});

test("rd4: board output discloses per-dimension tiers (best live metric wins)", () => {
  const input: BoardInput = boardInput({
    board: "mall",
    mode: "weighted",
    registry: {
      "mall-footfall": reg("footfall", 0.3, "manual-supplement", "seed"),
      "mall-affinity": reg("affinity", 0.1, "internal-signal", "machine"),
      "mall-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
      "mall-media": reg("media", 0.1, "internal-signal", "machine"),
    },
    signals: [
      sig("mall-footfall", [["m1", 8], ["m2", 6]]),
      sig("mall-affinity", [["m1", MENTION_MIN], ["m2", MENTION_MIN]]),
      sig("mall-revenue", [["m1", 100], ["m2", 50]]),
      sig("mall-media", [["m2", MENTION_MIN]]),
    ],
  });
  const out = computeBoard(input, MALL_DIMENSIONS);
  assert.equal(out.mode, "weighted");
  assert.equal(out.tiers.revenue, "report");
  assert.equal(out.tiers.footfall, "seed");
  assert.equal(out.tiers.affinity, "machine");
  assert.equal(out.tiers.media, "machine");
});

test("ties order by slug deterministically (no revenue data anywhere)", () => {
  const dims: DimensionSpec[] = [{ key: "stores", name: "规模", weight: 1, metrics: ["brand-stores"], logScale: false }];
  const input = boardInput({
    registry: { "brand-stores": reg("stores", 1) },
    signals: [sig("brand-stores", [["b-brand", 50], ["a-brand", 50]])],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.entries.map((e) => e.slug), ["a-brand", "b-brand"]);
});

test("v4.5: tied totals order by raw revenue before slug (anchor cap keeps 25.8亿 and 30亿 both at 100)", () => {
  // 2026-10-02 命主令实锚场景：361°kids（营收 25.8 亿）与泰兰尼斯（30 亿）门店都过 1000 家满值锚点、
  // 维度分同为 100/100、声量同缺 → 总分并列；v4.4 按 slug 字典序让 361 在前，v4.5 改按原始业绩概数定序。
  const dims: DimensionSpec[] = [
    { key: "revenue", name: "业绩", weight: 0.5, metrics: ["brand-revenue"], logScale: false },
    { key: "stores", name: "规模", weight: 0.3, metrics: ["brand-stores"], logScale: false },
  ];
  const input = boardInput({
    models: ["361-kids", "taranis"],
    registry: {
      "brand-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
      "brand-stores": reg("stores", 0.3, "manual-supplement", "seed"),
    },
    signals: [
      sig("brand-revenue", [["361-kids", 25.8], ["taranis", 30]]),
      sig("brand-stores", [["361-kids", 1000], ["taranis", 1000]]),
    ],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.entries.map((e) => e.slug), ["taranis", "361-kids"], "同分按原始业绩：30 亿在前");
  assert.equal(out.entries[0]!.score, out.entries[1]!.score, "两实体总分确实并列");
});

test("v4.5: tied totals — revenue-less entity ranks behind a valued one (both scored, null never subtracts)", () => {
  // 两实体都进计分区（shoumen P3 整改：原用例一方走 rest 尾追路径，对排序回归无判别力）：
  // 声量同分 → 总分并列；z-brand 有营收真值行（真值 0 也算有值）、a-brand 无营收行——
  // 字典序 a<z 本应 a 先（纯 slug 回归本测试会红），v4.5 定序按业绩真值让 z-brand 在前；
  // null 不与数值相减（NaN 防护）。
  const dims: DimensionSpec[] = [
    { key: "volume", name: "声量", weight: 1, metrics: ["brand-volume"], logScale: false },
  ];
  const input = boardInput({
    models: ["z-brand", "a-brand"],
    registry: { "brand-volume": reg("volume", 1) },
    signals: [
      sig("brand-volume", [["z-brand", 10], ["a-brand", 10]]),
      sig("brand-revenue", [["z-brand", 0]]),
    ],
  });
  const out = computeBoard(input, dims);
  assert.equal(out.entries[0]!.score, out.entries[1]!.score, "两实体总分确实并列（营收行不在 registry 不进计分）");
  assert.deepEqual(out.entries.map((e) => e.slug), ["z-brand", "a-brand"], "有业绩真值者在前（字典序本应 a 先）");
});

test("v4.5: infer-filled revenue does not participate in tie ordering (fills never outrank truth)", () => {
  // shoumen P1 整改判别测试：总分并列（声量同分）；a-fill 只有推断填充营收行（71.77 亿概数）、
  // b-truth 有真值营收行（30 亿）——填充值若参与定序会压过真值。字典序 a<b 本应 a-fill 先，
  // v4.5 定序只认真值 → b-truth 在前（改回「填充参与」或「纯 slug 序」本测试都会红）。
  const dims: DimensionSpec[] = [{ key: "volume", name: "声量", weight: 1, metrics: ["brand-volume"], logScale: false }];
  const input = boardInput({
    models: ["a-fill", "b-truth"],
    registry: { "brand-volume": reg("volume", 1) },
    signals: [
      sig("brand-volume", [["a-fill", 10], ["b-truth", 10]]),
      { key: "brand-revenue", rows: [
        { modelSlug: "a-fill", score: 71.77, lowerBound: null, upperBound: null, configuration: "", tier: "infer" },
        { modelSlug: "b-truth", score: 30, lowerBound: null, upperBound: null, configuration: "" },
      ] },
    ],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.entries.map((e) => e.slug), ["b-truth", "a-fill"], "填充值不参与定序，真值在前");
});

test("rd7/rd8 smoke: method version v4, window 90 days, thresholds unchanged, engine keeps five metrics", async () => {
  const { SIGNAL_WINDOW_DAYS } = await import("@aihot/backend/leaderboard/method/weighted");
  const { internalSignal } = await import("@aihot/backend/leaderboard/fetch/sources/internal-signal");
  assert.equal(METHOD_VERSION, "2026.10-weighted-v4.8", "v4.8 ym155 亲和每品牌10分封顶100（营收六档承 v4.7；权重承 v4.6 定值 50/30/10/10、首店快闪维取消）");
  assert.equal(SIGNAL_WINDOW_DAYS, 90, "声量窗口 90 天（rd7 全文级标注口径）");
  assert.equal(MENTION_MIN, 3, "rd8 门槛不动");
  assert.equal(COVERAGE_MIN, 0.3, "rd8 门槛不动");
  assert.deepEqual([...internalSignal.sourceKeys].sort(), ["brand-expansion", "brand-volume", "mall-affinity", "mall-firststore", "mall-media"]);
});

test("ym57: voice-insufficient entity with no other live dimension stays on the board at the tail", () => {
  const dims: DimensionSpec[] = [
    { key: "volume", name: "媒体声量", weight: 0.2, metrics: ["brand-volume"], logScale: true },
    { key: "revenue", name: "业绩", weight: 0.4, metrics: ["brand-revenue"], logScale: true },
  ];
  const input = boardInput({
    models: ["loud-brand", "rev-only-brand", "quiet-brand"],
    registry: { "brand-volume": reg("volume", 0.2), "brand-revenue": reg("revenue", 0.4) },
    signals: [
      sig("brand-volume", [["loud-brand", 10], ["rev-only-brand", 1], ["quiet-brand", 2]]),
      sig("brand-revenue", [["rev-only-brand", 5]]),
    ],
  });
  const out = computeBoard(input, dims);
  const byslug = Object.fromEntries(out.entries.map((e) => [e.slug, e]));
  // quiet-brand 声量 2<3 被剔出声量维且无其他在役维：ym57 前整榜除名，现必须保留在榜尾
  assert.ok(byslug["quiet-brand"], "声量不足且无他维的实体必须保留在榜（ym57 命主令）");
  assert.equal(byslug["quiet-brand"]!.rank, 3);
  assert.equal(byslug["quiet-brand"]!.score, 0);
  assert.equal(byslug["quiet-brand"]!.coverage, 0);
  assert.equal(byslug["quiet-brand"]!.sampleInsufficient, true);
  // 计分区名次：loud（声量 100×0.2）与 rev-only（营收 5 亿→锚点 50 分×0.4）同分 33.3；v4.5 并列定序
  // 改按原始业绩：rev-only 有营收数据（5 亿）在前，loud 无业绩数据排后（v4.4 时代按 slug loud 先）。
  assert.equal(byslug["rev-only-brand"]!.rank, 1);
  assert.equal(byslug["loud-brand"]!.rank, 2);
  assert.deepEqual(out.entries.map((e) => e.sampleInsufficient), [false, false, true]);
});

// ── T13（ym246）scoreBasis：本轮在役维度/计分分母披露，与 entries 复算同源 ──────────────────

test("T13: scoreBasis discloses effective dimensions & denominator when an idle dimension rolls out (AC2)", () => {
  // AC2 反例：brand 营收 20 亿（锚点满值 100，report 档 0.85）/ 门店 1000 家（满值 100，seed 档 0.7）/
  // 全榜声量 2 篇（< MENTION_MIN=3，声量维全榜空转滚出）→ 分母=0.5+0.3=0.8，复算=算法输出而非静态 50/30/20 硬算。
  const dims: DimensionSpec[] = BRAND_DIMENSIONS; // revenue 0.5 / stores 0.3 / volume 0.2
  const input = boardInput({
    models: ["brand-a"],
    registry: {
      "brand-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
      "brand-stores": reg("stores", 0.3, "manual-supplement", "seed"),
      "brand-volume": reg("volume", 0.2, "internal-signal", "machine"),
    },
    signals: [
      sig("brand-revenue", [["brand-a", 20]]),
      sig("brand-stores", [["brand-a", 1000]]),
      sig("brand-volume", [["brand-a", 2]]), // 全榜低于提及门槛 → 声量维空转
    ],
  });
  const out = computeBoard(input, dims);
  // 有效维度与分母披露：声量滚出，只剩业绩/规模
  assert.deepEqual(out.scoreBasis.dimensions.map((d) => d.key), ["revenue", "stores"]);
  near(out.scoreBasis.totalWeight, 0.8);
  assert.deepEqual(out.scoreBasis.dimensions.map((d) => d.weight), [0.5, 0.3]);
  // 复算等式：sum(维度分×成色×权重)/totalWeight = 榜面分（round 到 1 位与实现一致）
  const sum = 0.5 * 100 * SOURCE_TIER_DISCOUNT.report + 0.3 * 100 * SOURCE_TIER_DISCOUNT.seed;
  near(out.entries[0]!.score, Math.round((sum / 0.8) * 10) / 10);
  // 静态权重复算（50/30/20 硬算、分母 1.0）≠ 榜面分——正是 D2 缺陷的反例锚
  assert.notEqual(out.entries[0]!.score, Math.round((sum / 1.0) * 10) / 10);
});

test("T13: scoreBasis keeps full dimension set and denominator 1.0 when all dimensions live", () => {
  const dims: DimensionSpec[] = BRAND_DIMENSIONS;
  const input = boardInput({
    models: ["brand-a", "brand-b"],
    registry: {
      "brand-revenue": reg("revenue", 0.5, "manual-supplement", "report"),
      "brand-stores": reg("stores", 0.3, "manual-supplement", "seed"),
      "brand-volume": reg("volume", 0.2, "internal-signal", "machine"),
    },
    signals: [
      sig("brand-revenue", [["brand-a", 20], ["brand-b", 5]]),
      sig("brand-stores", [["brand-a", 1000], ["brand-b", 600]]),
      sig("brand-volume", [["brand-a", 10], ["brand-b", 8]]),
    ],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.scoreBasis.dimensions.map((d) => d.key), ["revenue", "stores", "volume"]);
  near(out.scoreBasis.totalWeight, 1.0);
});

test("T13: scoreBasis is additive metadata — entries ordering/scores match pre-T13 expectations (AC3, regression net = existing suite)", () => {
  // 同输入下名次/分数与既有期望零漂移（scoreBasis 只增不改）。本用例复用 ym57 场景作双锚：
  const dims: DimensionSpec[] = [
    { key: "volume", name: "媒体声量", weight: 0.2, metrics: ["brand-volume"], logScale: true },
    { key: "revenue", name: "业绩", weight: 0.4, metrics: ["brand-revenue"], logScale: true },
  ];
  const input = boardInput({
    models: ["loud-brand", "rev-only-brand", "quiet-brand"],
    registry: { "brand-volume": reg("volume", 0.2), "brand-revenue": reg("revenue", 0.4) },
    signals: [
      sig("brand-volume", [["loud-brand", 10], ["rev-only-brand", 1], ["quiet-brand", 2]]),
      sig("brand-revenue", [["rev-only-brand", 5]]),
    ],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.entries.map((e) => [e.slug, e.rank]), [["rev-only-brand", 1], ["loud-brand", 2], ["quiet-brand", 3]]);
  assert.equal(out.entries[0]!.score, 33.3);
  near(out.scoreBasis.totalWeight, 0.6); // 两维均在役：分母=0.2+0.4（本 dims 定义权重和），名次/分数与既有期望零漂移
});
