// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});

test("a selection drought with collection alive reaches the digest (ym768)", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  const drought = async (at: number) => (await collectFindings(at)).filter((f) => f.key === "content.selected");

  // The shared test database keeps publications from earlier suites/runs (the sweep only clears
  // new/failed articles); a leftover selected row would anchor max(selected_ready_at) and mask
  // the case below. Control the selection state for this test.
  await sql`UPDATE publications SET selected = false WHERE selected`;

  // Nothing selected yet: max(selected_ready_at) is NULL, no drought claim.
  assert.equal((await drought(t0)).length, 0);

  // Last selection 40h ago while articles keep arriving (the before() seeds ten 3h-old ones):
  // the scoring chain looks stalled → digest-level finding naming the last selection time.
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, selected, selected_ready_at)
            VALUES (${ids[0]}, ${`drought ${T}`}, ${SOURCE}, 'news', ${`https://example.com/${T}-sel`},
                    now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', true, ${new Date(t0 - 40 * 3600_000)})`;
  const found = await drought(t0);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, "digest");

  // A selection one hour ago means no drought.
  await sql`UPDATE publications SET selected_ready_at = ${new Date(t0 - 3600_000)} WHERE article_id = ${ids[0]}`;
  assert.equal((await drought(t0)).length, 0);

  // Collection itself stalled (nothing discovered in 6h) is content.collect's message, not the
  // drought's: the same 40h-old selection must stay silent when no fresh articles arrive.
  await sql`UPDATE publications SET selected_ready_at = ${new Date(t0 - 40 * 3600_000)} WHERE article_id = ${ids[0]}`;
  await sql`UPDATE articles SET discovered_at = now() - interval '7 hours' WHERE id IN ${sql(ids)}`;
  assert.equal((await drought(t0)).length, 0);
});
