// The ingest enabled gate (ym357): a source paused in the sources table refuses pushes with
// 409 and stores nothing — the scheduler being disabled on the host machine is not the gate.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "@aihot/backend/db";
import { IngestError, ingestItems } from "@aihot/backend/ingest/items";
import { stopBoss } from "@aihot/backend/jobs/queue";

after(() => stopBoss());

const is409 = (e: unknown) => e instanceof IngestError && e.status === 409;

test("a disabled source refuses ingest with 409 and stores nothing", async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
            VALUES ('ym357-disabled', 'YM357 Disabled', 'external', '{}'::jsonb, 'T2', 'isolated', 1440, false, 'ok', ARRAY['ym357-test'])
            ON CONFLICT (id) DO UPDATE SET enabled = false, name = EXCLUDED.name`;
  const pre = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = 'ym357-disabled'`;
  await assert.rejects(
    ingestItems({ sourceId: "ym357-disabled", sourceName: "YM357 Disabled", items: [{ title: "停用期间推送", url: "https://example.org/ym357/a" }] }),
    is409,
  );
  const post = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = 'ym357-disabled'`;
  assert.equal(post[0]!.n, pre[0]!.n, "the rejected push stored no article");
});

test("an enabled source ingests, and disabling it stops the next push at the gate", async () => {
  // Force-enable on entry: a previous run (or a concurrent one) may have left the row disabled,
  // and the test-db sweep only clears articles, not sources.
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
            VALUES ('ym357-enabled', 'YM357 Enabled', 'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ARRAY['ym357-test'])
            ON CONFLICT (id) DO UPDATE SET enabled = true, name = EXCLUDED.name`;
  await sql`DELETE FROM articles WHERE source_id = 'ym357-enabled'`;
  const ok = await ingestItems({ sourceId: "ym357-enabled", sourceName: "YM357 Enabled", items: [{ title: "正常推送", url: "https://example.org/ym357/b" }] });
  assert.equal(ok.created, 1);
  await sql`UPDATE sources SET enabled = false WHERE id = 'ym357-enabled'`;
  await assert.rejects(
    ingestItems({ sourceId: "ym357-enabled", items: [{ title: "停用后的推送", url: "https://example.org/ym357/c" }] }),
    is409,
  );
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = 'ym357-enabled'`;
  assert.equal(rows[0]!.n, 1, "only the pre-disable article exists");
});

test("ym371: a disabled-source rejection leaves an ingest_events refused-disabled audit row", async () => {
  // ym371 (shoumen P3-4 follow-up): the 409 gate now also writes an audit row so channel-reopen
  // observation periods can reconcile refused push attempts from the db, not just HTTP logs.
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
            VALUES ('ym371-disabled', 'YM371 Disabled', 'external', '{}'::jsonb, 'T2', 'isolated', 1440, false, 'ok', ARRAY['ym371-test'])
            ON CONFLICT (id) DO UPDATE SET enabled = false`;
  await sql`DELETE FROM ingest_events WHERE summary::text LIKE '%ym371-disabled%'`;
  await assert.rejects(
    ingestItems({ sourceId: "ym371-disabled", items: [{ title: "停用期推送", url: "https://example.org/ym371/a" }] }),
    is409,
  );
  const [row] = await sql<{ summary: unknown }[]>`
    SELECT summary FROM ingest_events
    WHERE client = 'ingest-items' AND status = 'refused-disabled'
      AND summary->>'sourceId' = 'ym371-disabled'
    ORDER BY created_at DESC LIMIT 1`;
  assert.ok(row, "refused-disabled audit row must exist");
  const summary = row!.summary as { sourceId?: string; received?: number };
  assert.equal(summary.sourceId, "ym371-disabled");
  assert.equal(summary.received, 1);
});
