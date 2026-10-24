// Activation invariants (T05/ym244 follow-up ym311): eligible -> activated commits the source,
// its audit row and the candidate CAS in ONE transaction (a refused CAS rolls the source back
// with it); re-activating a candidate returns the same source; an address an editor already
// created by hand is reused, never duplicated; a manual tombstone and a non-eligible state never
// activate; an unfrozen policy (thresholds null) refuses with zero side effects, which is what
// keeps this a dead wire until the policy is frozen (the probe parks on top of it); and the
// activated source lands inside the existing collect schedule's selection — activation has no
// scheduler of its own. The frozen/unfrozen policies are injected, so these tests stay valid
// whichever way source-policy.ts is frozen later (ym314).
import "./setup.ts";

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { activateCandidate } from "@aihot/backend/sources/admission/activate";
import { endpointIdentityOf, transitionCandidate, upsertCandidate } from "@aihot/backend/sources/admission/store";
import { createSource } from "@aihot/backend/admin/sources";
import { SOURCE_POLICY_V1, type SourcePolicyV1 } from "@aihot/industry/source-policy";
import { tag } from "./setup.ts";

const T = tag();
const FROZEN: SourcePolicyV1 = { ...SOURCE_POLICY_V1, version: "source-policy/test-frozen", thresholds: { minSamples: 3, minRelevanceRatio: 0.5 } };
const UNFROZEN: SourcePolicyV1 = { ...SOURCE_POLICY_V1, thresholds: null };

/** A candidate walked to eligible through the engine's own CAS chain (discovered→probing→eligible);
 *  the checks themselves are the probe's evidence and stay out of this file's concern. */
async function eligibleCandidate(url: string, kind: "rss" | "web_list" | "json_list" = "rss"): Promise<number> {
  const up = await upsertCandidate({ endpointIdentity: endpointIdentityOf(url), url, kind });
  const id = up.candidate.id;
  let row = await transitionCandidate({ candidateId: id, expectVersion: up.candidate.version, fromStatuses: ["discovered"], toStatus: "probing" });
  assert.ok(row, "seed transition to probing");
  row = await transitionCandidate({ candidateId: id, expectVersion: row.version, fromStatuses: ["probing"], toStatus: "eligible" });
  assert.ok(row, "seed transition to eligible");
  return id;
}

test("AC1 未冻结 policy（thresholds=null）→ 拒绝且零副作用", async () => {
  const before = await counts();
  const id = await eligibleCandidate(`https://${T}-gate.example.org/feed.xml`);
  const out = await activateCandidate(id, { policy: UNFROZEN });
  assert.equal(out.activated, false);
  assert.equal(out.reason, "policy-not-frozen");
  const after = await counts();
  assert.equal(after.sources, before.sources, "no source row");
  assert.equal(after.audits, before.audits, "no audit row");
  const [row] = await sql`SELECT status, activated_source_id, version FROM source_candidates WHERE id = ${id}`;
  assert.equal(row!.status, "eligible", "candidate untouched");
  assert.equal(row!.activated_source_id, null);
});

test("AC2 达标激活 → 同一事务三写：source+audit+CAS 回链", async () => {
  const url = `https://${T}-ok.example.org/news.xml`;
  const id = await eligibleCandidate(url);
  const out = await activateCandidate(id, { policy: FROZEN });
  assert.equal(out.activated, true);
  assert.equal(out.created, true);
  assert.equal(out.source!.id, `admission-c${id}`);
  assert.equal(out.source!.name, `${T}-ok.example.org`);
  assert.equal(out.source!.kind, "rss");
  assert.deepEqual(out.source!.config, { feedUrl: url });
  const [cand] = await sql`SELECT status, activated_source_id, version FROM source_candidates WHERE id = ${id}`;
  assert.equal(cand!.status, "activated");
  assert.equal(cand!.activated_source_id, `admission-c${id}`);
  assert.equal(cand!.version, 4, "discovered→probing→eligible→activated, CAS advanced each hop");
  const [auditRow] = await sql`SELECT actor, action, subject, after FROM audit_log WHERE subject = ${`source:admission-c${id}`} ORDER BY created_at DESC LIMIT 1`;
  assert.equal(auditRow!.actor, "admission-engine");
  assert.equal(auditRow!.action, "source.activate");
  assert.equal((auditRow!.after as Record<string, unknown>).candidateId, id);
  // All three writes committed: the audit row points at a source that exists, in one transaction's wake.
  const [src] = await sql`SELECT id FROM sources WHERE id = ${`admission-c${id}`}`;
  assert.ok(src, "audit subject resolves to a live source");
});

test("AC1 重复激活同一 candidate → 只返回同一个 source，零新增写", async () => {
  const url = `https://${T}-again.example.org/feed.xml`;
  const id = await eligibleCandidate(url);
  const first = await activateCandidate(id, { policy: FROZEN });
  assert.equal(first.activated, true);
  const before = await counts();
  const second = await activateCandidate(id, { policy: FROZEN });
  assert.equal(second.activated, true);
  assert.equal(second.created, false);
  assert.equal(second.source!.id, first.source!.id, "the same source, not a second one");
  const after = await counts();
  assert.equal(after.sources, before.sources);
  assert.equal(after.audits, before.audits, "no second audit row for a replay");
  const [cand] = await sql`SELECT version FROM source_candidates WHERE id = ${id}`;
  assert.equal(cand!.version, 4, "replay does not advance the CAS again");
});

test("AC1 地址已有人工源 → 复用不重建，candidate 回链既有源", async () => {
  const url = `https://${T}-manual.example.org/list`;
  const manual = await createSource({
    id: `${T}-manual-src`, name: "人工先建", kind: "web_list", config: { url },
    tier: "T2", participation_mode: "editorial", interval_minutes: 30, first_party: false,
    tags: [], site_fulltext: false, syndicate_fulltext: false,
  }, "manual-actor");
  assert.equal(manual.created, true);
  const id = await eligibleCandidate(url, "web_list");
  const out = await activateCandidate(id, { policy: FROZEN });
  assert.equal(out.activated, true);
  assert.equal(out.created, false);
  assert.equal(out.source!.id, manual.source!.id, "the manual source wins, no second row");
  const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE config->>'url' = ${url}`;
  assert.equal(total!.n, 1, "one address, one source");
  const [cand] = await sql`SELECT status, activated_source_id FROM source_candidates WHERE id = ${id}`;
  assert.equal(cand!.status, "activated");
  assert.equal(cand!.activated_source_id, manual.source!.id);
});

test("AC1 并发激活同一 candidate → 恰一个 source，其余读回同一个", async () => {
  const url = `https://${T}-race.example.org/feed.xml`;
  const id = await eligibleCandidate(url);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => activateCandidate(id, { policy: FROZEN })));
  assert.equal(results.every((r) => r.status === "fulfilled"), true, "no activation may throw under the lock");
  const outs = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof activateCandidate>>>).value);
  assert.ok(outs.every((o) => o.activated), "every caller ends activated");
  const creators = outs.filter((o) => o.created);
  assert.equal(creators.length, 1, `exactly one creator wins, got ${creators.length}`);
  const ids = new Set(outs.map((o) => o.source!.id));
  assert.equal(ids.size, 1, "everyone reads the same source back");
  const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE config->>'feedUrl' = ${url}`;
  assert.equal(total!.n, 1);
});

test("AC2 非 eligible 态与手退不激活", async () => {
  const up = await upsertCandidate({ endpointIdentity: endpointIdentityOf(`https://${T}-probing.example.org/feed.xml`), url: `https://${T}-probing.example.org/feed.xml`, kind: "rss" });
  const moved = await transitionCandidate({ candidateId: up.candidate.id, expectVersion: up.candidate.version, fromStatuses: ["discovered"], toStatus: "probing" });
  assert.ok(moved);
  const notEligible = await activateCandidate(up.candidate.id, { policy: FROZEN });
  assert.equal(notEligible.activated, false);
  assert.equal(notEligible.reason, "not-eligible:probing");
  const [row] = await sql`UPDATE source_candidates SET manual_retired = true, retired_at = now(), retired_by = ${`owner-${T}`}, retire_reason = 'manual test retire'
    WHERE id = ${up.candidate.id} RETURNING status`;
  assert.equal(row!.status, "probing", "refusal left the row untouched");
  const retired = await eligibleCandidate(`https://${T}-dead.example.org/feed.xml`);
  await sql`UPDATE source_candidates SET manual_retired = true, retired_at = now(), retired_by = ${`owner-${T}`}, retire_reason = 'manual test retire' WHERE id = ${retired}`;
  const tombstone = await activateCandidate(retired, { policy: FROZEN });
  assert.equal(tombstone.activated, false);
  assert.equal(tombstone.reason, "manual-tombstone");
  const [still] = await sql`SELECT status FROM source_candidates WHERE id = ${retired}`;
  assert.equal(still!.status, "eligible", "a tombstone is never advanced, only refused");
});

test("AC3 激活源落在既有采集调度的选中面内（schedule 接管）", async () => {
  const id = await eligibleCandidate(`https://${T}-sched.example.org/news.rss`);
  const out = await activateCandidate(id, { policy: FROZEN });
  assert.equal(out.activated, true);
  // scheduleDueSources' selection (enabled + collect kind + due), reproduced verbatim: the
  // activated row must be picked up by the existing scheduler without any further write.
  const [picked] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sources
     WHERE id = ${out.source!.id} AND enabled
       AND kind IN ('rss', 'web_list', 'json_list', 'x_search')
       AND (next_fetch_at IS NULL OR next_fetch_at <= now())`;
  assert.equal(picked!.n, 1, "the activated source is due for the collect schedule right now");
});

test("AC3 疑似海外候选 → 出生即带「海外」标签（守卫的补标语义，不绕守卫）", async () => {
  const id = await eligibleCandidate(`https://${T}-jp.example.co.jp/feed.xml`);
  const out = await activateCandidate(id, { policy: FROZEN });
  assert.equal(out.activated, true);
  assert.deepEqual(out.source!.tags, ["海外"]);
});

test("AC1 activated 但源行已灭失 → 报 activated-without-source，不重建", async () => {
  const id = await eligibleCandidate(`https://${T}-gone.example.org/feed.xml`);
  const first = await activateCandidate(id, { policy: FROZEN });
  assert.equal(first.activated, true);
  await sql`DELETE FROM sources WHERE id = ${first.source!.id}`; // ON DELETE SET NULL unhooks the candidate
  const replay = await activateCandidate(id, { policy: FROZEN });
  assert.equal(replay.activated, false);
  assert.equal(replay.reason, "activated-without-source");
  const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE config->>'feedUrl' = ${`https://${T}-gone.example.org/feed.xml`}`;
  assert.equal(total!.n, 0, "a vanished source is reported, not silently recreated");
});

async function counts(): Promise<{ sources: number; audits: number }> {
  const [s] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE id LIKE ${`admission-c%`} OR config::text LIKE ${`%${T}-%`}`;
  const [a] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE subject LIKE ${`%${T}-%`} OR actor = 'admission-engine'`;
  return { sources: s!.n, audits: a!.n };
}

after(async () => {
  // This file shares the throwaway database with the other invariant files (they run one at a
  // time), so it leaves nothing behind: residue candidate rows would leak into the admission
  // rounds' due-candidate scans and discovery idempotence counts and fail them.
  await sql`DELETE FROM sources WHERE id LIKE 'admission-c%' OR config::text LIKE ${`%${T}%`}`;
  await sql`DELETE FROM source_candidates WHERE url LIKE ${`%${T}%`}`;
  await sql`DELETE FROM audit_log WHERE subject LIKE ${`%${T}%`} OR (actor = 'admission-engine' AND after::text LIKE ${`%${T}%`})`;
  await closeDb();
});
