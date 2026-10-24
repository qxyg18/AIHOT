// Candidate persistence for the admission engine (TZR-20261003 T05): the only writer of the T01
// contract tables (0052: source_official_roots / source_candidates / source_candidate_checks).
// Business tables are never touched — the probe engine writes no articles, analyses, receipts or
// jobs; checks are append-only evidence, and version CAS keeps stale workers from advancing a row.
import { sql } from "../../db.ts";

export interface OfficialRootRow {
  id: string;
  entityType: "brand" | "mall";
  entitySlug: string;
  rootUrl: string;
  /** Approved origins: same-origin discovery only happens inside this set (plan §5). */
  approvedOrigins: string[];
  identityEvidence: Record<string, any>;
  rightsNote: string | null;
  status: "approved" | "suspended";
  verifiedAt: string | null;
  verifiedBy: string | null;
}

export type CandidateStatus = "discovered" | "probing" | "eligible" | "activated" | "parked" | "rejected";
export type CandidateKind = "rss" | "web_list" | "json_list";
export type CheckKey = "identity" | "rights" | "domain" | "robots" | "date" | "relevance" | "health";
export type CheckVerdict = "pass" | "fail" | "unknown";

export interface CandidateRow {
  id: number;
  endpointIdentity: string;
  url: string;
  kind: CandidateKind;
  rootId: string | null;
  discoveredVia: string;
  status: CandidateStatus;
  policyVersion: string;
  configHash: string;
  proofHash: string;
  version: number;
  samplesOk: number;
  samplesTotal: number;
  lastProbeAt: string | null;
  manualRetired: boolean;
  retiredAt: string | null;
  retiredBy: string | null;
  retireReason: string | null;
  activatedSourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRoot(r: Record<string, any>): OfficialRootRow {
  return {
    id: r.id,
    entityType: r.entity_type,
    entitySlug: r.entity_slug,
    rootUrl: r.root_url,
    approvedOrigins: (r.approved_origins ?? []) as string[],
    identityEvidence: (r.identity_evidence ?? {}) as Record<string, any>,
    rightsNote: r.rights_note ?? null,
    status: r.status,
    verifiedAt: r.verified_at ?? null,
    verifiedBy: r.verified_by ?? null,
  };
}

const CAND_COLS = sql`id, endpoint_identity, url, kind, root_id, discovered_via, status, policy_version,
  config_hash, proof_hash, version, samples_ok, samples_total, last_probe_at, manual_retired,
  retired_at, retired_by, retire_reason, activated_source_id, created_at, updated_at`;

function mapCandidate(r: Record<string, any>): CandidateRow {
  return {
    id: Number(r.id),
    endpointIdentity: r.endpoint_identity,
    url: r.url,
    kind: r.kind,
    rootId: r.root_id ?? null,
    discoveredVia: r.discovered_via ?? "",
    status: r.status,
    policyVersion: r.policy_version ?? "",
    configHash: r.config_hash ?? "",
    proofHash: r.proof_hash ?? "",
    version: Number(r.version),
    samplesOk: Number(r.samples_ok),
    samplesTotal: Number(r.samples_total),
    lastProbeAt: r.last_probe_at ?? null,
    manualRetired: Boolean(r.manual_retired),
    retiredAt: r.retired_at ?? null,
    retiredBy: r.retired_by ?? null,
    retireReason: r.retire_reason ?? null,
    activatedSourceId: r.activated_source_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Stable identity for dedupe: lowercase host, no fragment, no trailing slash; the query stays. */
export function endpointIdentityOf(url: string): string {
  const u = new URL(url);
  const q = u.search || "";
  return u.host.toLowerCase() + u.pathname.replace(/\/+$/, "") + q;
}

export async function listApprovedRoots(): Promise<OfficialRootRow[]> {
  const rows = await sql`SELECT * FROM source_official_roots WHERE status = 'approved'`;
  return rows.map(mapRoot);
}

export async function getRoot(rootId: string): Promise<OfficialRootRow | null> {
  const [r] = await sql`SELECT * FROM source_official_roots WHERE id = ${rootId}`;
  return r ? mapRoot(r) : null;
}

export async function getCandidate(candidateId: number): Promise<CandidateRow | null> {
  const [r] = await sql`SELECT ${CAND_COLS} FROM source_candidates WHERE id = ${candidateId}`;
  return r ? mapCandidate(r) : null;
}

export interface UpsertOutcome {
  candidate: CandidateRow;
  created: boolean;
  /** A manually retired candidate stays retired: re-discovery returns it untouched (plan §5). */
  suppressedByTombstone: boolean;
}

/** Idempotent by endpoint_identity (0052 UNIQUE). An existing row — retired or not — is returned
 *  untouched: re-discovery never duplicates a candidate and never revives a tombstone. */
export async function upsertCandidate(input: {
  endpointIdentity: string;
  url: string;
  kind: CandidateKind;
  rootId?: string | null;
  discoveredVia?: string;
}): Promise<UpsertOutcome> {
  const [row] = await sql`
    INSERT INTO source_candidates (endpoint_identity, url, kind, root_id, discovered_via)
    VALUES (${input.endpointIdentity}, ${input.url}, ${input.kind}, ${input.rootId ?? null}, ${input.discoveredVia ?? ""})
    ON CONFLICT (endpoint_identity) DO NOTHING
    RETURNING ${CAND_COLS}`;
  if (row) return { candidate: mapCandidate(row), created: true, suppressedByTombstone: false };
  const [existing] = await sql`SELECT ${CAND_COLS} FROM source_candidates WHERE endpoint_identity = ${input.endpointIdentity}`;
  if (!existing) throw new Error(`upsertCandidate: conflict row vanished for ${input.endpointIdentity}`);
  return { candidate: mapCandidate(existing), created: false, suppressedByTombstone: Boolean(existing.manual_retired) };
}

/** Checks arrive as INSERT-only evidence; 0052 triggers reject UPDATE/DELETE/TRUNCATE. */
export async function recordCandidateCheck(input: {
  candidateId: number;
  checkKey: CheckKey;
  verdict: CheckVerdict;
  evidence?: Record<string, unknown>;
  policyVersion: string;
}): Promise<void> {
  await sql`
    INSERT INTO source_candidate_checks (candidate_id, check_key, verdict, evidence, policy_version)
    VALUES (${input.candidateId}, ${input.checkKey}, ${input.verdict}, ${sql.json((input.evidence ?? {}) as never)}, ${input.policyVersion})`;
}

/** Version-optimistic status transition; a stale worker gets null and does not advance the row. */
export async function transitionCandidate(t: {
  candidateId: number;
  expectVersion: number;
  fromStatuses: CandidateStatus[];
  toStatus: CandidateStatus;
}): Promise<CandidateRow | null> {
  const [row] = await sql`
    UPDATE source_candidates
       SET status = ${t.toStatus}, version = version + 1, updated_at = now()
     WHERE id = ${t.candidateId} AND version = ${t.expectVersion}
       AND status = ANY(${t.fromStatuses})
    RETURNING ${CAND_COLS}`;
  return row ? mapCandidate(row) : null;
}

/** CAS sample-count update for a probing candidate; null on version/status mismatch. */
export async function touchProbe(
  candidateId: number,
  expectVersion: number,
  samplesOk: number,
  samplesTotal: number,
): Promise<CandidateRow | null> {
  const [row] = await sql`
    UPDATE source_candidates
       SET samples_ok = ${samplesOk}, samples_total = ${samplesTotal}, last_probe_at = now(),
           version = version + 1, updated_at = now()
     WHERE id = ${candidateId} AND version = ${expectVersion} AND status = 'probing'
    RETURNING ${CAND_COLS}`;
  return row ? mapCandidate(row) : null;
}

/** The probe reuses the last health evidence (etag/last-modified) so a normal 304 stays healthy. */
export async function latestHealthEvidence(candidateId: number): Promise<Record<string, any> | null> {
  const [row] = await sql`
    SELECT evidence FROM source_candidate_checks
     WHERE candidate_id = ${candidateId} AND check_key = 'health'
     ORDER BY checked_at DESC LIMIT 1`;
  return row ? ((row.evidence ?? {}) as Record<string, any>) : null;
}
