// The activation leg of the admission engine (T05/ym244 follow-up ym311): eligible -> activated.
// Three writes commit in ONE transaction — the source row, its audit row and the candidate's
// status CAS — so a crash can never leave a source without its candidate, or the reverse. The
// address lock is the SAME advisory-lock key the admin create surface takes (sourceIdentity), so
// a manual createSource of this endpoint and this activation serialise and the loser reads the
// winner back: a duplicate address is reused, never given a second source. Re-activating a
// candidate returns the same source row untouched. Activation is refused while the policy is not
// frozen (thresholds null → "policy-not-frozen") — a policy reverted to null after promotion must
// not activate on old evidence. With source-policy/2 (ym334, 2026-10-05) the policy is frozen, so
// this gate passes; the ym311 caller wiring is not in place yet and this file still has zero
// callers, so freezing the policy activates nothing by itself.
import { sql } from "../../db.ts";
import { audit } from "../../admin/auth.ts";
import { findDuplicateSource, sourceIdentity } from "../../admin/sources.ts";
import { assertOverseasTagged, overseasSuspect } from "../overseas.ts";
import { assertSupportedConfig } from "../config-keys.ts";
import { isSourcePolicyActivatable, SOURCE_POLICY_V1, type SourcePolicyV1 } from "@aihot/industry/source-policy";
import { getCandidate, type CandidateRow } from "./store.ts";

export type ActivatedSource = Record<string, any>;

export interface ActivationOutcome {
  candidateId: number;
  activated: boolean;
  /** Present whenever activated=false: wrong state, tombstone, unfrozen policy, or a vanished source. */
  reason?: string;
  /** false when an existing source on the same address was reused instead of inserting a new row. */
  created?: boolean;
  source?: ActivatedSource;
  /** Present on the idempotent replay path (the row as the store reads it). */
  candidate?: CandidateRow;
}

/** Same config shape the probe fed the parsers, so the activated source collects the endpoint
 *  exactly as it was trialled (and duplicate checks see the same identity as a manual create). */
function candidateConfig(cand: CandidateRow): Record<string, unknown> {
  return cand.kind === "rss" ? { feedUrl: cand.url } : { url: cand.url };
}

export async function activateCandidate(candidateId: number, opts: { policy?: SourcePolicyV1 } = {}): Promise<ActivationOutcome> {
  const policy = opts.policy ?? SOURCE_POLICY_V1;
  const cand = await getCandidate(candidateId);
  if (!cand) throw new Error(`activateCandidate: no candidate ${candidateId}`);
  if (cand.manualRetired) return { candidateId, activated: false, reason: "manual-tombstone" };
  if (cand.status === "activated") {
    // Idempotent replay: the activation already happened, return that same source — never a second one.
    const [existing] = await sql`SELECT * FROM sources WHERE id = ${cand.activatedSourceId}`;
    return existing
      ? { candidateId, activated: true, created: false, source: existing, candidate: cand }
      : { candidateId, activated: false, reason: "activated-without-source" };
  }
  if (cand.status !== "eligible") return { candidateId, activated: false, reason: `not-eligible:${cand.status}` };
  // Gate on the frozen policy even though promotion required it: a policy reverted to null after
  // the candidate made eligible must not activate on the old evidence.
  if (!isSourcePolicyActivatable(policy)) return { candidateId, activated: false, reason: "policy-not-frozen" };

  const config = candidateConfig(cand);
  assertSupportedConfig(cand.kind, config);
  const host = new URL(cand.url).hostname.toLowerCase();
  // A suspect-overseas endpoint is tagged 海外 from birth — the guard's own remedy — so the
  // domestic-first hot-list rule still discounts it; the guard below then passes by construction.
  const tags = overseasSuspect(host, config) ? ["海外"] : [];
  assertOverseasTagged({ name: host, config, tags, participation_mode: "editorial", enabled: true });
  const sourceId = `admission-c${cand.id}`;

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceIdentity(cand.kind, config) ?? `source-id:${sourceId}`})::bigint)`;
    // Re-read under the lock (READ COMMITTED sees the winner's commit): a concurrent activation
    // that won the lock has already done the work, so this becomes the idempotent replay.
    const cur = await getCandidate(candidateId);
    if (!cur || cur.manualRetired) return { candidateId, activated: false, reason: "manual-tombstone" } as ActivationOutcome;
    if (cur.status === "activated") {
      const [existing] = await tx`SELECT * FROM sources WHERE id = ${cur.activatedSourceId}`;
      return existing
        ? { candidateId, activated: true, created: false, source: existing, candidate: cur }
        : ({ candidateId, activated: false, reason: "activated-without-source" } as ActivationOutcome);
    }
    if (cur.status !== "eligible") return { candidateId, activated: false, reason: `not-eligible:${cur.status}` } as ActivationOutcome;

    // One address is one source: an editor who already created this endpoint by hand wins, the
    // candidate just links to it (created=false) instead of growing a second source.
    const dup = await findDuplicateSource(cand.kind, config, tx);
    let source = dup as ActivatedSource | null;
    if (!source) {
      const [inserted] = await tx`
        INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, first_party, tags, site_fulltext, syndicate_fulltext, next_fetch_at)
        VALUES (${sourceId}, ${host}, ${cand.kind}, ${tx.json(config as never)}, 'T2', 'editorial', 30, false, ${tags}, false, false, now())
        ON CONFLICT (id) DO NOTHING RETURNING *`;
      source = inserted;
    }
    if (!source) throw new Error(`activateCandidate: source id ${sourceId} already exists for a non-candidate row`);
    // next_fetch_at=now() + enabled (column default true) hands the source to the existing
    // collect schedule (scheduleDueSources) — activation needs no scheduler of its own.

    const after = { candidateId, endpointIdentity: cand.endpointIdentity, policyVersion: policy.version, reusedExistingSource: Boolean(dup) };
    await audit("admission-engine", "source.activate", `source:${source.id}`, null, null, after, undefined, tx);

    // CAS last: a candidate that moved (retired, or another activation committed) fails here and
    // rolls the source and its audit row back with the whole transaction — state and source never
    // disagree. Callers assert the final row directly in the DB; the outcome carries the source.
    const [row] = await tx`
      UPDATE source_candidates
         SET status = 'activated', activated_source_id = ${source.id}, version = version + 1, updated_at = now()
       WHERE id = ${candidateId} AND version = ${cur.version} AND status = 'eligible' AND NOT manual_retired
       RETURNING version`;
    if (!row) throw new Error("activateCandidate: stale CAS — the candidate moved, rolling the source back with this transaction");
    return { candidateId, activated: true, created: !dup, source };
  });
}
