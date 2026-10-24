// Applies database/migrations/*.sql in order, each in its own transaction. Safe to re-run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const dir = path.join(REPO_ROOT, "database/migrations");

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const text = readFileSync(path.join(dir, file), "utf8");
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block (upstream runner splits these
  // into a non-transactional plan); apply such files outside sql.begin, recording them after.
  if (/create index concurrently/i.test(text)) {
    await sql.unsafe(text);
    await sql`INSERT INTO schema_migrations (name) VALUES (${file}) ON CONFLICT DO NOTHING`;
  } else {
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
  }
  console.log(`applied ${file}`);
  count += 1;
}
console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
await closeDb();
