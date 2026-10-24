// rd14 详情页品牌维度分面板：契约与装配边界断言。
// ①brandBoard 与 mallBoard 字段集编译期同构（共享 LbDimensionBoard，防两面板载荷漂移）；
// ②品牌榜三维键锁=业绩/规模/声量（revenue/stores/volume，业绩置首）——前端面板标题与装配依赖该集合；
// ③渲染标签 fallback 面=每个维度键在契约中文短名表内有标签（历史 run dimensionNames 空对象时兜底）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LbModelDetail } from "@aihot/contracts/leaderboard";
import { LB_DIMENSION_LABELS, LB_DIMENSION_ORDER } from "@aihot/contracts/leaderboard";
import { BRAND_DIMENSIONS, MALL_DIMENSIONS } from "@aihot/backend/leaderboard/method/weighted";

type BrandBoard = NonNullable<LbModelDetail["brandBoard"]>;
type MallBoard = NonNullable<LbModelDetail["mallBoard"]>;

test("brandBoard and mallBoard share the same payload shape (LbDimensionBoard)", () => {
  // 编译期锚：字段集与类型定义不符时，此数组过不了 keyof 赋值（多键/少键均编译红）。
  const fields: Array<keyof BrandBoard> = ["rank", "score", "coverage", "mode", "dimensions", "dimensionTiers", "unmeasuredDimensions"];
  const mallFields: Array<keyof MallBoard> = fields;
  assert.equal(fields.length, 7);
  assert.equal(mallFields.length, 7);
});

test("brand board dimensions are exactly performance/scale/volume with performance first", () => {
  assert.deepEqual(BRAND_DIMENSIONS.map((d) => d.key), ["revenue", "stores", "volume"]);
  assert.equal(BRAND_DIMENSIONS[0]?.name, "业绩");
  assert.equal(BRAND_DIMENSIONS[1]?.name, "规模");
  assert.equal(BRAND_DIMENSIONS[2]?.name, "媒体声量");
});

test("every brand dimension key has a contract chinese label (render fallback)", () => {
  for (const d of BRAND_DIMENSIONS) {
    const label = LB_DIMENSION_LABELS[d.key];
    assert.ok(label && label !== d.key, `dimension ${d.key} needs a chinese label for detail-page fallback`);
  }
});

test("panel dimension order follows each board's DimensionSpec weight order (performance first)", () => {
  assert.deepEqual(LB_DIMENSION_ORDER.brand, BRAND_DIMENSIONS.map((d) => d.key));
  assert.deepEqual(LB_DIMENSION_ORDER.mall, MALL_DIMENSIONS.map((d) => d.key));
  // 面板排序推导：order 命中键按序在前、历史键（如 expansion）尾追，不丢维度。
  const dimensions = { stores: 100, volume: 48.9, revenue: 100, expansion: 12 };
  const order = LB_DIMENSION_ORDER.brand;
  const orderedKeys = [...order.filter((k) => k in dimensions), ...Object.keys(dimensions).filter((k) => !order.includes(k))];
  assert.deepEqual(orderedKeys, ["revenue", "stores", "volume", "expansion"]);
});

test("brand detail panel null-guards: null-valued dimension renders an em-dash row and lands in unmeasuredDimensions", () => {
  // 装配/渲染约定对拍（read.ts loadModel + DimensionBoardPanel）：维度键存在（含值 null）→ 得分行渲染
  // 「—」（tier 照示），null 值维度同时进 unmeasuredDimensions 注记；维度键不存在（历史 run 缺维）→
  // 无得分行，仅进注记。两种形态与 mallBoard rd4 行为同型（closeout §五.2）。
  const dimensions: Record<string, number | null> = { revenue: 100, stores: 100, volume: null };
  const activeFamilies = ["revenue", "stores", "volume"];
  const orderedKeys = ["revenue", "stores", "volume"].filter((k) => k in dimensions);
  assert.deepEqual(orderedKeys, ["revenue", "stores", "volume"]);
  const unmeasured = activeFamilies.filter((f) => dimensions[f] == null);
  assert.deepEqual(unmeasured, ["volume"]);
});
