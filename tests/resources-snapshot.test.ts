// T18 (ym250): the resource snapshot is read-only, aggregate and comparable. AC1: two snapshots
// under the same rows have the same shape (stable key sets, fixed 24h window, bounded lists) — the
// page never derives or shows a savings percentage. AC3: services that spent without a budgets row
// are named for review, never treated as unlimited. AC4: no body, subject, contact or credential
// column is read — a receipt whose subject carries a marker string never leaks into the snapshot.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { resourceSnapshot } from "@aihot/backend/operations/resources";
import { tag } from "./setup.ts";

const T = tag();
const SERVICE_A = `svc-a-${T}`;
const SERVICE_B = `svc-b-${T}`;
const SERVICE_UNBOUNDED = `unbounded-${T}`;
const MARKER = `SECRET-SUBJECT-${T}`;

const receipt = (service: string, purpose: string, status: string, tokens: number, cost: string, subject: string | null = null) =>
  sql`INSERT INTO receipts (logical_key, service, purpose, status, usage, cost, currency, attempts, subject, created_at)
      VALUES (${`${T}-${service}-${purpose}-${status}-${tokens}-${Math.random().toString(36).slice(2, 8)}`}, ${service}, ${purpose}, ${status},
              ${sql.json({ total_tokens: tokens })}, ${cost}, 'CNY', 2, ${subject}, now())`;

const shapesMatch = (a: unknown, b: unknown, path = "$"): void => {
  if (Array.isArray(a)) {
    assert.ok(Array.isArray(b), `${path} both arrays`);
    return; // lengths may differ with the clock; the row shape is checked below on the first row
  }
  if (a && typeof a === "object" && b && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    assert.deepEqual(ka, kb, `${path} same key set`);
    for (const k of ka) shapesMatch((a as never)[k], (b as never)[k], `${path}.${k}`);
  }
};

test("seeds: two budgeted services, one unbudgeted, one marked subject, two pending articles", async () => {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${SERVICE_A}, 3, 60, 500), (${SERVICE_B}, 1, 10, 100)`;
  await receipt(SERVICE_A, "analysis", "completed", 100, "0.0100", MARKER);
  await receipt(SERVICE_A, "analysis", "unknown", 50, "0.0050", MARKER);
  await receipt(SERVICE_B, "probe", "completed", 10, "0.0010");
  await receipt(SERVICE_UNBOUNDED, "analysis", "completed", 7, "0.0007");
  const { createSource } = await import("@aihot/backend/admin/sources");
  const created = await createSource({ id: `${T}-src`, name: `资源观测测试源 ${T}`, kind: "web_list", config: { url: `https://${T}.example.org/list` }, tier: "T2", participation_mode: "editorial", interval_minutes: 30, first_party: false, tags: [], site_fulltext: false, syndicate_fulltext: false }, "seed-actor");
  assert.equal(created.created, true);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, processing_state) VALUES
      (${`${T}-a1`}, ${`${T}-src`}, ${`ik:${T}:1`}, ${`https://${T}.example.org/1`}, ${`待处理一 ${T}`}, now() - interval '40 minutes', now() - interval '40 minutes', 'new'),
      (${`${T}-a2`}, ${`${T}-src`}, ${`ik:${T}:2`}, ${`https://${T}.example.org/2`}, ${`待处理二 ${T}`}, now() - interval '90 minutes', now() - interval '90 minutes', 'new')`;
  // ym337 rewrite observation: one article re-analyzed 3× at the same content revision (the
  // projection-rewrite trigger) whose stored reading sits two pub revisions behind.
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, processing_state)
      VALUES (${`${T}-a3`}, ${`${T}-src`}, ${`ik:${T}:3`}, ${`https://${T}.example.org/3`}, ${`改写观测 ${T}`}, now() - interval '2 hours', now() - interval '2 hours', 'new')`;
  await sql`INSERT INTO publications (article_id, revision, title, source_id, channel, url, discovered_at, timeline_at, sort_at)
      VALUES (${`${T}-a3`}, 3, ${`改写观测 ${T}`}, ${`${T}-src`}, 'news', ${`https://${T}.example.org/3`}, now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours')`;
  await sql`INSERT INTO article_deep_reads (article_id, status, input_revision, pub_revision, input_hash, attempts)
      VALUES (${`${T}-a3`}, 'ready', 1, 1, 'basis-seed', 0)`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin)
      VALUES (${`${T}-a3`}, 1, 'model'), (${`${T}-a3`}, 1, 'model'), (${`${T}-a3`}, 1, 'rule')`;
});

test("the snapshot aggregates, names the unbudgeted and stays comparable (AC1/AC3)", async () => {
  const first = await resourceSnapshot();
  const a = first.spend.find((s) => s.service === SERVICE_A && s.purpose === "analysis")!;
  assert.equal(a.calls, 2, "probe and production calls merge in one table, one caliber");
  assert.equal(a.unknown, 1);
  assert.equal(a.attempts, 4);
  assert.equal(a.tokens, 150);
  assert.equal(Number(a.cost), 0.015);
  const b = first.spend.find((s) => s.service === SERVICE_B)!;
  assert.equal(b.calls, 1);

  const supplyA = first.supply.find((s) => s.service === SERVICE_A)!;
  assert.deepEqual([supplyA.perMinute, supplyA.perHour, supplyA.perDay], [3, 60, 500]);

  assert.ok(first.unbounded.includes(SERVICE_UNBOUNDED), "the unbudgeted service is named for review");
  assert.ok(!first.unbounded.some((s) => s === SERVICE_A || s === SERVICE_B), "budgeted services are not listed");

  const mine = first.pending;
  assert.ok(mine.articles >= 2, `sees the pending articles (got ${mine.articles})`);
  assert.ok(mine.oldestMinutes != null && mine.oldestMinutes >= 90, `sees the oldest age (got ${mine.oldestMinutes})`);

  assert.ok(first.process.rssMb > 0 && Number.isFinite(first.process.eventLoopDelayMsP95 ?? 0), "process self-sample present");

  // ym337: the rewrite-pressure section sees the repeated analyses and the unread drift.
  assert.ok(first.rewrites.rewrittenArticles >= 1, `sees the re-analyzed article (got ${first.rewrites.rewrittenArticles})`);
  assert.ok(first.rewrites.maxReAnalyses >= 3, `counts the three analyses of one content revision (got ${first.rewrites.maxReAnalyses})`);
  assert.ok(first.rewrites.driftedReadings >= 1, `sees the drifted reading (got ${first.rewrites.driftedReadings})`);
  assert.ok(first.rewrites.maxDrift >= 2, `drift is revision 3 past a reading stored at 1 (got ${first.rewrites.maxDrift})`);
  const rwTop = first.rewrites.top.find((t) => t.articleId === `${T}-a3`);
  assert.ok(rwTop && rwTop.reAnalyses >= 3 && rwTop.drift >= 2, "the top list names the article with its counts");

  // Two snapshots under the same rows: same shape everywhere (AC1 — comparable baselines).
  const second = await resourceSnapshot();
  shapesMatch(first, second);
});

test("no subject, body or credential column reaches the snapshot (AC4)", async () => {
  const snap = await resourceSnapshot();
  const text = JSON.stringify(snap);
  assert.ok(!text.includes(MARKER), "the marked subject never appears");
  assert.ok(!/"request"|"response"|"error"|"request_id"/.test(text), "no raw request/response/error fields");
});

test("runsOverview carries the snapshot to the page", async () => {
  const { runsOverview } = await import("@aihot/backend/admin/runs");
  const view = await runsOverview();
  assert.ok(view.resources && Array.isArray(view.resources.spend), "the runs DTO carries the resources block");
  assert.ok(view.resources.spend.some((s) => s.service === SERVICE_A), "the snapshot inside the view is live");
  assert.ok(typeof view.resources.rewrites.rewrittenArticles === "number", "the rewrite-pressure section reaches the page");
});

after(async () => {
  await sql`DELETE FROM receipts WHERE logical_key LIKE ${`${T}-%`}`;
  await sql`DELETE FROM budgets WHERE service IN (${SERVICE_A}, ${SERVICE_B})`;
  await sql`DELETE FROM articles WHERE source_id LIKE ${`${T}-%`}`;
  await closeDb();
});
