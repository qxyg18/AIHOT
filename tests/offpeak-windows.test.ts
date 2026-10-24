// Provider-routed day plan (ym431, owner directive 2026-10-08; night window retired by ym436 the
// same day after the official night free-window activity 2026-09-03~10-07 expired): the site
// updates around the clock, model work runs on the Zhipu plan only from 2026-10-13 18:00 (daily
// 18:00-09:00 — "恢复智谱套餐的18:00后运行"); every hour before that is free models first +
// MIMO pay-as-you-go. Date math with fixed timestamps on purpose (2026-10-08 is a Thursday,
// 2026-10-10 a Saturday, 2026-10-13 a Tuesday). ym438 起 windows.ts 带套餐窗 settings 层（连库），
// planActive 求值会触发后台刷新——测完关库，否则打开的连接挂住进程，--test 下一文件起不来。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "../packages/backend/src/db.ts";
import { mimoShiftActive, offpeakPlanLive } from "../packages/backend/src/lib/windows.ts";
import { gateAllows } from "../apps/worker/src/schedules.ts";
import { routeToMimo } from "../packages/backend/src/editorial/models.ts";
import { isMimoBalanceError } from "../packages/backend/src/providers/mimo.ts";

after(async () => {
  await closeDb();
});

// Beijing wall clock -> epoch ms (input expressed as UTC minus 8h).
const bj = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

test("quiet window is retired: every job runs at weekday midday (ym431)", () => {
  const quietNoon = bj(2026, 10, 8, 14, 0); // Thursday 14:00 — zw20's dead zone
  assert.equal(gateAllows({}, quietNoon), true); // zw20 silenced this
  assert.equal(gateAllows({ quiet: "exempt" }, quietNoon), true);
  assert.equal(gateAllows({ offpeak: true }, quietNoon), true); // model jobs too
  const morning = bj(2026, 10, 8, 10, 0);
  assert.equal(gateAllows({ offpeak: true }, morning), true);
  const night = bj(2026, 10, 9, 2, 0);
  assert.equal(gateAllows({ offpeak: true }, night), true);
  assert.equal(gateAllows({}, night), true);
});

test("no dead gap: 08:00 belongs to the plan window and runs (ym431)", () => {
  // zw20 left 07:30-09:00 as a neither-window gap where model jobs were skipped.
  assert.equal(gateAllows({ offpeak: true }, bj(2026, 10, 9, 8, 0)), true);
});

test("night plan priority is retired until the Tuesday switch (ym436)", async () => {
  // The official night free-window activity (23:00-09:00 zero-quota GLM-5.3-Flash) ran 09-03~10-07
  // and was not extended — so the interim night plan window died with it: every hour before the
  // Tuesday switch is free/MIMO.
  const { planActive } = await import("../packages/backend/src/lib/windows.ts");
  assert.equal(planActive(bj(2026, 10, 8, 22, 59)), false);
  assert.equal(planActive(bj(2026, 10, 8, 23, 0)), false); // the old night window start — retired
  assert.equal(planActive(bj(2026, 10, 9, 2, 0)), false); // past midnight: free/MIMO now
  assert.equal(planActive(bj(2026, 10, 9, 8, 59)), false);
  assert.equal(planActive(bj(2026, 10, 12, 23, 59)), false); // last pre-switch night
});

test("from 2026-10-13 18:00 the plan window starts at 18:00 (ym431)", async () => {
  const { planActive } = await import("../packages/backend/src/lib/windows.ts");
  assert.equal(planActive(bj(2026, 10, 13, 17, 59)), false); // Tuesday afternoon still free/MIMO
  assert.equal(planActive(bj(2026, 10, 13, 18, 0)), true); // the switch itself
  assert.equal(planActive(bj(2026, 10, 13, 20, 0)), true);
  assert.equal(planActive(bj(2026, 10, 14, 8, 59)), true); // night tail still plan
  assert.equal(planActive(bj(2026, 10, 14, 9, 0)), false);
  assert.equal(planActive(bj(2026, 10, 14, 17, 59)), false);
  assert.equal(planActive(bj(2026, 10, 14, 18, 0)), true);
});

test("free/MIMO day window is the plan window's complement (ym431)", () => {
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 9, 0)), true); // 09:00 opens the day window
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 14, 0)), true); // weekday midday runs now
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 22, 59)), true);
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 23, 0)), true); // ym436: night priority retired pre-switch
  assert.equal(mimoShiftActive(bj(2026, 10, 9, 8, 0)), true); // ym436: pre-switch tail is free/MIMO too
  assert.equal(mimoShiftActive(bj(2026, 10, 10, 14, 0)), true); // weekends too
  assert.equal(mimoShiftActive(bj(2026, 10, 13, 20, 0)), false); // after the switch evenings are plan
});

test("plan live date gate is unchanged", () => {
  assert.equal(offpeakPlanLive(bj(2026, 10, 7, 23, 59)), false);
  assert.equal(offpeakPlanLive(bj(2026, 10, 8, 0, 0)), true);
});

test("gate is date-neutral around the old effective date (ym431)", () => {
  const before = bj(2026, 10, 7, 23, 59);
  assert.equal(gateAllows({}, before), true);
  assert.equal(gateAllows({ offpeak: true }, before), true);
});

test("model router sends unoverridden defaults to MIMO only on a live, usable shift (ka3)", () => {
  const on = { overridden: false, planLive: true, shift: true, usable: true };
  assert.equal(routeToMimo(on), true);
  assert.equal(routeToMimo({ ...on, overridden: true }), false); // explicit admin/env choice wins
  assert.equal(routeToMimo({ ...on, planLive: false }), false); // before the plan nothing changes
  assert.equal(routeToMimo({ ...on, shift: false }), false); // plan window keeps the Zhipu plan
  assert.equal(routeToMimo({ ...on, usable: false }), false); // no key / circuit open -> plan model
});

test("balance-type failures are recognized across provider wordings", () => {
  assert.equal(isMimoBalanceError(402, "Payment Required"), true);
  assert.equal(isMimoBalanceError(429, "code 1113: insufficient balance"), true);
  assert.equal(isMimoBalanceError(429, "余额不足，请充值"), true);
  assert.equal(isMimoBalanceError(429, "quota exhausted for this month"), true);
  assert.equal(isMimoBalanceError(429, "rate limited: too many concurrent requests"), false); // plain throttling
  assert.equal(isMimoBalanceError(500, "internal error"), false);
  assert.equal(isMimoBalanceError(null, "connect failed"), false);
});
