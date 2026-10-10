// T18 (ym250): one comparable, read-only snapshot of cost, queue and process resources.
// Nothing here writes, calls out, or acts on what it sees — the thresholds ym291 froze govern
// automatic adjustment, which stays a separate activated decision. The snapshot reads aggregate
// columns only: no request/response bodies, subjects, contacts or credentials ever leave the tables.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { sql } from "../db.ts";

export interface ResourceSpendRow {
  service: string;
  purpose: string;
  calls: number;
  unknown: number;
  attempts: number;
  tokens: number | null;
  cost: number | null;
}

export interface ResourceSnapshot {
  at: string;
  /** Model spend of the last 24 h, probe and production calls merged in one table, one caliber. */
  spend: ResourceSpendRow[];
  /** Rate supply the budgets table freezes (per service, three windows). */
  supply: Array<{ service: string; perMinute: number; perHour: number; perDay: number; note: string | null }>;
  /** Services that spent in the window but have no budgets row: named for review, never treated as unlimited. */
  unbounded: string[];
  /** Queue ages in the three in-flight states (pgboss, same caliber as the runs view). */
  queues: Array<{ name: string; state: string; n: number; oldestMinutes: number | null }>;
  /** Articles waiting for processing, with the age of the oldest. */
  pending: { articles: number; oldestMinutes: number | null };
  /** Projection-rewrite pressure on the deep-read chain (T08A M2, d-ym317 observe-only): rewrites
   * leave no history of their own, so they are read off the two anchors that exist — repeated
   * analyses of one content revision (the trigger candidates that may rewrite the projection) and
   * the drift of publications.revision past a stored reading. Observation only; nothing here
   * rewrites or retries. */
  rewrites: ResourceRewrites;
  /** Self-sample of the API process serving this snapshot. */
  process: { rssMb: number; heapUsedMb: number; heapTotalMb: number; eventLoopDelayMsP95: number | null; uptimeMinutes: number };
}

export interface ResourceRewrites {
  /** Articles (distinct) with more than one analysis of the same content revision in 24 h — each
   * repeat is a candidate rewrite: it voids the stored reading only if the projection changes. */
  rewrittenArticles: number;
  /** The heaviest (article, content revision) pair: analyses received in 24 h. Normal is 1. */
  maxReAnalyses: number;
  /** Articles whose projection moved past their stored reading: rewrites the sweep has not
   * re-read yet. Legacy readings (no pub_revision) carry no baseline and are not counted. */
  driftedReadings: number;
  /** Rewrites accumulated on the worst article since its stored reading. */
  maxDrift: number;
  /** Top offenders by repeated analyses, article ids only — no titles or bodies leave the tables. */
  top: Array<{ articleId: string; reAnalyses: number; drift: number }>;
}

// The event-loop histogram samples by itself on this Node (no start()): the percentile is
// read straight off the running process.
const loop = monitorEventLoopDelay({ resolution: 20 });

export async function resourceSnapshot(): Promise<ResourceSnapshot> {
  const [spend, supply, unbounded, queues, pending, rewriteTotals, rewriteTop] = await Promise.all([
    sql<ResourceSpendRow[]>`
      SELECT service, purpose, count(*)::int AS calls,
             count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
             sum(attempts)::int AS attempts,
             sum((usage->>'total_tokens')::bigint)::bigint AS tokens,
             sum(cost) AS cost
      FROM receipts WHERE created_at > now() - interval '24 hours'
      GROUP BY 1, 2 ORDER BY calls DESC, service, purpose LIMIT 40`,
    sql<{ service: string; perMinute: number; perHour: number; perDay: number; note: string | null }[]>`
      SELECT service, per_minute AS "perMinute", per_hour AS "perHour", per_day AS "perDay", note FROM budgets ORDER BY service`,
    sql<{ service: string }[]>`
      SELECT DISTINCT service FROM receipts
      WHERE created_at > now() - interval '24 hours' AND service NOT IN (SELECT service FROM budgets)
      ORDER BY 1`,
    sql<{ name: string; state: string; n: number; oldestMinutes: number | null }[]>`
      SELECT name, state, count(*)::int AS n,
             round(extract(epoch from (now() - min(created_on))) / 60)::int AS "oldestMinutes"
      FROM pgboss.job WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
    sql<{ articles: number; oldestMinutes: number | null }[]>`
      SELECT count(*)::int AS articles,
             round(extract(epoch from (now() - min(discovered_at))) / 60)::int AS "oldestMinutes"
      FROM articles WHERE processing_state = 'new'`,
    // Rewrite pressure, same 24 h window as spend. Re-analyses of one content revision are the
    // observable trigger candidates; drift is rewrites the sweep still owes a re-read.
    sql<{ rewrittenArticles: number; maxReAnalyses: number; driftedReadings: number; maxDrift: number }[]>`
      WITH repeats AS (
        SELECT count(DISTINCT article_id)::int AS articles, coalesce(max(n), 0)::int AS max_n FROM (
          SELECT article_id, count(*)::int AS n FROM analyses
          WHERE created_at > now() - interval '24 hours'
          GROUP BY article_id, input_revision HAVING count(*) > 1) g
      ), drift AS (
        SELECT count(*)::int AS articles, coalesce(max(p.revision - d.pub_revision), 0)::int AS max_n
        FROM article_deep_reads d JOIN publications p ON p.article_id = d.article_id
        WHERE d.pub_revision IS NOT NULL AND p.revision > d.pub_revision
      )
      SELECT repeats.articles AS "rewrittenArticles", repeats.max_n AS "maxReAnalyses",
             drift.articles AS "driftedReadings", drift.max_n AS "maxDrift"
      FROM repeats, drift`,
    sql<{ articleId: string; reAnalyses: number; drift: number }[]>`
      WITH per AS (
        SELECT article_id, max(n)::int AS n FROM (
          SELECT article_id, input_revision, count(*)::int AS n
          FROM analyses WHERE created_at > now() - interval '24 hours'
          GROUP BY article_id, input_revision HAVING count(*) > 1) x
        GROUP BY article_id ORDER BY max(n) DESC, article_id LIMIT 5
      )
      SELECT per.article_id AS "articleId", per.n AS "reAnalyses",
             coalesce((SELECT p.revision - d.pub_revision FROM article_deep_reads d
                       JOIN publications p ON p.article_id = d.article_id
                       WHERE d.article_id = per.article_id AND d.pub_revision IS NOT NULL), 0)::int AS "drift"
      FROM per ORDER BY per.n DESC, per.article_id`,
  ]);
  const mem = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    spend,
    supply,
    unbounded: unbounded.map((r) => r.service),
    queues,
    pending: { articles: pending[0]?.articles ?? 0, oldestMinutes: pending[0]?.oldestMinutes ?? null },
    rewrites: {
      rewrittenArticles: rewriteTotals[0]?.rewrittenArticles ?? 0,
      maxReAnalyses: rewriteTotals[0]?.maxReAnalyses ?? 0,
      driftedReadings: rewriteTotals[0]?.driftedReadings ?? 0,
      maxDrift: rewriteTotals[0]?.maxDrift ?? 0,
      top: rewriteTop,
    },
    process: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      eventLoopDelayMsP95: Math.round(loop.percentile(95) / 1e6),
      uptimeMinutes: Math.round(process.uptime() / 60),
    },
  };
}
