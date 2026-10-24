// ym883/d-ym334 enforce: the promotion numeric gate is a pure predicate over the frozen policy —
// unit-tested here without a database (setup only checks the DATABASE_URL name; no query is issued).
// The DB-backed probe behaviour this gate feeds lives in source-admission.test.ts.
import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { meetsSourcePolicyThresholds, SOURCE_POLICY_V1 } from "@aihot/industry/source-policy";

const base = { notModified: false, samplesOk: 6, samplesTotal: 6, matched: 6 };

test("数字门：达标放行（6/6、占比 1.0）", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, base), true);
});

test("数字门：边界含等号（samplesOk 恰 5、占比恰 0.6=3/5）", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, { ...base, samplesOk: 5, samplesTotal: 5, matched: 3 }), true);
});

test("数字门：条数不足（samplesOk 4 < 5，占比达标）→ false", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, { ...base, samplesOk: 4, samplesTotal: 4, matched: 4 }), false);
});

test("数字门：占比不足（6 条中 2 条命中，2/6 < 0.6）→ false", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, { ...base, samplesOk: 6, samplesTotal: 6, matched: 2 }), false);
});

test("数字门：304 轮无新列表证据 → false（不足不转正，与计数保留无关）", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, { ...base, notModified: true }), false);
});

test("数字门：零样本/零分母 → false", () => {
  assert.equal(meetsSourcePolicyThresholds(SOURCE_POLICY_V1, { ...base, samplesOk: 0, samplesTotal: 0, matched: 0 }), false);
});

test("数字门：阈值未冻结（null）或非有限值 → false（与缺参数自动关闭同向）", () => {
  const unfrozen = { ...SOURCE_POLICY_V1, thresholds: null };
  assert.equal(meetsSourcePolicyThresholds(unfrozen, base), false);
  const nanPolicy = { ...SOURCE_POLICY_V1, thresholds: { minSamples: Number.NaN, minRelevanceRatio: 0.6 } };
  assert.equal(meetsSourcePolicyThresholds(nanPolicy, base), false);
});
