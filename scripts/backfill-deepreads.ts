// Backfills the deep reads (ka4): every published pool article gets its plain-language reading.
// Default fills only what is missing; --force also re-runs skipped/failed rows (vocab changed),
// --all regenerates everything including ready rows (prompt changed → they are paid again).
// Re-runnable: node --env-file=.env scripts/backfill-deepreads.ts [--limit N] [--force] [--all]
import { closeDb, sql } from "@aihot/backend/db";
import { sweepDeepReads } from "@aihot/backend/editorial/deepread";

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 0 : 0;
const force = argv.includes("--force");
const all = argv.includes("--all");

let cleared = 0;
if (force || all) {
  const rows = await sql<{ n: string }[]>`
    WITH cleared AS (
      DELETE FROM article_deep_reads WHERE ${all ? sql`TRUE` : sql`status <> 'ready'`} RETURNING article_id
    ) SELECT count(*)::text AS n FROM cleared`;
  cleared = Number(rows[0]?.n ?? 0);
}

const totals = { scanned: 0, ready: 0, skipped: 0, failed: 0 };
for (;;) {
  const r = await sweepDeepReads(50);
  totals.scanned += r.scanned;
  totals.ready += r.ready;
  totals.skipped += r.skipped;
  totals.failed += r.failed;
  if (r.scanned === 0) break;
  if (limit > 0 && totals.scanned >= limit) break;
}
console.log(JSON.stringify({ cleared, ...totals }));
await closeDb();
