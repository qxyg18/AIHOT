// Backfills the deep reads (ka4): every published pool article gets its plain-language reading.
// Default fills only what is missing; --force also re-runs skipped/failed rows (vocab changed),
// --all regenerates everything including ready rows (prompt changed → they are paid again).
// T09 (ym255): no mode deletes first. Every mode works article by article — a success replaces
// the row whole (transactional CAS upsert), a failure downgrades its status but never touches the
// reading payload columns, so an interrupted run leaves untouched rows exactly as they were. The
// run itself is bounded: --limit N scans at most N (the last batch is cut to fit), --max-batches
// and --wallclock-seconds cap the run, and consecutive rounds that scan but ready nothing on an
// unchanged failed set stop as no_progress. Whatever is left waiting (retry backoffs, a budget
// stop, rows never reached) is reported as waiting_external_window evidence instead of being
// silently dropped or mass-deleted.
// Re-runnable: node --env-file=.env scripts/backfill-deepreads.ts [--limit N] [--force] [--all]
//              [--max-batches K] [--wallclock-seconds S]
import { closeDb, sql } from "@aihot/backend/db";
import { generateDeepRead, sweepDeepReads } from "@aihot/backend/editorial/deepread";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SWEEP_BATCH = 50;
const PACE_MS = 1500; // matches sweepDeepReads' paid-call pacing
const NO_PROGRESS_ROUNDS = 2;

export interface BackfillDeepreadsSummary {
  cleared: number;
  scanned: number;
  ready: number;
  skipped: number;
  failed: number;
  stoppedReason: "completed" | "limit" | "max_batches" | "wallclock" | "no_progress" | "budget_stopped";
  waitingExternalWindow: {
    budgetStopped: boolean;
    pendingRetry: number;
    earliestRetryAt: string | null;
    /** --all/--force: selected entries the run never reached. Default mode: pool rows still
     *  lacking a ready reading when the run stopped (never a fake 0 — see the sweep-branch note). */
    unworked: number;
  };
}

/** Sorted ids of currently-failed rows: the "failed list" the no-progress bound compares across
 *  rounds — when consecutive zero-ready rounds scan the same failures nothing is moving. */
async function failedIdSet(): Promise<string> {
  const rows = await sql<{ article_id: string }[]>`
    SELECT article_id FROM article_deep_reads WHERE status = 'failed' ORDER BY article_id`;
  return rows.map((r) => r.article_id).join(",");
}

/** Failed rows parked on their retry backoff: the external time window this run leaves behind. */
async function retryWindow(): Promise<{ pendingRetry: number; earliestRetryAt: string | null }> {
  const [row] = await sql<{ n: string; earliest: Date | null }[]>`
    SELECT count(*)::text AS n, min(retry_at) AS earliest
    FROM article_deep_reads WHERE status = 'failed' AND retry_at IS NOT NULL AND retry_at > now()`;
  return { pendingRetry: Number(row?.n ?? 0), earliestRetryAt: row?.earliest ? new Date(row.earliest).toISOString() : null };
}

/** Call seams: tests inject fakes; production uses the real module functions. */
export interface BackfillDeepreadsDeps {
  sweep?: typeof sweepDeepReads;
  generate?: typeof generateDeepRead;
}

export async function runBackfillDeepreads(argv: string[], deps: BackfillDeepreadsDeps = {}): Promise<BackfillDeepreadsSummary> {
  const sweep = deps.sweep ?? sweepDeepReads;
  const generateOne = deps.generate ?? generateDeepRead;
  const num = (flag: string): number => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) || 0 : 0;
  };
  const limit = num("--limit");
  const maxBatches = num("--max-batches") || 40;
  const wallclockSeconds = num("--wallclock-seconds") || 1800;
  const force = argv.includes("--force");
  const all = argv.includes("--all");

  const startedAt = Date.now();
  const deadline = startedAt + wallclockSeconds * 1000;
  const totals = { scanned: 0, ready: 0, skipped: 0, failed: 0 };
  let stoppedReason: BackfillDeepreadsSummary["stoppedReason"] = "completed";
  let budgetStopped = false;
  let unworked = 0;

  // T09 (ym255): the old `--all` pre-DELETE is gone — `cleared` stays 0 in every mode and rows
  // are only ever replaced per article by a successful regeneration.
  const cleared = 0;

  if (force || all) {
    // Per-article regeneration (replace on success only). --all = the whole published pool,
    // --force = rows currently failed/skipped. Failures keep the old payload (module storeRow
    // semantics) and are retried later by the sweep's backoff, never re-deleted here.
    const ids = all
      ? await sql<{ article_id: string }[]>`
          SELECT p.article_id FROM publications p
          WHERE p.visibility = 'public' AND p.eligible AND p.title IS NOT NULL
          ORDER BY coalesce(p.published_at, p.discovered_at) DESC`
      : await sql<{ article_id: string }[]>`
          SELECT p.article_id FROM publications p
          JOIN article_deep_reads d ON d.article_id = p.article_id
          WHERE p.visibility = 'public' AND p.eligible AND p.title IS NOT NULL AND d.status IN ('failed', 'skipped')
          ORDER BY coalesce(p.published_at, p.discovered_at) DESC`;
    const selected = limit > 0 ? ids.slice(0, limit) : ids;
    for (const { article_id } of selected) {
      if (Date.now() >= deadline) { stoppedReason = "wallclock"; break; }
      let out: Awaited<ReturnType<typeof generateDeepRead>>;
      try {
        out = await generateOne(article_id);
      } catch (error) {
        // One bad article must not kill the run: count it and move on (the sweep retries it).
        totals.scanned += 1;
        totals.failed += 1;
        if (limit > 0 && totals.scanned >= limit) { stoppedReason = "limit"; break; }
        continue;
      }
      if (out.budgetStopped) {
        // Global stop: this article was not worked and the rest of the list is untouched.
        budgetStopped = true;
        stoppedReason = "budget_stopped";
        break;
      }
      totals.scanned += 1;
      if (out.status === "ready") {
        totals.ready += 1;
        await new Promise((resolve2) => setTimeout(resolve2, PACE_MS));
      } else if (out.status === "skipped") totals.skipped += 1;
      else totals.failed += 1;
      if (limit > 0 && totals.scanned >= limit) { stoppedReason = "limit"; break; }
    }
    unworked = selected.length - totals.scanned;
  } else {
    const deadline2 = deadline;
    let batches = 0;
    let prevFailedSet = "";
    let zeroReadyRounds = 0;
    while (batches < maxBatches) {
      if (Date.now() >= deadline2) { stoppedReason = "wallclock"; break; }
      const remaining = limit > 0 ? limit - totals.scanned : SWEEP_BATCH;
      if (remaining <= 0) { stoppedReason = "limit"; break; }
      const r = await sweep(Math.min(SWEEP_BATCH, remaining));
      batches += 1;
      totals.scanned += r.scanned;
      totals.ready += r.ready;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
      if (r.scanned === 0) break; // pool done for now (retry windows park the rest — see waitingExternalWindow)
      if (limit > 0 && totals.scanned >= limit) { stoppedReason = "limit"; break; }
      // No-progress bound (F6): rounds that scan but ready nothing on an unchanged failed list
      // are spinning — two in a row stop the run instead of looping forever.
      const failedSet = await failedIdSet();
      if (r.ready === 0) {
        zeroReadyRounds = failedSet === prevFailedSet ? zeroReadyRounds + 1 : 1;
        prevFailedSet = failedSet;
        if (zeroReadyRounds >= NO_PROGRESS_ROUNDS) { stoppedReason = "no_progress"; break; }
      } else {
        zeroReadyRounds = 0;
        prevFailedSet = failedSet;
      }
    }
    if (batches >= maxBatches && stoppedReason === "completed") stoppedReason = "max_batches";
    // T09 audit ISS-1: in the default mode `unworked` must reflect reality — count the pool that
    // still lacks a ready reading when the run stopped, so a 0 can never masquerade as "drained"
    // (rows parked on retry backoffs legitimately keep this above zero after a full drain; pair
    // it with pendingRetry to tell "done for now" from "nothing left").
    unworked = Number((
      await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM publications p
        LEFT JOIN article_deep_reads d ON d.article_id = p.article_id
        WHERE p.visibility = 'public' AND p.eligible AND p.title IS NOT NULL
          AND (d.article_id IS NULL OR d.status <> 'ready')`
    )[0]?.n ?? 0);
  }

  const waitingExternalWindow = { budgetStopped, ...(await retryWindow()), unworked };
  return { cleared, ...totals, stoppedReason, waitingExternalWindow };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runBackfillDeepreads(process.argv.slice(2))));
  await closeDb();
}
