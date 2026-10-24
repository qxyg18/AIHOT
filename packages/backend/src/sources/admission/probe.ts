// The admission probe (TZR-20261003 T05): a bounded trial fetch of one candidate through the
// existing parsers, with zero business writes — no collectSource, no materials, no model calls, and
// createSource is not imported (activation is a later, separately governed card). Identity, rights,
// domain, date and relevance evidence is recorded per check (append-only); promotion to eligible is
// gated on the frozen policy — source-policy/2 (ym334) froze the thresholds at the mid tier, and
// since d-ym334 enforce (ym883) the candidate's own fetch numbers are truly compared against them
// before promotion (不足不转正); activation itself stays unwired (ym311/ym312).
import { SOURCE_POLICY_V1, meetsSourcePolicyThresholds } from "@aihot/industry/source-policy";
import { fetchRss } from "../rss.ts";
import { fetchWebList } from "../web-list.ts";
import { fetchJsonList } from "../json-list.ts";
import type { SourceRow, Candidate } from "../types.ts";
import { checkRobots } from "./robots.ts";
import {
  getCandidate, getRoot, latestHealthEvidence, recordCandidateCheck, touchProbe, transitionCandidate,
  type CandidateRow, type CheckKey, type CheckVerdict,
} from "./store.ts";

// Paid reader prefixes the probe must never call (single source: sources/web-list.ts JINA_PREFIX —
// kept as a literal copy so admission never imports the paid path to know its name).
const PAID_READ_PREFIXES = ["https://r.jina.ai/"];

const WINDOW_MS = 72 * 60 * 60 * 1000;

export interface ProbeCheckOutcome {
  checkKey: CheckKey;
  verdict: CheckVerdict;
}

export interface ProbeOutcome {
  candidateId: number;
  status: CandidateRow["status"];
  parkedReason?: string;
  notModified: boolean;
  checks: ProbeCheckOutcome[];
}

/** In-memory stand-in SourceRow so the existing parsers are reused verbatim; nothing is inserted
 *  into sources and the parsers below have no DB writes. */
function tempSourceRow(cand: CandidateRow, cursor: Record<string, any> | null): SourceRow {
  const config: Record<string, any> =
    cand.kind === "rss" ? { feedUrl: cand.url } : { url: cand.url };
  return {
    id: `probe:${cand.id}`,
    name: `probe:${cand.endpointIdentity}`,
    kind: cand.kind,
    config,
    tier: "t2",
    participation_mode: "editorial",
    first_party: false,
    interval_minutes: 0,
    enabled: false,
    cursor,
    fail_count: 0,
  };
}

export async function probeCandidate(candidateId: number, opts: { now?: Date; windowMs?: number } = {}): Promise<ProbeOutcome> {
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const policy = SOURCE_POLICY_V1;

  const cand = await getCandidate(candidateId);
  if (!cand) throw new Error(`probeCandidate: no candidate ${candidateId}`);
  if (cand.manualRetired || (cand.status !== "discovered" && cand.status !== "probing")) {
    return { candidateId, status: cand.status, notModified: false, checks: [] };
  }

  // CAS into probing; a stale worker (version moved) stops here without advancing anything.
  let row = cand;
  if (cand.status === "discovered") {
    const moved = await transitionCandidate({ candidateId, expectVersion: cand.version, fromStatuses: ["discovered"], toStatus: "probing" });
    if (!moved) return { candidateId, status: cand.status, notModified: false, checks: [] };
    row = moved;
  }
  const checks: ProbeCheckOutcome[] = [];
  const record = async (checkKey: CheckKey, verdict: CheckVerdict, evidence: Record<string, unknown>) => {
    await recordCandidateCheck({ candidateId, checkKey, verdict, evidence, policyVersion: policy.version });
    checks.push({ checkKey, verdict });
  };
  const park = async (reason: string): Promise<ProbeOutcome> => {
    // Re-read for the CAS: earlier steps (touchProbe) may have advanced the version since `row`.
    const cur = await getCandidate(candidateId);
    if (cur && cur.status === "probing") {
      await transitionCandidate({ candidateId, expectVersion: cur.version, fromStatuses: ["probing"], toStatus: "parked" });
    }
    return { candidateId, status: "parked", parkedReason: reason, notModified: false, checks };
  };

  const root = cand.rootId ? await getRoot(cand.rootId) : null;

  // The probe only ever speaks to the candidate's own endpoint: paid reader prefixes are refused
  // before ANY network call, robots included (health=fail, park, zero outbound requests — C1 / R15).
  if (PAID_READ_PREFIXES.some((p) => cand.url.startsWith(p))) {
    await record("health", "fail", { reason: "paid reader prefix refused before fetch", requests: 0 });
    return park("paid-prefix-refused");
  }

  // robots gate: fail (disallowed) parks; unknown (5xx/DNS) also parks — neither promotes (AC2).
  const robots = await checkRobots(cand.url, { now });
  await record("robots", robots.verdict, { reason: robots.reason, origin: robots.origin });
  if (robots.verdict !== "pass") return park(robots.verdict === "fail" ? "robots-disallowed" : "robots-unreachable");

  // Trial fetch through the existing parsers; the last health evidence restores etag/last-modified
  // so a normal 304 with no new items stays healthy (AC3).
  const last = await latestHealthEvidence(candidateId);
  const cursor = last?.validator ? { rss: last.validator } : null;
  const temp = tempSourceRow(cand, cursor);
  let samples: Candidate[] = [];
  let notModified = false;
  let validator: Record<string, unknown> | null = null;
  try {
    if (cand.kind === "rss") {
      const read = await fetchRss(temp);
      samples = read.candidates;
      notModified = read.notModified;
      validator = read.validator as unknown as Record<string, unknown>;
    } else if (cand.kind === "web_list") {
      samples = await fetchWebList(temp);
    } else {
      samples = await fetchJsonList(temp);
    }
  } catch (e) {
    await record("health", "fail", { reason: `trial fetch failed: ${String(e).slice(0, 200)}` });
    return park("probe-unreachable");
  }
  await record("health", "pass", { notModified, sampleCount: samples.length, ...(validator ? { validator } : {}) });

  // Evidence checks, each on its own (identity, rights, domain, date, relevance — plan §5 keeps
  // identity, rights, date, value and health apart; structural judgements only, thresholds stay
  // with the frozen policy and are never guessed here).
  const origins = new Set<string>([new URL(root?.rootUrl ?? cand.url).origin.toLowerCase()]);
  for (const o of root?.approvedOrigins ?? []) origins.add(o.toLowerCase());
  const finalUrl = (validator?.responseUrl as string | undefined) ?? cand.url;
  const domainOk = origins.has(new URL(finalUrl).origin.toLowerCase());
  await record("domain", domainOk ? "pass" : "fail", { finalUrl, approvedOrigins: [...origins] });

  const identityOk = root !== null && root.status === "approved" && Object.keys(root.identityEvidence ?? {}).length > 0;
  await record("identity", identityOk ? "pass" : "fail", { rootId: root?.id ?? null, rootStatus: root?.status ?? "missing" });

  const hasRights = root !== null && (Boolean(root.rightsNote) || Boolean(root.identityEvidence?.rights));
  await record("rights", hasRights ? "pass" : "unknown", { rightsNote: root?.rightsNote ?? null, evidenceRights: root?.identityEvidence?.rights ?? null });

  const dated = samples.filter((s) => s.publishedAt instanceof Date).length;
  const dateVerdict: CheckVerdict = notModified ? "pass" : samples.length === 0 ? "unknown" : dated >= 1 ? "pass" : "unknown";
  await record("date", dateVerdict, { dated, total: samples.length, notModified });

  const slug = root?.entitySlug ?? "";
  const matched = samples.filter((s) => slug && (`${s.title ?? ""} ${s.excerpt ?? ""}`).includes(slug)).length;
  const relevanceVerdict: CheckVerdict = notModified ? "pass" : samples.length > 0 && matched >= 1 ? "pass" : "unknown";
  await record("relevance", relevanceVerdict, { matched, total: samples.length, entitySlug: slug });

  // Sample counters move with CAS; a 304 keeps the previous counts (AC3: healthy, not failing).
  const samplesOk = notModified ? cand.samplesOk : dated;
  const samplesTotal = notModified ? cand.samplesTotal : samples.length;
  const touched = await touchProbe(candidateId, row.version, samplesOk, samplesTotal);
  const finalRow = touched ?? (await getCandidate(candidateId))!;

  // Promotion: hard gates all pass AND the candidate's own numbers truly meet the frozen policy
  // (d-ym334 enforce, ym883 — 逐条真比，不足不转正). An all-structural-pass candidate with too few
  // or too-irrelevant samples stays probing until a round that actually delivers the numbers; a
  // 304 round carries no fresh matched evidence so it never promotes by itself; a policy reverted
  // to null closes promotion again without any code change (meetsSourcePolicyThresholds → false).
  const hardPass = checks.every((c) => c.verdict === "pass");
  if (hardPass && meetsSourcePolicyThresholds(policy, {
    notModified,
    samplesOk: finalRow.samplesOk,
    samplesTotal: finalRow.samplesTotal,
    matched,
  })) {
    const promoted = await transitionCandidate({ candidateId, expectVersion: finalRow.version, fromStatuses: ["probing"], toStatus: "eligible" });
    if (promoted) return { candidateId, status: "eligible", notModified, checks };
  }

  // Observation window: when it elapses without a single usable sample, park for a later card to
  // dispose of explicitly (plan §5 — never an infinite window, never a fake 72h reliability pass).
  const windowElapsed = now.getTime() - Date.parse(finalRow.createdAt) >= windowMs;
  if (finalRow.status === "probing" && windowElapsed && finalRow.samplesOk < 1) {
    return park("window-elapsed-insufficient-samples");
  }
  return { candidateId, status: finalRow.status, notModified, checks };
}
