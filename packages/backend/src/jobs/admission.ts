// Worker entry for the source admission engine (ym312 discovery/probe, ym257/T06 activation):
// a daily discovery round over approved official roots, a bounded probe round over due
// candidates, and a bounded activation round that turns eligible candidates into collecting
// sources through activateCandidate (ym311: one transaction = source row + audit row + candidate
// CAS, idempotent on replay, one address = one source). The engine files (sources/admission/*)
// are consumed as-is, never modified. The policy is frozen (source-policy/2, ym334), so an
// all-pass candidate promotes during the probe round and activates in the follow-up round.
// Valves live in config (sourceDiscoveryEnabled / sourceProbeEnabled, both default false). The
// activation round shares the probe valve — probe off means the engine's write side is fully off
// (no promotion, no source creation; eligible rows just wait), which is the rollback semantics:
// switching a valve off leaves the other's candidates and append-only checks intact.
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { discoverOfficialCandidates } from "../sources/admission/discover.ts";
import { probeCandidate } from "../sources/admission/probe.ts";
import { activateCandidate } from "../sources/admission/activate.ts";
import { listApprovedRoots } from "../sources/admission/store.ts";

// Bounded rounds keep the shared pgboss pool (max: 4 connections) and the engine's own fetch
// budgets (25 s timeouts, sitemap ≤ 2 MB) inside the worker's existing resource envelope.
const MAX_ROOTS_PER_ROUND = 20;
const MAX_PROBES_PER_ROUND = 20;
const MAX_ACTIVATES_PER_ROUND = 20;

export interface DiscoveryRoundResult {
  skipped?: string;
  roots?: number;
  endpoints?: number;
  newCandidates?: number;
}

/** Daily discovery (sources.admission.discover): walk approved roots, persist candidates through
 *  the engine's idempotent upsert (tombstones untouched). Read-only apart from candidate rows. */
export async function runDiscoveryRound(): Promise<DiscoveryRoundResult> {
  if (!config.sourceDiscoveryEnabled) return { skipped: "SOURCE_DISCOVERY_ENABLED off" };
  const startedAt = new Date();
  const roots = (await listApprovedRoots()).slice(0, MAX_ROOTS_PER_ROUND);
  let endpoints = 0;
  for (const root of roots) {
    endpoints += (await discoverOfficialCandidates(root)).length;
  }
  const [grown] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM source_candidates WHERE created_at >= ${startedAt}`;
  return { roots: roots.length, endpoints, newCandidates: grown?.n ?? 0 };
}

export interface ProbeRoundResult {
  skipped?: string;
  probed?: number;
  probing?: number;
  parked?: number;
  parkedReasons?: Record<string, number>;
  notModified?: number;
  untouched?: number;
}

/** Bounded probe round (sources.admission.probe): due candidates (discovered/probing, not manually
 *  retired, least recently probed first) go through the engine's probe — evidence checks are
 *  append-only; parked/eligible/rejected rows are never re-selected. */
export async function runProbeRound(): Promise<ProbeRoundResult> {
  if (!config.sourceProbeEnabled) return { skipped: "SOURCE_PROBE_ENABLED off" };
  const due = await sql<{ id: number }[]>`
    SELECT id FROM source_candidates
     WHERE status IN ('discovered', 'probing') AND NOT manual_retired
     ORDER BY last_probe_at NULLS FIRST, id
     LIMIT ${MAX_PROBES_PER_ROUND}`;
  const out: ProbeRoundResult = { probed: 0, probing: 0, parked: 0, parkedReasons: {}, notModified: 0, untouched: 0 };
  for (const { id } of due) {
    const r = await probeCandidate(id);
    out.probed! += 1;
    if (r.checks.length === 0 && !r.parkedReason) out.untouched! += 1; // stale CAS or already terminal
    else if (r.status === "parked") {
      out.parked! += 1;
      out.parkedReasons![r.parkedReason ?? "unknown"] = (out.parkedReasons![r.parkedReason ?? "unknown"] ?? 0) + 1;
    } else {
      if (r.notModified) out.notModified! += 1;
      if (r.status === "probing") out.probing! += 1;
    }
  }
  return out;
}

export interface ActivationRoundResult {
  skipped?: string;
  /** Eligible rows selected this round. */
  considered?: number;
  activated?: number;
  /** Activations that inserted a fresh source row. */
  created?: number;
  /** Activations that linked an existing source on the same address (one address = one source). */
  reused?: number;
  /** Non-activating outcomes by reason (refusals, plus error:<message> for throws — a row moved
   *  between selection and its CAS fails the whole transaction and must not fail the round). */
  reasons?: Record<string, number>;
}

/** Bounded activation round (sources.admission.activate, ym257/T06): eligible candidates become
 *  collecting sources through ym311's activateCandidate — every guarantee (single transaction,
 *  idempotent replay, manual-retire refusal, unfrozen-policy refusal) lives there; this loop only
 *  selects due rows and counts outcomes. Shares the probe valve: probe off = no activation. */
export async function runActivationRound(): Promise<ActivationRoundResult> {
  if (!config.sourceProbeEnabled) return { skipped: "SOURCE_PROBE_ENABLED off" };
  const due = await sql<{ id: number }[]>`
    SELECT id FROM source_candidates
     WHERE status = 'eligible' AND NOT manual_retired
     ORDER BY updated_at, id
     LIMIT ${MAX_ACTIVATES_PER_ROUND}`;
  const out: ActivationRoundResult = { considered: due.length, activated: 0, created: 0, reused: 0, reasons: {} };
  for (const { id } of due) {
    let r;
    try {
      r = await activateCandidate(id);
    } catch (error) {
      const key = `error:${String(error instanceof Error ? error.message : error).slice(0, 80)}`;
      out.reasons![key] = (out.reasons![key] ?? 0) + 1;
      continue;
    }
    if (r.activated) {
      out.activated! += 1;
      if (r.created) out.created! += 1;
      else out.reused! += 1;
    } else {
      const key = r.reason ?? "unknown";
      out.reasons![key] = (out.reasons![key] ?? 0) + 1;
    }
  }
  return out;
}
