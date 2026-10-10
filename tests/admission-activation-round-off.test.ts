// Valve-off twin of admission-activation-round.test.ts (ym257/T06): with SOURCE_PROBE_ENABLED
// unset (default false) the activation round skips before any selection — no eligible row is
// touched, no side effect. Mirrors ym312's admission-jobs-off.test.ts pattern because config
// reads the env at import time, so the two valve states cannot share a process. Run WITHOUT
// any SOURCE_* env.
import "./setup.ts";

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runActivationRound } from "@aihot/backend/jobs/admission";
import { endpointIdentityOf, transitionCandidate, upsertCandidate } from "@aihot/backend/sources/admission/store";
import { tag } from "./setup.ts";

const T = `ym257o-${tag()}`;

test("阀缺省关：轮 skipped 且 eligible 行零变化零建源", async () => {
  const url = `https://${T}-x.example.org/feed.xml`;
  const up = await upsertCandidate({ endpointIdentity: endpointIdentityOf(url), url, kind: "rss" });
  let row = await transitionCandidate({ candidateId: up.candidate.id, expectVersion: up.candidate.version, fromStatuses: ["discovered"], toStatus: "probing" });
  assert.ok(row, "seed transition to probing");
  row = await transitionCandidate({ candidateId: up.candidate.id, expectVersion: row.version, fromStatuses: ["probing"], toStatus: "eligible" });
  assert.ok(row, "seed transition to eligible");
  const out = await runActivationRound();
  assert.equal(out.skipped, "SOURCE_PROBE_ENABLED off");
  assert.equal(out.considered, undefined, "no selection ran");
  const [cand] = await sql`SELECT status, activated_source_id FROM source_candidates WHERE id = ${up.candidate.id}`;
  assert.equal(cand!.status, "eligible", "eligible row untouched");
  assert.equal(cand!.activated_source_id, null);
});

after(async () => {
  await sql`DELETE FROM source_candidates WHERE url LIKE ${`%${T}%`}`;
  await closeDb();
});
