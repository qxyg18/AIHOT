// Deletes invariant-test residue from the shared test database: articles rows left in
// processing_state 'new'/'failed' age two hours into alerts-suite poison, because the alerts
// recovery assertion depends on a whole-table waiting scan (ym83). Child rows go with them
// (every articles foreign key is ON DELETE CASCADE). Refuses to run against anything but a
// throwaway *_test/_ci database, same gate as tests/setup.ts.
import { closeDb, sql } from "@aihot/backend/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
if (!/_(test|ci)$/.test(database)) {
  throw new Error(`Cleanup deletes rows: point DATABASE_URL at a throwaway database named *_test or *_ci (got "${database}")`);
}

const removed = await sql<{ id: string }[]>`DELETE FROM articles WHERE processing_state IN ('new', 'failed') RETURNING id`;
console.log(`[test-db-cleanup] removed ${removed.length} residue article(s) (new/failed) from ${database}`);
await closeDb();
