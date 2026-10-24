// Manual entry for the monthly macro refresh (ym770). The worker's macro.refresh schedule calls the
// same module; this script is for a backfill after downtime or for diagnosing a page change:
//   node --env-file-if-exists=.env scripts/fetch-macro.ts             # dry run: parse and print, no write
//   node --env-file-if-exists=.env scripts/fetch-macro.ts --apply     # write when the release is new
//   node --env-file-if-exists=.env scripts/fetch-macro.ts --apply --url=<release page>
// Writing is opt-in so a diagnostic run can never touch the board by accident.
import { closeDb } from "@aihot/backend/db";
import { refreshMacroFromNbs } from "@aihot/backend/macro/nbs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const url = args.find((a) => a.startsWith("--url="))?.slice("--url=".length);

const result = await refreshMacroFromNbs({ dryRun: !apply, pageUrl: url });
const r = result.release;
console.log(JSON.stringify({
  status: result.status,
  release: {
    year: r.year, month: r.month, seq: r.seq, label: r.label, publishedAt: r.publishedAt, sourceUrl: r.sourceUrl,
    retail: r.retail, retailYtd: r.retailYtd, apparel: r.apparel, apparelYtd: r.apparelYtd,
  },
  rowsWritten: result.rowsWritten,
  indicatorsUpdated: result.indicatorsUpdated,
}, null, 2));
await closeDb();
