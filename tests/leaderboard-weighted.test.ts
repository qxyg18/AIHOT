// weighted v3（rd4 业绩优先+数据置信级）纯函数测试：归一/门槛/缺数计零统一分母/业绩滚客流/直榜分支/置信级透传。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRAND_DIMENSIONS,
  COVERAGE_MIN,
  MALL_DIMENSIONS,
  MALL_FOOTFALL_MACHINE_METRICS,
  MENTION_MIN,
  METRIC_OPERATORS,
  METRIC_SOURCE_TIER,
  computeBoard,
  computeBoards,
  dimensionScores,
  type BoardInput,
  type DimensionSpec,
  type SourceTier,
} from "@aihot/backend/leaderboard/method/weighted";

const reg = (family: string, weight: number, operator = "test", tier: SourceTier = "machine") => ({ family, weight, operator, protocol: "test", direction: "HIGHER" as const, interval_sd: null, tier });
const sig = (key: string, entries: Array<[string, number]>) => ({ key, rows: entries.map(([modelSlug, score]) => ({ modelSlug, score, lowerBound: null, upperBound: null, configuration: "" })) });

function boardInput(o: Partial<BoardInput> & { registry: BoardInput["registry"]; signals: BoardInput["signals"] }): BoardInput {
  return { board: "brand", names: {}, models: [], mode: "weighted", ...o };
}

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
  // v2（命主 2026-09-30「业绩与规模不交叉参考」）：a 两维都有数；b 只有规模且是池内最高。
  // 旧 v1 实体级重归一下 b 总分=规模归一分 100 直接登顶；v2 统一分母后 b=0.3×100/0.5=60，
  // 缺声量维度计 0 贡献，不把权重摊给规模。
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
  // b 规模归一分=100（池内最高）但缺声量：总分=0.3×100/0.5=60，v1 重归一会得 100。
  assert.equal(b.score, 60);
  // a 声量满分+规模池内最低 0 分：总分=(0.2×100+0.3×0)/0.5=40。
  assert.equal(a.score, 40);
  assert.ok(out.entries[0]!.slug === "b");
  assert.ok(!b.sampleInsufficient);
});

test("coverage below COVERAGE_MIN flags sampleInsufficient", () => {
  const dims: DimensionSpec[] = [
    { key: "revenue", name: "业绩", weight: 0.9, metrics: ["brand-revenue"], logScale: false },
    { key: "stores", name: "规模", weight: 0.1, metrics: ["brand-stores"], logScale: false },
  ];
  const input = boardInput({
    registry: { "brand-stores": reg("stores", 0.1) },
    signals: [sig("brand-stores", [["thin", 10], ["full", 20]])],
  });
  const out = computeBoard(input, dims);
  for (const e of out.entries) {
    assert.ok(e.coverage < COVERAGE_MIN);
    assert.equal(e.sampleInsufficient, true, "覆盖度过低标样本不足");
  }
});

test("mall board: empty revenue rolls its weight to footfall; footfall-only mode ranks by footfall alone", () => {
  // 业绩源缺席 → 权重滚给客流（甲案 v3：footfall 0.3+0.3=0.6，命主定稿维度级条款），实体级缺数按 v2 计零统一分母。
  const dims = MALL_DIMENSIONS;
  const inputMall: BoardInput = boardInput({
    board: "mall",
    mode: "weighted",
    registry: {
      "mall-footfall": reg("footfall", 0.5),
      "mall-media": reg("media", 0.15),
      "mall-affinity": reg("affinity", 0.2),
      "mall-firststore": reg("firststore", 0.15),
    },
    signals: [
      sig("mall-footfall", [["m1", 10], ["m2", 5]]),
      sig("mall-media", [["m1", MENTION_MIN], ["m2", MENTION_MIN]]),
      sig("mall-affinity", [["m1", MENTION_MIN]]),
      sig("mall-firststore", [["m2", MENTION_MIN]]),
    ],
  });
  const out = computeBoard(inputMall, dims);
  assert.equal(out.mode, "weighted");
  assert.equal(out.entries[0]!.slug, "m1");

  // rd4（shoumen P1-1 整改）：计分入口 computeBoards 必须吃滚动后的有效维度集。甲案下业绩整体
  // 缺数 → 客流系数 0.3+0.3=0.6：m1=(0.6×100+0.2×100+0.08×100)=88，m2=(0.12×100+0.08×100)=20；
  // 若滚动未进计分（仍用静态客流 0.3）m1=58，本断言对「滚客流是否进计分」有区分力。
  const rolledDims: DimensionSpec[] = [
    { ...MALL_DIMENSIONS.find((d) => d.key === "footfall")!, weight: 0.6 },
    { ...MALL_DIMENSIONS.find((d) => d.key === "affinity")! },
    { ...MALL_DIMENSIONS.find((d) => d.key === "firststore")! },
    { ...MALL_DIMENSIONS.find((d) => d.key === "media")! },
  ];
  const viaEngine = computeBoards({ at: new Date(), snapshotIds: [], boards: [{ ...inputMall, dims: rolledDims }], evidence: {} })[0]!;
  assert.equal(viaEngine.mode, "weighted");
  assert.equal(viaEngine.entries.find((e) => e.slug === "m1")!.score, 88, "滚客流后 m1 应为 0.6 加权体系的 88 分");
  assert.equal(viaEngine.entries.find((e) => e.slug === "m2")!.score, 20, "滚客流后 m2 只有首店+声量贡献");
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
  // 恢复通道（shoumen M1）：winshang-mall 属于 footfall 维度 metrics；人工种子与机器源
  // 同在时 buildWeightedInputs 只保留机器源。这里直接验证维度定义与机器集合的交集非空，
  // 以及机器源在场时维度取值只认 winshang（修复前交集恒空=恢复通道断裂）。
  const footfall = MALL_DIMENSIONS.find((d) => d.key === "footfall")!;
  const machine = footfall.metrics.filter((m) => MALL_FOOTFALL_MACHINE_METRICS.has(m));
  assert.deepEqual(machine, ["winshang-mall"], "winshang-mall 必须挂在 footfall 维度 metrics 里");
  assert.ok(footfall.metrics.includes("mall-footfall"), "降级期人工种子仍在维度定义中");

  // 维度计算层：只有 winshang 分数在场时，footfall 维度分由 winshang 归一产生。
  const dims = MALL_DIMENSIONS.map((d) => (d.key === "footfall" ? { ...d, metrics: ["winshang-mall"] } : d));
  const input: BoardInput = boardInput({
    board: "mall",
    mode: "weighted",
    registry: { "winshang-mall": reg("footfall", 0.35) },
    signals: [sig("winshang-mall", [["m1", 500], ["m2", 300]])],
  });
  const out = computeBoard(input, dims);
  assert.equal(out.mode, "weighted");
  assert.equal(out.entries[0]!.slug, "m1");
  assert.equal(out.entries[0]!.dimensions.footfall, 100);
});

test("brand dimension weights sum to the ruling fractions", () => {
  const sum = (xs: DimensionSpec[]) => xs.reduce((a, d) => a + d.weight, 0);
  assert.equal(Math.round(sum(BRAND_DIMENSIONS) * 100), 100, "品牌榜 20/40/30/10");
  assert.equal(Math.round(sum(MALL_DIMENSIONS) * 100), 100, "商业体榜 rd4 甲案 30/20/30/12/8");
  // rd4 乙案（挂决策看板 d-rd4-mall-weight-scheme 候命主）：25/20/35/12/8 同样满足权重和=1，
  // 命主拍板后改 MALL_DIMENSIONS 即可切换，本断言守住两案口径。
  assert.equal(Math.round((0.25 + 0.2 + 0.35 + 0.12 + 0.08) * 100), 100, "乙案 25/20/35/12/8");
});

test("rd4: every metric carries a source tier; mall revenue=report, footfall seed, winshang machine", () => {
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
      "mall-affinity": reg("affinity", 0.2, "internal-signal", "machine"),
      "mall-revenue": reg("revenue", 0.3, "manual-supplement", "report"),
      "mall-firststore": reg("firststore", 0.12, "internal-signal", "machine"),
      "mall-media": reg("media", 0.08, "internal-signal", "machine"),
    },
    signals: [
      sig("mall-footfall", [["m1", 8], ["m2", 6]]),
      sig("mall-affinity", [["m1", MENTION_MIN], ["m2", MENTION_MIN]]),
      sig("mall-revenue", [["m1", 100], ["m2", 50]]),
      sig("mall-firststore", [["m1", MENTION_MIN]]),
      sig("mall-media", [["m2", MENTION_MIN]]),
    ],
  });
  const out = computeBoard(input, MALL_DIMENSIONS);
  assert.equal(out.mode, "weighted");
  assert.equal(out.tiers.revenue, "report");
  assert.equal(out.tiers.footfall, "seed");
  assert.equal(out.tiers.affinity, "machine");
  assert.equal(out.tiers.firststore, "machine");
  assert.equal(out.tiers.media, "machine");
});

test("ties order by slug deterministically", () => {
  const dims: DimensionSpec[] = [{ key: "stores", name: "规模", weight: 1, metrics: ["brand-stores"], logScale: false }];
  const input = boardInput({
    registry: { "brand-stores": reg("stores", 1) },
    signals: [sig("brand-stores", [["b-brand", 50], ["a-brand", 50]])],
  });
  const out = computeBoard(input, dims);
  assert.deepEqual(out.entries.map((e) => e.slug), ["a-brand", "b-brand"]);
});
