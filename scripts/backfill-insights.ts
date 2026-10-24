// Backfills the insight extraction pass (ka2): analyzed statistics (ym40) articles plus, since zw15
// (2026-10-01), channel-category articles whose title/summary mark a city retail report — their
// per-mall data points (客流/空置率/首店/开关店) feed the mall 档案. Same trigger as jobs/content.ts.
// T09 (ym255): selection goes through the realtime gate itself (insightEligible — pass plus any
// editorial category), so the backlog matches live processing exactly instead of a private
// keyword subset; and the run is receipt-budgeted: --max N caps how many extraction receipts one
// run may cause, the rest are reported as budgetDeferred instead of being queued.
// Idempotent — extraction replaces rows per article revision, and the queue dedupes by singletonKey.
// Re-runnable: node --env-file=.env scripts/backfill-insights.ts [--max N]
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, stopBoss } from "@aihot/backend/jobs/queue";
import { QUEUES } from "@aihot/backend/jobs/queue";
import { insightEligible } from "@aihot/backend/jobs/content";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_QUEUED = 200;

export interface BackfillInsightsSummary {
  queued: number;
  matchedArticles: number;
  budgetDeferred: number;
}

export async function runBackfillInsights(argv: string[]): Promise<BackfillInsightsSummary> {
  const maxIdx = argv.indexOf("--max");
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) || 0 : 0;
  const cap = max > 0 ? max : DEFAULT_MAX_QUEUED;

  // The pass prefilter only narrows the join; the realtime gate below decides eligibility.
  const rows = await sql<{ id: string; relevance: string | null; category: string | null }[]>`
    SELECT a.id, an.relevance, an.category FROM articles a
    JOIN analyses an ON an.id = (SELECT id FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1)
    WHERE an.relevance = 'pass'
    ORDER BY a.published_at DESC NULLS LAST`;
  const eligible = rows.filter((r) => insightEligible(r.relevance, r.category));

  let queued = 0;
  for (const r of eligible) {
    if (queued >= cap) break;
    await enqueue(QUEUES.insight, { articleId: r.id }, { singletonKey: `insight:${r.id}` });
    queued++;
  }
  return { queued, matchedArticles: eligible.length, budgetDeferred: eligible.length - queued };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summary = await runBackfillInsights(process.argv.slice(2));
  console.log(JSON.stringify(summary));
  await stopBoss();
  await closeDb();
}
