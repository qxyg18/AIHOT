// ym318: identity-helper boundary hardening (carries the three P3 items from ym254's audit).
// ISS-1: a non-URL raw config value keeps its own "raw:" namespace, so a web_list url="x:foo" no
// longer collides with the x_search author x:foo (the old fallback leaked into the x: space).
// ISS-2: the x_search author regex requires a word start, so the exclusion term "-from:foo" no
// longer names an author. ISS-3: updateSource writes its audit row inside the patch transaction,
// so a failure after the audit (the republish branch) leaves no orphan audit row behind.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createSource, findDuplicateSource, sourceIdentity, updateSource } from "@aihot/backend/admin/sources";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";

const T = tag();
const mk = (i: number, config: Record<string, unknown>, kind = "web_list") => ({
  id: `${T}-src-${i}`, name: `源${i}`, kind, config, tier: "T2" as const, participation_mode: "editorial" as const,
  interval_minutes: 30, first_party: false, tags: [], site_fulltext: false, syndicate_fulltext: false,
});

test("ISS-2: only a query-term from: names an author, an exclusion -from: does not", () => {
  assert.equal(sourceIdentity("x_search", { query: "from:foo" }), "x:foo");
  assert.equal(sourceIdentity("x_search", { query: "lang:zh from:foo bar" }), "x:foo");
  assert.equal(sourceIdentity("x_search", { query: "-from:foo" }), null, "the exclusion term is not an author");
  assert.equal(sourceIdentity("x_search", { query: "hello -from:foo" }), null);
  assert.equal(sourceIdentity("x_search", { query: "-from:foo OR from:bar" }), "x:bar", "only the real term matches");
  assert.equal(sourceIdentity("x_search", { query: "wordfrom:foo" }), null, "no mid-word match either");
});

test("ISS-1: raw-fallback identities stay out of the x: and https namespaces", async () => {
  const handle = sourceIdentity("x_search", { query: "from:foo" });
  assert.equal(handle, "x:foo");
  assert.notEqual(sourceIdentity("web_list", { url: "x:foo" }), handle, "a raw x:-looking url must not share the handle space");
  assert.equal(sourceIdentity("web_list", { url: "x:foo" }), "raw:x:foo");
  assert.equal(sourceIdentity("web_list", { listUrl: "not a url at all" }), "raw:not a url at all");
  // Normalised https identities are untouched: still the canonical URL, no prefix.
  assert.equal(sourceIdentity("rss", { feedUrl: `https://${T}.example.org/feed` }), `https://${T}.example.org/feed`);

  // End to end: the seeded raw-url source is a duplicate for the same raw url, not for the handle.
  const seeded = await createSource(mk(40, { url: "x:foo" }), "boundary-actor");
  assert.equal(seeded.created, true);
  const sameRaw = await findDuplicateSource("web_list", { url: "x:foo" });
  assert.equal(sameRaw?.id, `${T}-src-40`, "the same raw url still dedups");
  const viaHandle = await findDuplicateSource("x_search", { query: "from:foo" });
  assert.equal(viaHandle, null, "the handle must not collide with the raw-url source");
});

test("ISS-3: a failed republish branch rolls its audit row back with the patch", async () => {
  const seeded = await createSource(mk(41, { url: `https://${T}.example.org/tx` }), "tx-actor");
  assert.equal(seeded.created, true);
  const id = `${T}-src-41`;
  const [row] = await sql<{ updated_at: string; participation_mode: string }[]>`SELECT updated_at, participation_mode FROM sources WHERE id = ${id}`;
  const version = new Date(row!.updated_at).toISOString();

  // The audit insert succeeds, then the republish branch's settings insert fails: the whole
  // transaction (patch, audit row, queued job) must roll back together.
  await sql`CREATE FUNCTION boom_settings_ym318() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected settings failure'; END $$ LANGUAGE plpgsql`;
  await sql`CREATE TRIGGER boom_ym318 BEFORE INSERT ON settings FOR EACH ROW WHEN (new.updated_by = 'fail-tx-actor') EXECUTE FUNCTION boom_settings_ym318()`;
  try {
    await assert.rejects(
      updateSource(id, { patch: { participation_mode: "hot_signal" }, version, reason: "tx-boundary" }, "fail-tx-actor"),
      /injected settings failure/,
    );
  } finally {
    await sql`DROP TRIGGER boom_ym318 ON settings`;
    await sql`DROP FUNCTION boom_settings_ym318()`;
  }
  const audits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE actor = 'fail-tx-actor'`;
  assert.equal(audits[0]!.n, 0, "no orphan audit row survives the rollback");
  const [afterRow] = await sql<{ updated_at: string; participation_mode: string }[]>`SELECT updated_at, participation_mode FROM sources WHERE id = ${id}`;
  assert.equal(afterRow!.participation_mode, "editorial", "the patch is rolled back");
  assert.equal(new Date(afterRow!.updated_at).toISOString(), version, "updated_at is untouched");
});

test("a successful update still lands exactly one audit row", async () => {
  const id = `${T}-src-41`;
  const [row] = await sql<{ updated_at: string }[]>`SELECT updated_at FROM sources WHERE id = ${id}`;
  const r = await updateSource(id, { patch: { name: "改名后" }, version: new Date(row!.updated_at).toISOString(), reason: "happy path" }, "ok-actor");
  assert.equal((r as unknown as { name: string }).name, "改名后");
  const audits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE actor = 'ok-actor' AND action = 'source.update'`;
  assert.equal(audits[0]!.n, 1);
});

after(async () => {
  await sql`DELETE FROM audit_log WHERE subject LIKE ${`source:${T}-%`}`;
  await sql`DELETE FROM sources WHERE id LIKE ${`${T}-%`}`;
  await stopBoss();
  await closeDb();
});
