// Off-peak windows (zw20) and the MIMO daytime shift (ka3): weekday 12:00-18:00 Beijing quiets
// every site update, model-heavy jobs run 23:00-07:30 on the Zhipu plan or 9:00-22:59 on MIMO,
// and nothing changes before 2026-10-08 Beijing time. Pure date math, fixed timestamps on
// purpose (2026-10-08 is a Thursday, 2026-10-10 a Saturday).
import assert from "node:assert/strict";
import { test } from "node:test";
import { quietActive, offpeakActive, mimoShiftActive, offpeakPlanLive } from "../packages/backend/src/lib/windows.ts";
import { gateAllows } from "../apps/worker/src/schedules.ts";
import { routeToMimo } from "../packages/backend/src/editorial/models.ts";
import { isMimoBalanceError } from "../packages/backend/src/providers/mimo.ts";

// Beijing wall clock -> epoch ms (input expressed as UTC minus 8h).
const bj = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

test("quiet window covers weekdays 12:00-17:59 Beijing only", () => {
  assert.equal(quietActive(bj(2026, 10, 8, 11, 59)), false); // Thu before noon
  assert.equal(quietActive(bj(2026, 10, 8, 12, 0)), true); // Thu 12:00 sharp
  assert.equal(quietActive(bj(2026, 10, 8, 17, 59)), true); // Thu last quiet minute
  assert.equal(quietActive(bj(2026, 10, 8, 18, 0)), false); // Thu reopening
  assert.equal(quietActive(bj(2026, 10, 10, 14, 0)), false); // Saturday midday stays open
  assert.equal(quietActive(bj(2026, 10, 11, 14, 0)), false); // Sunday too
  assert.equal(quietActive(bj(2026, 10, 12, 14, 0)), true); // Monday midday quiets
});

test("discount window is 23:00-07:30 Beijing every day", () => {
  assert.equal(offpeakActive(bj(2026, 10, 8, 22, 59)), false);
  assert.equal(offpeakActive(bj(2026, 10, 8, 23, 0)), true);
  assert.equal(offpeakActive(bj(2026, 10, 9, 0, 0)), true); // past midnight
  assert.equal(offpeakActive(bj(2026, 10, 9, 7, 29)), true); // last discounted minute
  assert.equal(offpeakActive(bj(2026, 10, 9, 7, 30)), false);
  assert.equal(offpeakActive(bj(2026, 10, 10, 14, 0)), false); // weekend midday is not discounted
});

test("MIMO shift is 9:00-22:59 Beijing every day (ka3)", () => {
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 8, 59)), false);
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 9, 0)), true);
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 22, 59)), true);
  assert.equal(mimoShiftActive(bj(2026, 10, 8, 23, 0)), false); // hands over to the discount window
  assert.equal(mimoShiftActive(bj(2026, 10, 10, 14, 0)), true); // weekend midday is a MIMO shift
});

test("plan is not live before 2026-10-08 Beijing and live right after", () => {
  assert.equal(offpeakPlanLive(bj(2026, 10, 7, 23, 59)), false);
  assert.equal(offpeakPlanLive(bj(2026, 10, 8, 0, 0)), true);
});

test("gate keeps pre-effective dates unchanged for every job kind", () => {
  const before = bj(2026, 10, 7, 23, 59);
  assert.equal(gateAllows({}, before), true);
  assert.equal(gateAllows({ offpeak: true }, before), true);
});

test("gate enforces both windows after 2026-10-08 (model jobs: discount window or MIMO shift)", () => {
  const quietNoon = bj(2026, 10, 8, 14, 0);
  assert.equal(gateAllows({}, quietNoon), false); // default job silenced
  assert.equal(gateAllows({ quiet: "exempt" }, quietNoon), true); // ops stay on
  assert.equal(gateAllows({ offpeak: true }, quietNoon), false); // even MIMO yields to quiet hours
  const morning = bj(2026, 10, 8, 10, 0);
  assert.equal(gateAllows({ offpeak: true }, morning), true); // MIMO shift before noon
  const night = bj(2026, 10, 9, 2, 0);
  assert.equal(gateAllows({ offpeak: true }, night), true); // discount window
  assert.equal(gateAllows({}, night), true); // regular evening/night work is fine
  const saturdayNoon = bj(2026, 10, 10, 14, 0);
  assert.equal(gateAllows({}, saturdayNoon), true); // weekend updates all day
  assert.equal(gateAllows({ offpeak: true }, saturdayNoon), true); // ...and MIMO runs weekends too
  const gap = bj(2026, 10, 9, 8, 0); // 07:30-09:00 gap: neither window
  assert.equal(gateAllows({ offpeak: true }, gap), false);
});

test("model router sends unoverridden defaults to MIMO only on a live, usable shift (ka3)", () => {
  const on = { overridden: false, planLive: true, shift: true, usable: true };
  assert.equal(routeToMimo(on), true);
  assert.equal(routeToMimo({ ...on, overridden: true }), false); // explicit admin/env choice wins
  assert.equal(routeToMimo({ ...on, planLive: false }), false); // before 2026-10-08 nothing changes
  assert.equal(routeToMimo({ ...on, shift: false }), false); // night keeps the discounted plan
  assert.equal(routeToMimo({ ...on, usable: false }), false); // no key / circuit open -> old behavior
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
