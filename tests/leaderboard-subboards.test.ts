// rd9 子榜断言（纯函数 + 定义完整性）：分层互斥且合计=总榜实体数、带内排名与总榜分数序一致、
// 子榜词表与种子词表逐值对齐（词表漂移——如商场定位新增档——本测试即红）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOARD_SUBVIEWS,
  BOARD_SUBVIEW_EXCLUDED,
  bandBoardEntries,
  profileFieldValue,
  subViewByKey,
  subViewsOfBoard,
} from "@aihot/backend/leaderboard/registry";
import { LEADERBOARD_SUB_BOARD_KEYS } from "@aihot/contracts/taxonomy";

interface FixtureEntry {
  rank: number;
  score: number;
  band: string | null;
}
const valueOf = (entry: FixtureEntry) => entry.band;

// 夹具=总榜序（名次升序、分数非升），含同分、尾部队与档案缺失样本。
const BRAND_TOTAL: FixtureEntry[] = [
  { rank: 1, score: 89.8, band: "中端" },
  { rank: 2, score: 64.0, band: "大众" },
  { rank: 3, score: 47.7, band: "高端" },
  { rank: 4, score: 46.2, band: "中端" },
  { rank: 5, score: 41.6, band: "中高端" },
  { rank: 6, score: 18.4, band: "中端" },
  { rank: 7, score: 18.4, band: "大众" },
  { rank: 8, score: 2.1, band: "高端" },
  { rank: 9, score: 0, band: null },
];
const MALL_TOTAL: FixtureEntry[] = [
  { rank: 1, score: 90, band: "高端" },
  { rank: 2, score: 80, band: "中端" },
  { rank: 3, score: 70, band: "中高端" },
  { rank: 4, score: 60, band: "中低端" },
  { rank: 5, score: 50, band: "高端" },
  { rank: 6, score: 40, band: null },
];

test("brand sub-views: four bands are disjoint and sum to the total board", () => {
  const views = subViewsOfBoard("brand");
  assert.equal(views.length, 4);
  const picked = views.map((v) => bandBoardEntries(BRAND_TOTAL, valueOf, v.values));
  const sum = picked.reduce((n, rows) => n + rows.length, 0);
  assert.equal(sum, BRAND_TOTAL.filter((e) => e.band !== null).length, "四带实体数合计=总榜有档实体数");
  const seen = new Set<number>();
  for (const rows of picked) {
    for (const { overallRank } of rows) {
      assert.ok(!seen.has(overallRank), `名次 ${overallRank} 落进多个带`);
      seen.add(overallRank);
    }
  }
});

test("band rank follows the total-board score order and re-ranks 1..N", () => {
  const mid = bandBoardEntries(BRAND_TOTAL, valueOf, BOARD_SUBVIEWS["brand-mid"].values);
  assert.deepEqual(mid.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(mid.map((r) => r.overallRank), [1, 4, 6]);
  for (let i = 1; i < mid.length; i++) {
    assert.ok(mid[i - 1].entry.score >= mid[i].entry.score, "带内排名与总榜分数序一致");
  }
});

test("mall layers: premium + mainstream + value cover every positioned mall", () => {
  const premium = bandBoardEntries(MALL_TOTAL, valueOf, BOARD_SUBVIEWS["mall-premium"].values);
  const mainstream = bandBoardEntries(MALL_TOTAL, valueOf, BOARD_SUBVIEWS["mall-mainstream"].values);
  const value = bandBoardEntries(MALL_TOTAL, valueOf, BOARD_SUBVIEWS["mall-value"].values);
  assert.deepEqual(premium.map((r) => r.overallRank), [1, 5]);
  assert.deepEqual(mainstream.map((r) => r.overallRank), [2, 3]);
  // 命主 2026-10-01 17:51 看板乙案：中低端另立「大众平替榜」第三层，三层合计=总榜有档实体数。
  assert.deepEqual(value.map((r) => r.overallRank), [4]);
  assert.equal(premium.length + mainstream.length + value.length, MALL_TOTAL.filter((e) => e.band !== null).length, "三层合计=总榜有档实体数");
});

test("sub-view registry: keys resolve to their parent board, unknown keys rejected", () => {
  assert.equal(subViewByKey("brand-mass")?.board, "brand");
  assert.equal(subViewByKey("mall-mainstream")?.board, "mall");
  assert.equal(subViewByKey("mall-whatever"), null);
  assert.equal(subViewByKey("brand"), null);
  assert.equal(subViewsOfBoard("brand").length + subViewsOfBoard("mall").length, LEADERBOARD_SUB_BOARD_KEYS.length);
  assert.equal(subViewsOfBoard("mall").length, 3);
  assert.equal(subViewByKey("mall-value")?.name, "大众平替榜");
});

test("profileFieldValue: missing profile or field does not fall into any layer", () => {
  assert.equal(profileFieldValue(null, "priceBand"), null);
  assert.equal(profileFieldValue({ priceBand: null } as never, "priceBand"), null);
  assert.equal(profileFieldValue({ positioning: "高端" } as never, "positioning"), "高端");
});

test("sub-view word lists match the seed vocabulary exactly once per board (or are explicitly excluded)", () => {
  const brands = JSON.parse(readFileSync(new URL("../database/seeds/lb-brands-2026-10.json", import.meta.url), "utf8")) as {
    brands?: Array<{ priceBand?: string }>;
  };
  const malls = JSON.parse(readFileSync(new URL("../database/seeds/lb-malls-2026-10.json", import.meta.url), "utf8")) as {
    malls?: Array<{ positioning?: string }>;
  };
  const check = (board: "brand" | "mall", vocabulary: Set<string>) => {
    const views = subViewsOfBoard(board);
    const excluded = BOARD_SUBVIEW_EXCLUDED[board];
    for (const value of vocabulary) {
      const hits = views.filter((v) => v.values.includes(value)).length + (excluded.includes(value) ? 1 : 0);
      assert.equal(hits, 1, `${board} 词「${value}」必须恰落一个子榜或显式排除集`);
    }
    for (const view of views) {
      for (const value of view.values) assert.ok(vocabulary.has(value), `${board} 子榜词「${value}」不在种子词表`);
    }
    for (const value of excluded) assert.ok(vocabulary.has(value), `${board} 排除词「${value}」不在种子词表`);
  };
  check("brand", new Set((brands.brands ?? []).map((b) => b.priceBand).filter((v): v is string => !!v)));
  check("mall", new Set((malls.malls ?? []).map((m) => m.positioning).filter((v): v is string => !!v)));
});
// ── T13（ym246）：首店维退出在役不参排（AC4）+ 规则页来源 board 归属过滤（AC1 串源反例） ──────

test("T13: mall-firststore source registered as reference_only (retired dimension, not ranked) — AC4", () => {
  const registry = JSON.parse(readFileSync("packages/backend/src/leaderboard/source-registry.json", "utf8")) as {
    groups: Array<{ key: string; name: string; sources: Array<{ key: string; status: string; description: string; usage: string }> }>;
  };
  const fs = registry.groups.flatMap((g) => g.sources).find((s) => s.key === "mall-firststore");
  assert.ok(fs, "mall-firststore 登记存在");
  assert.equal(fs!.status, "reference_only", "首店维已退出在役，不参与排名");
  assert.ok(fs!.usage.includes("退出"), "usage 标注已退出在役维度");
  // 分组标题不带百分比副本（权重正本=方法页本轮 run 投影）
  for (const g of registry.groups) assert.ok(!/[（(]\d+%[）)]/.test(g.name), `分组标题不得带权重百分比副本：${g.name}`);
  // 亲和口径统一「去重品牌数」，不再称「共现次数」
  const aff = registry.groups.flatMap((g) => g.sources).find((s) => s.key === "mall-affinity");
  assert.ok(aff!.description.includes("去重"), "亲和 description 统一为共现去重品牌数口径");
});

test("T13: rules sources filter by board ownership — brand revenue never lists mall source, and vice versa (AC1)", async () => {
  const { runSourcesForBoard } = await import("@aihot/backend/leaderboard/read");
  // 模拟 run summary.sources：两榜各有 revenue 源（familyKey 同名）+ 无歧义源
  const sources = [
    { key: "brand-revenue", familyKey: "revenue", weight: 0.5, board: "brand" },
    { key: "mall-revenue", familyKey: "revenue", weight: 0.5, board: "mall" },
    { key: "brand-volume", familyKey: "volume", weight: 0.2, board: "brand" },
    { key: "mall-media", familyKey: "media", weight: 0.1, board: "mall" },
  ];
  const brandDims = new Set(["revenue", "stores", "volume"]);
  const mallDims = new Set(["revenue", "footfall", "media", "affinity"]);
  const brandSrc = runSourcesForBoard(sources, "brand", mallDims).map((s) => s.key);
  const mallSrc = runSourcesForBoard(sources, "mall", brandDims).map((s) => s.key);
  assert.deepEqual(brandSrc.sort(), ["brand-revenue", "brand-volume"], "品牌榜 revenue 维只列 brand-revenue（不串 mall-revenue）");
  assert.deepEqual(mallSrc.sort(), ["mall-media", "mall-revenue"], "商场榜 revenue 维只列 mall-revenue（不串 brand-revenue）");
  // 历史 run（sources 行缺 board 字段）：歧义 familyKey 宁缺勿串，无歧义照常收录
  const legacy = [
    { key: "brand-revenue", familyKey: "revenue", weight: 0.5 },
    { key: "brand-volume", familyKey: "volume", weight: 0.2 },
  ];
  const legacyBrand = runSourcesForBoard(legacy, "brand", mallDims).map((s) => s.key);
  assert.deepEqual(legacyBrand, ["brand-volume"], "缺 board 的歧义来源（revenue 两榜同名）不串列，宁缺勿串");
  // weight<=0 的源不进规则页来源清单
  const zero = runSourcesForBoard([{ key: "mall-firststore", familyKey: "firststore", weight: 0, board: "mall" }], "mall", brandDims);
  assert.equal(zero.length, 0, "weight=0（未参排）来源不列出");
});
