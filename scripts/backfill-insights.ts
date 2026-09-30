// Backfills the insight extraction pass (ka2): every analyzed research-category article gets its
// report viewpoints pulled. Idempotent — extraction replaces rows per article revision, and the
// queue dedupes by singletonKey. Re-runnable: node --env-file=.env scripts/backfill-insights.ts
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, stopBoss } from "@aihot/backend/jobs/queue";
import { QUEUES } from "@aihot/backend/jobs/queue";

const rows = await sql<{ id: string }[]>`
  SELECT a.id FROM articles a
  JOIN analyses an ON an.id = (SELECT id FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1)
  WHERE an.relevance = 'pass' AND an.category = 'research'
  ORDER BY a.published_at DESC NULLS LAST`;

let queued = 0;
for (const r of rows) {
  await enqueue(QUEUES.insight, { articleId: r.id }, { singletonKey: `insight:${r.id}` });
  queued++;
}
console.log(JSON.stringify({ queued, researchArticles: rows.length }));
await stopBoss();
await closeDb();
