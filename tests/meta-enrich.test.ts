// Metadata backfill (ym253): a source's dateless stored articles get one bounded pass of date-only
// detail requests per run; a filled date goes through the material entrance's metadata path (no
// revision, no analysis, no re-fetch of content), the public projection follows by republishing,
// and a report that turns historical hands its heat evidence back through the existing regroup path
// (reset by the grouping job, decided again with no model call) — never by accumulating a second
// signal, and never by re-releasing an old item.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { enrichMissingMetadata } from "@aihot/backend/sources/metadata";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { config } from "@aihot/backend/config";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
const DAY = 86_400_000;

// The detail pages: /ok/* carry a date 30 days old (older than discovery → historical flip), /fresh/*
// a date two hours before discovery (inside the 48 h window → no flip), /upd a date two hours ago
// (later than the day-old discovery: an update stamp, not a publication date → unusable → backoff),
// /err always 503, /far a date in the far future (discarded the same way).
const OLD = new Date(Date.now() - 30 * DAY).toISOString();
const FRESH = new Date(Date.now() - 26 * 3600_000).toISOString();
const UPD = new Date(Date.now() - 2 * 3600_000).toISOString();
const FAR = new Date(Date.now() + 40 * DAY).toISOString();
const page = (iso: string) => `<html><head><meta property="article:published_time" content="${iso}"></head><body>x</body></html>`;
let detailHits = 0;
const htmlServer = http.createServer((req, res) => {
  detailHits += 1;
  const path = new URL(req.url ?? "/", "http://stub").pathname;
  if (path.includes("/err")) { res.writeHead(503); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(path.includes("/far") ? FAR : path.includes("/upd") ? UPD : path.includes("/fresh") ? FRESH : OLD));
});
await new Promise<void>((resolve) => htmlServer.listen(0, "127.0.0.1", resolve));
// A per-run path prefix keeps the URL identity keys unique across reruns against the same database.
const url = (p: string) => `http://127.0.0.1:${(htmlServer.address() as { port: number }).port}/${T}/${p}`;

// Every source's listing answers an empty array: the run succeeds with no new material, so the
// metadata pass is the only thing left to observe. Each case gets its own source (own cursor).
const listingStub = await stub(() => []);
config.allowPrivateNetworkFetch = true;

let n = 0;
/** A fresh json_list source per case, so cursor progress never leaks between cases. */
async function freshSource(): Promise<string> {
  const id = `test-meta-${T}-${n++}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${id}, 'Test meta', 'json_list', ${sql.json({ url: listingStub.url + "/list" })}, 'T1', 'editorial', NULL, '2100-01-01')`;
  return id;
}

/** A dateless stored article of the source (the state the backfill starts from), under the identity
 *  key the material entrance itself would give it. */
async function dateless(source: string, u: string, publishedAt: Date | null = null): Promise<string> {
  const id = `m${T}${n}${Math.floor(Math.random() * 1e9).toString(36)}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, revision, content_hash, body_text, body_status, processing_state, backfill, grouped_at)
            VALUES (${id}, ${source}, ${identityKeyForUrl(u)}, ${u}, ${"Title " + id}, now() - interval '1 day', now() - interval '1 day',
                    ${publishedAt}, 1, ${"hash-" + id}, ${"body " + id}, 'ok', 'analyzed', false, now())`;
  await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
            VALUES (${id}, 1, ${"hash-" + id}, ${"Title " + id}, ${"body " + id})`;
  return id;
}

async function sourceRow(source: string): Promise<SourceRow> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${source}`;
  return s!;
}

const writeCursor = (source: string, progress: unknown) =>
  sql`UPDATE sources SET cursor = ${sql.json({ metaEnrich: progress } as never)} WHERE id = ${source}`;

after(async () => {
  await listingStub.close();
  htmlServer.close();
  await stopBoss();
  await closeDb();
});

const row = async (id: string) =>
  (await sql<{ revision: number; content_hash: string | null; processing_state: string; published_at: Date | null; timeline_at: Date; backfill: boolean; backfill_reason: string | null }[]>`
    SELECT revision, content_hash, processing_state, published_at, timeline_at, backfill, backfill_reason FROM articles WHERE id = ${id}`)[0]!;

test("a dateless article is filled over bounded runs: two per run, three runs, then quiet (AC1)", async () => {
  const SOURCE = await freshSource();
  const urls = [1, 2, 3, 4, 5, 6].map((k) => url(`ok/${k}`));
  const ids: string[] = [];
  for (const u of urls) ids.push(await dateless(SOURCE, u));
  const revisions = await Promise.all(ids.map((id) => row(id).then((r) => r.revision)));

  let pass = 0;
  let filled = 0;
  while (filled < urls.length && pass < 6) {
    pass += 1;
    const r = await enrichMissingMetadata(await sourceRow(SOURCE));
    filled += r.enriched;
    await writeCursor(SOURCE, r.progress); // the collection run persists the cursor the same way
  }
  assert.equal(pass, 3, "six dateless URLs at two per run take exactly three runs");
  assert.equal(filled, 6);
  const after = await Promise.all(ids.map((id) => row(id)));
  assert.ok(after.every((c) => c.published_at !== null), "every URL now carries its real date");
  assert.deepEqual(after.map((c) => c.revision), revisions, "no content revision for any of them");
  assert.ok(after.every((c) => c.backfill && c.backfill_reason === "stale-on-discovery"), "a 30-day-old date recasts them as history");

  const hits = detailHits;
  const quiet = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.deepEqual([quiet.checked, quiet.enriched], [0, 0], "nothing left to check");
  assert.equal(detailHits, hits, "a filled URL is never fetched again (AC1)");
});

test("the pass runs inside a successful collection run and reports its counts (integration)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("ok/integration"));
  const run = await collectSource(SOURCE, { force: true });
  assert.equal(run.status, "ok");
  const [s] = await sql<{ cursor: { metaEnrich?: unknown } }[]>`SELECT cursor FROM sources WHERE id = ${SOURCE}`;
  assert.ok(s!.cursor.metaEnrich, "the progress cursor is persisted by the run");
  const [fr] = await sql<{ detail: { metaEnrich?: { checked: number; enriched: number } } }[]>`
    SELECT detail FROM fetch_runs WHERE source_id = ${SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([fr!.detail.metaEnrich!.checked, fr!.detail.metaEnrich!.enriched], [1, 1]);
  assert.ok((await row(id)).published_at !== null, "the article got its date through the collection path");
});

test("a 503 detail page backs off and gives up after bounded attempts (AC1)", async () => {
  const SOURCE = await freshSource();
  const u = url("err/1");
  await dateless(SOURCE, u);
  // Four failures are already on record and due: the next failure is the fifth and last.
  await writeCursor(SOURCE, { failed: { [u]: { attempts: 4, retryAfter: new Date(Date.now() - 1000).toISOString() } } });

  const r = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.equal(r.failed, 1);
  const tomb = r.progress.failed[u]!;
  assert.equal(tomb.attempts, 5, "the fifth failure is the last");
  assert.ok(Date.parse(tomb.retryAfter) > Date.now() + 365 * DAY, "a given-up URL is tombstoned, never fetched again");
  await writeCursor(SOURCE, r.progress); // the run persists the tombstone before the next pass
  const hits = detailHits;
  const quiet = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.equal(quiet.checked, 0, "the tombstone keeps it out of later windows");
  assert.equal(detailHits, hits);
});

test("a date the timeline rule discards fills nothing and backs off (AC3: far future, or an update stamp after discovery)", async () => {
  for (const path of ["far/1", "upd/1"]) {
    const SOURCE = await freshSource();
    const id = await dateless(SOURCE, url(path));
    const r = await enrichMissingMetadata(await sourceRow(SOURCE));
    assert.equal(r.enriched, 0, `${path}: nothing is filled`);
    assert.equal(r.failed, 1, `${path}: it backs off instead of looping every run`);
    const first = r.progress.failed[url(path)]!;
    assert.equal(first.attempts, 1, `${path}: first failure`);
    const in2h = Date.parse(first.retryAfter) - Date.now();
    assert.ok(in2h > 1.9 * 3600_000 && in2h < 2.1 * 3600_000, `${path}: the first backoff is two hours (2^n hours, capped at 7 days)`);
    assert.ok((await row(id)).published_at === null, `${path}: no unusable date is stored`);
  }
});

test("an existing date is never overwritten by a later report (AC3)", async () => {
  const SOURCE = await freshSource();
  const u = url("ok/w1");
  const manual = new Date(Date.now() - 5 * DAY);
  const id = await dateless(SOURCE, u, manual);
  const res = await upsertMaterial({ sourceId: SOURCE, url: u, title: "Title " + id, publishedAt: new Date(Date.now() - 30 * DAY), discoveredAt: new Date(Date.now() - DAY), via: "fetch" });
  assert.equal(res.metaDateFilled, undefined, "a report does not take the metadata path when a date exists");
  assert.equal((await row(id)).published_at?.getTime(), manual.getTime(), "the stored date stands");
});

test("the fill records no revision and starts no analysis or paid work (AC3)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("ok/nr"));
  const before = await row(id);
  const [receiptsBefore] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  const res = await upsertMaterial({ sourceId: SOURCE, url: url("ok/nr"), title: "Title " + id, publishedAt: new Date(Date.now() - 3 * DAY), discoveredAt: new Date(Date.now() - DAY), via: "fetch" });
  assert.ok(res.metaDateFilled);
  const after = await row(id);
  assert.equal(after.revision, before.revision, "the revision counter does not move");
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.processing_state, before.processing_state);
  const [revAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM article_revisions WHERE article_id = ${id}`;
  assert.equal(revAfter.n, 1, "no history row for a date-only fill");
  const [receiptsAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  assert.equal(receiptsAfter.n, receiptsBefore.n, "no receipt rows appear");
});

test("a fill inside the window republishes the projection without re-releasing (AC2)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("fresh/r6"));
  const [ledgerBefore] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM selected_ledger`;
  const r = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.equal(r.enriched, 1);
  const [pub] = await sql<{ published_at: Date | null; backfill: boolean }[]>`
    SELECT published_at, backfill FROM publications WHERE article_id = ${id}`;
  assert.ok(pub, "the projection row exists");
  assert.ok(pub!.published_at !== null, "the projection carries the real date");
  assert.equal(pub!.backfill, false, "two hours before discovery is inside the window, not history");
  const [ledgerAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM selected_ledger`;
  assert.equal(ledgerAfter.n, ledgerBefore.n, "nothing is pushed or re-released for a backfill");
});

test("a fill that turns a report historical moves its heat evidence out through the regroup path (AC2)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("ok/flip"));
  // The report sits in a story with automatic membership and heat evidence.
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, 'Flip story', now() - interval '2 days', now() - interval '2 days') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, created_at)
    VALUES (${"fact-" + randomUUID()}, ${story!.id}, 'Flip fact', now() - interval '2 days') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role, manual) VALUES (${fact!.id}, ${id}, 'report', false)`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${story!.id}, ${id}, ${"source:" + SOURCE}, ${SOURCE}, 'editorial', now())`;

  const r = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.equal(r.enriched, 1);
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regroup_pending WHERE article_id = ${id}`;
  assert.equal(pending!.n, 1, "the regroup path is armed for the flip");

  const [receiptsBefore] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  const verdict = await groupArticle(id);
  assert.equal(verdict.verdict, "historical", "the historical branch decides it again");
  const [receiptsAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  assert.equal(receiptsAfter.n, receiptsBefore.n, "no model call for a historical re-decision");
  const [signals] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM story_signals WHERE article_id = ${id}`;
  assert.equal(signals!.n, 0, "its heat evidence is gone, not doubled");
  const [pendingAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regroup_pending WHERE article_id = ${id}`;
  assert.equal(pendingAfter!.n, 0, "the pending row cleared with the decision");
  const [pub] = await sql<{ timeline_at: Date; backfill: boolean }[]>`SELECT timeline_at, backfill FROM publications WHERE article_id = ${id}`;
  assert.ok(pub!.backfill, "it republished as history under the real date");
});

test("a fill that turns a report historical moves its public timeline card to the real date (AC2, timeline)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("ok/r10"));
  // The report is on the public timeline, selected and released, standing at its discovery-time slot.
  // Its own tag scopes the timeline to this card alone: the shared test database holds hundreds of
  // other cards whose anchors sit between "now" and the backfilled date.
  const CARD_TAG = `ym253-r10-${T}`;
  await sql`INSERT INTO publications (article_id, revision, visibility, eligible, selected, title, tags, source_id,
              channel, url, published_at, discovered_at, timeline_at, backfill, selected_ready_at, visible_after,
              body_mode, syndicate, indexable, search_text, sort_at, updated_at)
            SELECT a.id, 1, 'public', true, true, a.title, ${[CARD_TAG]}, a.source_id, 'news', a.url, NULL,
                   a.discovered_at, a.discovered_at, false, a.discovered_at, a.discovered_at, 'summary', false, false, '', now(), now()
            FROM articles a WHERE a.id = ${id}`;
  // An editor's pick keeps it selected through a republish (no analysis row exists to judge it);
  // its tags survive the republish the same way, so the tag keeps scoping the timeline to this card.
  await sql`INSERT INTO editorial_overrides (article_id, fields)
            VALUES (${id}, ${sql.json({ selected: true, relevance: "pass", title: "时间线归位测试中文标题", summary: "时间线归位测试摘要", tags: [CARD_TAG] } as never)})`;
  const findCard = async (): Promise<{ anchorAt: string } | null> =>
    (await loadTimeline({ now: new Date(), limit: 40, channel: "all", category: null, tag: CARD_TAG })).cards.find((c) => c.key === `a${id}`) ?? null;
  const cardBefore = await findCard();
  assert.ok(cardBefore, "the card is on the timeline before the fill");

  // The fill (30 days old) flips it to history; the regroup path republishes it at its source time.
  const r = await enrichMissingMetadata(await sourceRow(SOURCE));
  assert.equal(r.enriched, 1);
  await groupArticle(id);
  const [pub] = await sql<{ sort_at: Date; timeline_at: Date; published_at: Date | null }[]>`
    SELECT sort_at, timeline_at, published_at FROM publications WHERE article_id = ${id}`;
  assert.ok(pub!.published_at !== null && Math.abs(pub!.sort_at.getTime() - pub!.published_at!.getTime()) < 1000,
    "the projection's anchor moved to the real date");

  const cardAfter = await findCard();
  assert.ok(cardAfter, "the card is still on the timeline (nothing was unpublished)");
  assert.ok(cardAfter!.anchorAt !== cardBefore!.anchorAt, "it stands at a different time now");
  assert.ok(Math.abs(Date.parse(cardAfter!.anchorAt) - pub!.published_at!.getTime()) < 1000,
    "the public timeline places the card at its real publication date (AC2)");
});

test("a fill inside the window arms no regroup and leaves signals untouched (AC2)", async () => {
  const SOURCE = await freshSource();
  const id = await dateless(SOURCE, url("fresh/quiet"));
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, 'Quiet story', now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, created_at)
    VALUES (${"fact-" + randomUUID()}, ${story!.id}, 'Quiet fact', now()) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role, manual) VALUES (${fact!.id}, ${id}, 'report', false)`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${story!.id}, ${id}, ${"source:" + SOURCE}, ${SOURCE}, 'editorial', now())`;

  await enrichMissingMetadata(await sourceRow(SOURCE));
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regroup_pending WHERE article_id = ${id}`;
  assert.equal(pending!.n, 0, "no regroup for a window-inside fill");
  const [signals] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM story_signals WHERE article_id = ${id}`;
  assert.equal(signals!.n, 1, "its heat evidence stays as it was");
  const [pub] = await sql<{ published_at: Date | null }[]>`SELECT published_at FROM publications WHERE article_id = ${id}`;
  assert.ok(pub!.published_at !== null, "it still republished with the filled date");
});
