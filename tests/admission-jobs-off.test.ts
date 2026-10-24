// Admission worker entries, valves at their defaults (ym312): with neither SOURCE_DISCOVERY_ENABLED
// nor SOURCE_PROBE_ENABLED set, both rounds skip before any query-driven work or outbound call —
// the BUILD-disabled state of the engine stays intact and the candidate tables are untouched.
// Runs in its own process (node --test): the valves live in the import-time config snapshot, so
// the on-state has the sibling admission-jobs.test.ts instead.
import "./setup.ts";

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runDiscoveryRound, runProbeRound } from "@aihot/backend/jobs/admission";

after(async () => {
  await closeDb();
});

test("阀缺省关：两轮入口直接跳过，候选表零变化", async () => {
  const [before] = await sql`SELECT count(*)::int AS n FROM source_candidates`;
  const d = await runDiscoveryRound();
  const p = await runProbeRound();
  assert.match(String(d.skipped), /SOURCE_DISCOVERY_ENABLED/);
  assert.match(String(p.skipped), /SOURCE_PROBE_ENABLED/);
  assert.equal(d.roots, undefined, "no discovery work happened");
  assert.equal(p.probed, undefined, "no probe work happened");
  const [afterRow] = await sql`SELECT count(*)::int AS n FROM source_candidates`;
  assert.equal(afterRow.n, before.n, "candidate table untouched");
});
