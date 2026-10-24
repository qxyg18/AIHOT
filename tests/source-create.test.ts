// T04 (ym254): one address is one source. Concurrent creates of the same canonical endpoint
// serialise on a transaction advisory lock, every loser reads the created source back, and the
// source and its audit row commit or roll back together. AC1: 20 concurrent creates of one address
// leave exactly one source with a consistent id, and a replay reads it back. AC2: identity crosses
// kinds (an rss feed and a web_list page on the same endpoint are duplicates) and normalises
// tracking params, case and the trailing slash, while a real query parameter keeps two addresses
// apart; a deliberately different filter config on the same address is a duplicate, not a second
// source. AC3: existing sources are neither edited nor merged, a failed transaction leaves neither
// a half source nor an audit row, and no two sources in the table share an identity.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createSource, sourceIdentity } from "@aihot/backend/admin/sources";
import { tag } from "./setup.ts";

const T = tag();
const address = (p: string) => `https://${T}.example.org/${p}`;
const mk = (i: number, config: Record<string, unknown>, kind = "web_list") => ({
  id: `${T}-src-${i}`, name: `源${i}`, kind, config, tier: "T2" as const, participation_mode: "editorial" as const,
  interval_minutes: 30, first_party: false, tags: [], site_fulltext: false, syndicate_fulltext: false,
});

// Six pre-existing sources, two kinds, all distinct addresses: the invariants below must never
// touch them (AC3), and the whole-table identity scan must find no collision among them.
const SEEDS = [
  mk(90, { url: address("seed/a") }),
  mk(91, { url: address("seed/b") }),
  mk(92, { feedUrl: address("seed/c") }, "rss"),
  mk(93, { feedUrl: address("seed/d") }, "rss"),
  mk(94, { url: address("seed/e?cat=a") }),
  mk(95, { url: address("seed/f") }, "json_list"),
];
let seedStamp = "";
let baselineOthers = 0;

test("seeds exist before the invariants run", async () => {
  const [base] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE id NOT LIKE ${`${T}-%`}`;
  baselineOthers = base!.n;
  for (const s of SEEDS) {
    const r = await createSource(s, "seed-actor");
    assert.equal(r.created, true, JSON.stringify(r));
  }
  const rows = await sql<{ updated_at: string }[]>`SELECT updated_at FROM sources WHERE id LIKE ${`${T}-src-9%`}`;
  assert.equal(rows.length, SEEDS.length);
  seedStamp = JSON.stringify(rows.map((r) => r.updated_at));
});

test("20 concurrent creates of one address make exactly one source (AC1)", async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => createSource(mk(i, { url: address("feed") }), "race-actor")));
  type CreateResult = Awaited<ReturnType<typeof createSource>>;
  const created = results.filter((r): r is PromiseFulfilledResult<CreateResult> => r.status === "fulfilled" && r.value.created);
  const dups = results.filter((r): r is PromiseFulfilledResult<CreateResult> => r.status === "fulfilled" && !r.value.created);
  assert.equal(results.every((r) => r.status === "fulfilled"), true, "no create may throw under the lock");
  assert.equal(created.length, 1, `exactly one creator wins, got ${created.length}`);
  assert.equal(dups.length, 19);
  const winner = (created[0]!.value as { source: { id: string } }).source.id;
  for (const d of dups) {
    const dup = (d.value as { duplicate: { id: string } }).duplicate;
    assert.equal(dup.id, winner, "every loser reads the same source back");
  }
  const rows = await sql<{ id: string }[]>`SELECT id FROM sources WHERE config->>'url' = ${address("feed")}`;
  assert.equal(rows.length, 1);
  const audits = await sql<{ actor: string }[]>`SELECT actor FROM audit_log WHERE subject = ${`source:${winner}`} AND action = 'source.create'`;
  assert.equal(audits.length, 1, "one source row with its one audit row");
  // A replay of the same input still reads the created source back, without another audit row.
  const replay = await createSource(mk(0, { url: address("feed") }), "race-actor");
  assert.equal(replay.created, false);
  assert.equal((replay as { duplicate: { id: string } }).duplicate.id, winner);
  const auditsAfter = await sql<{ actor: string }[]>`SELECT actor FROM audit_log WHERE subject = ${`source:${winner}`} AND action = 'source.create'`;
  assert.equal(auditsAfter.length, 1);
});

test("identity crosses kinds, drops tracking noise, and keeps real params apart (AC2)", async () => {
  // Case and a tracking param and the trailing slash: same address as a web_list page.
  const upperHost = `https://${T.toUpperCase()}.EXAMPLE.ORG/feed2?utm_source=x&mkt_tok=y`;
  const rss = await createSource(mk(20, { feedUrl: upperHost }, "rss"), "kind-actor");
  assert.equal(rss.created, true);
  const web = await createSource(mk(21, { url: `${address("feed2")}/` }), "kind-actor");
  assert.equal(web.created, false, "one address is one source across rss and web_list");
  assert.equal((web as unknown as { duplicate: { id: string } }).duplicate.id, (rss as unknown as { source: { id: string } }).source.id);

  // A parameter the site means (a channel) keeps two addresses apart: no blind merge.
  const listA = await createSource(mk(22, { url: address("list?cat=a") }, "json_list"), "kind-actor");
  assert.equal(listA.created, true);
  const listB = await createSource(mk(23, { url: address("list?cat=b") }, "json_list"), "kind-actor");
  assert.equal(listB.created, true, "a real query parameter is a different source");

  // Same address with a deliberately different filter config: still that source, not a second one.
  const filtered = await createSource({ ...mk(24, { url: address("feed3"), ingestIncludeFilter: { any: ["开店"] } }) }, "kind-actor");
  assert.equal(filtered.created, true);
  const other = await createSource(mk(25, { url: address("feed3") }), "kind-actor");
  assert.equal(other.created, false, "the filter config does not fork the address into two sources");
  assert.equal((other as unknown as { duplicate: { id: string } }).duplicate.id, (filtered as unknown as { source: { id: string } }).source.id);
});

test("a failed transaction leaves neither a half source nor an audit row (AC3)", async () => {
  // The audit insert fails after the source insert: both must roll back together.
  await sql`CREATE FUNCTION boom_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$ LANGUAGE plpgsql`;
  await sql`CREATE TRIGGER boom BEFORE INSERT ON audit_log FOR EACH ROW WHEN (new.actor = 'fail-actor') EXECUTE FUNCTION boom_audit()`;
  try {
    await assert.rejects(createSource(mk(30, { url: address("boom") }), "fail-actor"), /injected audit failure/);
  } finally {
    await sql`DROP TRIGGER boom ON audit_log`;
    await sql`DROP FUNCTION boom_audit()`;
  }
  const sources = await sql<{ id: string }[]>`SELECT id FROM sources WHERE config->>'url' = ${address("boom")}`;
  assert.equal(sources.length, 0, "no half source survives its audit row");
  const audits = await sql<{ subject: string }[]>`SELECT subject FROM audit_log WHERE actor = 'fail-actor'`;
  assert.equal(audits.length, 0);

  // An id conflict on a different address refuses the create; the existing source keeps its single audit row.
  const first = await createSource(mk(31, { url: address("clash") }), "clash-actor");
  assert.equal(first.created, true);
  await assert.rejects(createSource(mk(31, { url: address("clash2") }), "clash-actor"), /信源 ID/);
  const rows = await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ${`${T}-src-31`}`;
  assert.equal(rows.length, 1, "the second create never wrote its source");
  const audits31 = await sql<{ subject: string }[]>`SELECT subject FROM audit_log WHERE subject = ${`source:${T}-src-31`} AND action = 'source.create'`;
  assert.equal(audits31.length, 1);
});

test("existing sources are untouched and identities stay unique (AC3)", async () => {
  const rows = await sql<{ updated_at: string }[]>`SELECT updated_at FROM sources WHERE id LIKE ${`${T}-src-9%`} ORDER BY id`;
  assert.equal(rows.length, SEEDS.length, "no seed was merged away");
  assert.equal(JSON.stringify(rows.map((r) => r.updated_at)), seedStamp, "no seed was edited");
  // Rows outside this test's tag are other files' fixtures; their count must not move either.
  const others = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE id NOT LIKE ${`${T}-%`}`;
  assert.equal(others[0]!.n, baselineOthers, "no source outside this test was touched");

  // Everything this test created, kinds crossed: no two of its sources share an identity.
  const mine = await sql<{ id: string; kind: string; config: Record<string, unknown> }[]>`SELECT id, kind, config FROM sources WHERE id LIKE ${`${T}-%`}`;
  const seen = new Map<string, string>();
  for (const r of mine) {
    const identity = sourceIdentity(r.kind, r.config);
    if (identity === null) continue;
    const clash = seen.get(identity);
    assert.equal(clash, undefined, `sources ${r.id} and ${clash} share identity ${identity}`);
    seen.set(identity, r.id);
  }
});

after(async () => {
  await sql`DELETE FROM audit_log WHERE subject LIKE ${`source:${T}-%`}`;
  await sql`DELETE FROM sources WHERE id LIKE ${`${T}-%`}`;
  await closeDb();
});
