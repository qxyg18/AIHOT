// A threshold typed wrong in .env must not switch its alert off: before this guard,
// `ALERT_SELECTED_DROUGHT_HOURS=1o` became NaN and every comparison against it was false.
// Pure unit test (no database) so it runs wherever the suite runs, including machines
// without the 5433 test instance.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envPositiveNumber } from "@aihot/backend/operations/env-number";

test("a mistyped threshold falls back to the documented default", () => {
  const key = "ALERT_SELECTED_DROUGHT_HOURS";
  const saved = process.env[key];
  try {
    for (const bad of [undefined, "", "   ", "1o", "12abc", "0", "-5"]) {
      if (bad === undefined) delete process.env[key];
      else process.env[key] = bad;
      assert.equal(envPositiveNumber(key, 36), 36, `fallback for ${JSON.stringify(bad)}`);
    }
    process.env[key] = "12";
    assert.equal(envPositiveNumber(key, 36), 12, "a real value is kept");
    process.env[key] = "1e3";
    assert.equal(envPositiveNumber(key, 36), 1000, "exponent form parses");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});
