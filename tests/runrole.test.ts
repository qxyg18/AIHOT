// Run-role master gate (ym671): the three configured roles resolve as themselves; everything else
// — missing, empty, wrong case, garbage — fails closed to "off", and only "active" allows side
// effects. Pure unit tests over the resolver; the entry-point gating is covered by
// run-role-gate.test.ts spawning the real processes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunRole, runRoleWarning, sideEffectsEnabled } from "@aihot/backend/operations/runrole";

test("the three roles resolve as configured", () => {
  assert.deepEqual(resolveRunRole("active"), { role: "active", raw: "active", failed: false });
  assert.deepEqual(resolveRunRole("shadow"), { role: "shadow", raw: "shadow", failed: false });
  assert.deepEqual(resolveRunRole("off"), { role: "off", raw: "off", failed: false });
  // Surrounding whitespace (a hand-edited .env) must not silently change the deployment's role.
  assert.deepEqual(resolveRunRole(" active "), { role: "active", raw: "active", failed: false });
});

test("missing, empty or invalid values fail closed to off", () => {
  for (const value of [undefined, "", "   ", "ACTIVE", "Active", "on", "true", "1", "prod", "自动"]) {
    const r = resolveRunRole(value);
    assert.equal(r.role, "off", `value ${JSON.stringify(value)}`);
    assert.equal(r.failed, true, `value ${JSON.stringify(value)}`);
  }
});

test("external side effects run only in the active role", () => {
  assert.equal(sideEffectsEnabled("active"), true);
  assert.equal(sideEffectsEnabled("shadow"), false);
  assert.equal(sideEffectsEnabled("off"), false);
});

test("the fail-closed warning is one structured JSON line naming the raw value", () => {
  const warned = JSON.parse(runRoleWarning(resolveRunRole("turbo")));
  assert.equal(warned.level, "warn");
  assert.equal(warned.effective, "off");
  assert.equal(warned.raw, "turbo");
  assert.equal(JSON.parse(runRoleWarning(resolveRunRole(undefined))).raw, null);
});
