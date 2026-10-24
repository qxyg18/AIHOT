// Activation-round wiring (ym257/T06): the bounded round that turns eligible candidates into
// collecting sources via ym311's activateCandidate, behind the probe valve. The unit guarantees
// of activateCandidate (single transaction, idempotent replay, tombstone refusal, one address =
// one source) are covered by source-activation.test.ts; this file covers the ROUND: selection
// (eligible, not retired, bounded), counting, round-level replay idempotence, and the drain
// semantics that make the bounded test deterministic. The default policy is the frozen
// source-policy/2 (ym334), so the round exercises the real promotion chain end to end. The run
// command must set SOURCE_PROBE_ENABLED=1 (config reads env at import time); zero HTTP — the
// round is database-only. Assertions tolerate residue rows from other tags (ym312 P1 lesson)
// except inside R4, which drains the pool first so the bound is exact.
import "./setup.ts";

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runActivationRound } from "@aihot/backend/jobs/admission";
import { activateCandidate } from "@aihot/backend/sources/admission/activate";
import { sourceIdentity } from "@aihot/backend/admin/sources";
import { endpointIdentityOf, transitionCandidate, upsertCandidate } from "@aihot/backend/sources/admission/store";
import { tag } from "./setup.ts";

const T = `ym257r-${tag()}`;

/** A candidate walked to eligible through the engine's own CAS chain (discovered→probing→eligible);
 *  the checks themselves are the probe's evidence and stay out of this file's concern. */
async function eligibleCandidate(url: string): Promise<number> {
  const up = await upsertCandidate({ endpointIdentity: endpointIdentityOf(url), url, kind: "rss" });
  const id = up.candidate.id;
  let row = await transitionCandidate({ candidateId: id, expectVersion: up.candidate.version, fromStatuses: ["discovered"], toStatus: "probing" });
  assert.ok(row, "seed transition to probing");
  row = await transitionCandidate({ candidateId: id, expectVersion: row.version, fromStatuses: ["probing"], toStatus: "eligible" });
  assert.ok(row, "seed transition to eligible");
  return id;
}

test("R1 阀开：eligible → 轮激活建源、计数入回执、源出生即进采集调度面", async () => {
  const id = await eligibleCandidate(`https://${T}-ok.example.org/feed.xml`);
  const out = await runActivationRound();
  assert.equal(out.skipped, undefined, "valve on, round ran");
  assert.ok((out.considered ?? 0) >= 1, "this round's candidate was considered");
  assert.ok((out.activated ?? 0) >= 1);
  assert.ok((out.created ?? 0) >= 1);
  const [cand] = await sql`SELECT status, activated_source_id FROM source_candidates WHERE id = ${id}`;
  assert.equal(cand!.status, "activated");
  assert.equal(cand!.activated_source_id, `admission-c${id}`);
  const [src] = await sql`SELECT id, enabled, next_fetch_at FROM sources WHERE id = ${`admission-c${id}`}`;
  assert.ok(src, "source row committed");
  assert.equal(src!.enabled, true);
  assert.ok(src!.next_fetch_at, "handed to the existing collect schedule at birth");
  const [auditRow] = await sql`SELECT actor, action FROM audit_log WHERE subject = ${`source:admission-c${id}`} ORDER BY created_at DESC LIMIT 1`;
  assert.equal(auditRow!.actor, "admission-engine");
  assert.equal(auditRow!.action, "source.activate");
});

test("R2 轮级幂等：activated 池上重跑 → 本 tag 零新写", async () => {
  const read = () => sql<{ s: number; a: number }[]>`
    SELECT (SELECT count(*)::int FROM sources WHERE config::text LIKE ${`%${T}%`}) AS s,
           (SELECT count(*)::int FROM audit_log WHERE actor = 'admission-engine' AND after::text LIKE ${`%${T}%`}) AS a`;
  const [before] = await read();
  await runActivationRound();
  const [afterRow] = await read();
  assert.equal(afterRow!.s, before!.s, "no new source rows");
  assert.equal(afterRow!.a, before!.a, "no new audit rows");
});

test("R3 手退不复活：manual_retired 的 eligible 行轮后原样", async () => {
  const id = await eligibleCandidate(`https://${T}-retired.example.org/feed.xml`);
  // The tombstone contract (0052): manual_retired comes with retired_at/retired_by; status stays
  // eligible — the round's selection and activateCandidate both refuse on the tombstone alone.
  await sql`UPDATE source_candidates SET manual_retired = true, retired_at = now(), retired_by = ${T} WHERE id = ${id}`;
  await runActivationRound();
  const [row] = await sql`SELECT status, activated_source_id, manual_retired FROM source_candidates WHERE id = ${id}`;
  assert.equal(row!.manual_retired, true);
  assert.equal(row!.status, "eligible", "never activated");
  assert.equal(row!.activated_source_id, null);
  const [src] = await sql`SELECT id FROM sources WHERE id = ${`admission-c${id}`}`;
  assert.equal(src, undefined, "no source row for a retired candidate");
});

test("R4 有界：池排空后造 21 个 eligible → 单轮恰处理 20 个", async () => {
  // Drain first: any residue eligible from other tags leaves the pool, so the bound below is exact.
  await runActivationRound();
  for (let i = 0; i < 21; i++) await eligibleCandidate(`https://${T}-b${i}.example.org/feed.xml`);
  const out = await runActivationRound();
  assert.equal(out.considered, 20, "bounded at MAX_ACTIVATES_PER_ROUND");
  assert.equal(out.activated, 20);
  const [{ n: activatedN }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_candidates WHERE url LIKE ${`%${T}-b%`} AND status = 'activated'`;
  assert.equal(activatedN, 20);
  const [{ n: stillEligible }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_candidates WHERE url LIKE ${`%${T}-b%`} AND status = 'eligible'`;
  assert.equal(stillEligible, 1, "the 21st waits for the next round");
});

test("R5 竞态拒绝：锁后重读见外部状态变更 → 拒绝且零半源（AC1 CAS 前哨，审计P1销项）", async () => {
  const url = `https://${T}-race.example.org/feed.xml`;
  const id = await eligibleCandidate(url);
  const identity = sourceIdentity("rss", { feedUrl: url });
  assert.ok(identity, "identity key computable");
  // Hold the same advisory lock activateCandidate waits on; while it is parked on the lock, a
  // competing bare state change (a transition's own CAS, on another connection) moves the row.
  // When the holding transaction commits (releasing the lock), the activation re-reads the row,
  // sees parked, and refuses — proving an external race never yields a half source (the CAS
  // WHERE version+status is the second, narrower guard for the re-read→CAS window inside one
  // transaction). The await of `pending` stays OUTSIDE the lock transaction: awaiting it inside
  // would wait on the very lock that transaction holds — a self-deadlock.
  let pending: ReturnType<typeof activateCandidate> | null = null;
  await sql.begin(async (lockTx) => {
    await lockTx`SELECT pg_advisory_xact_lock(hashtext(${identity})::bigint)`;
    pending = activateCandidate(id);
    await new Promise((resolve) => setTimeout(resolve, 250)); // let it reach and park on the lock
    const moved = await sql`UPDATE source_candidates SET status = 'parked', version = version + 1, updated_at = now() WHERE id = ${id} AND status = 'eligible' RETURNING 1`;
    assert.equal(moved.length, 1, "competing transition committed first");
  }); // commit releases the lock; the parked activation now proceeds and re-reads parked
  const out = await pending!;
  assert.equal(out.activated, false);
  assert.equal(out.reason, "not-eligible:parked");
  const [row] = await sql`SELECT status FROM source_candidates WHERE id = ${id}`;
  assert.equal(row!.status, "parked", "row stays where the competitor put it");
  const [src] = await sql`SELECT id FROM sources WHERE id = ${`admission-c${id}`}`;
  assert.equal(src, undefined, "no half source");
  const [auditRow] = await sql`SELECT id FROM audit_log WHERE subject = ${`source:admission-c${id}`}`;
  assert.equal(auditRow, undefined, "no audit row without its source");
});

after(async () => {
  // Shares the throwaway database with the other invariant files (they run one at a time);
  // residue eligible rows would leak into other files' due scans. No checks rows are created
  // by this file, so the deletes below are unobstructed.
  await sql`DELETE FROM sources WHERE id LIKE 'admission-c%' AND config::text LIKE ${`%${T}%`}`;
  await sql`DELETE FROM source_candidates WHERE url LIKE ${`%${T}%`}`;
  await sql`DELETE FROM audit_log WHERE (actor = 'admission-engine' AND after::text LIKE ${`%${T}%`}) OR subject LIKE ${`%${T}%`}`;
  await closeDb();
});
