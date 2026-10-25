// Standard entry for deleting articles and facts (ym146; ym357 adds facts and full child-table
// accounting): manual and automated deletions must go through this script — the ad-hoc SQL
// DELETE of 10-02 (170 articles, archives wiped afterwards) is what made that round untraceable
// (ym141). This bakes in the ym141 §八.2 recipe: pre-delete manifest -> in-transaction guards ->
// delete (the 0045/ym80 triggers archive every removed articles/publications/analyses row) ->
// archive reconciliation -> one audit_log row per target kind, all in the same transaction, so
// a rollback takes the audit rows back with it.
// ym357: every articles foreign-key child table is ON DELETE CASCADE but only three of them
// archive, so the audit row carries each child table's cascade count (a table outside the list
// below refuses the run until it is added). `fact:<id>` targets delete facts the same way
// (fact_articles cascades); facts left with no supporting article by the delete are reported,
// never silently removed — delete them explicitly with fact: targets if that is wanted.
//   node --env-file=.env scripts/delete-articles.ts "<reason>" (<article-id>|key:<identity-key>|fact:<fact-id>)...
// Targets must be explicit ids or `key:`/`fact:`-prefixed keys — no ad-hoc WHERE filters.
// Refuses: unknown targets, articles still selected (withdraw via the admin surface first),
// disabled archive/guard triggers, or archive counts that do not reconcile after the delete.
import { closeDb, sql, type Tx } from "@aihot/backend/db";

const ACTOR = "ops-script";
const [reason, ...targets] = process.argv.slice(2);
if (!reason || targets.length === 0)
  throw new Error('usage: delete-articles.ts "<reason>" (<article-id>|key:<identity-key>|fact:<fact-id>)...');

const ids = targets.filter((t) => !t.startsWith("key:") && !t.startsWith("fact:"));
const keys = targets.filter((t) => t.startsWith("key:")).map((t) => t.slice(4));
const factIds = targets.filter((t) => t.startsWith("fact:")).map((t) => t.slice(5));
if (factIds.some((f) => !/^\d+$/.test(f))) throw new Error(`fact: targets are numeric ids: ${factIds.filter((f) => !/^\d+$/.test(f)).join(", ")}`);

// Every table with an ON DELETE CASCADE foreign key into articles. The 0045/ym80 archive
// triggers cover articles, publications and analyses; all others vanish without a trace unless
// this list accounts for them. A CASCADE child table missing here refuses the run (below).
const CHILD_TABLES = [
  "article_revisions", "article_discoveries", "translations", "analyses", "editorial_overrides",
  "publications", "fact_articles", "story_signals", "grouping_decisions", "translation_attempts",
  "pool_search", "grouping_overrides", "regroup_pending", "report_insights", "article_deep_reads",
  "article_entities", "entity_signal_drafts",
];

type Row = {
  id: string;
  identity_key: string;
  source_id: string;
  url: string | null;
  title: string | null;
  revision: number;
  processing_state: string;
  published_at: Date | null;
  created_at: Date;
  content_hash: string;
};
const byId = ids.length
  ? await sql<Row[]>`SELECT id, identity_key, source_id, url, title, revision, processing_state, published_at, created_at, content_hash FROM articles WHERE id IN ${sql(ids)}`
  : [];
const byKey = keys.length
  ? await sql<Row[]>`SELECT id, identity_key, source_id, url, title, revision, processing_state, published_at, created_at, content_hash FROM articles WHERE identity_key IN ${sql(keys)}`
  : [];

const resolve = new Map<string, string>();
for (const t of targets.filter((t) => !t.startsWith("fact:"))) {
  const hit = t.startsWith("key:")
    ? byKey.find((r) => r.identity_key === t.slice(4))
    : byId.find((r) => r.id === t);
  if (hit) resolve.set(t, hit.id);
}
const missing = targets.filter((t) => !t.startsWith("fact:") && !resolve.has(t));
if (missing.length > 0) throw new Error(`no such article(s): ${missing.join(", ")} — refusing a partial delete`);
const idList = [...new Set(resolve.values())];
if (idList.length < targets.filter((t) => !t.startsWith("fact:")).length) console.log(`note: some article target(s) resolve to fewer articles`);

type FactRow = {
  id: string;
  public_id: string | null;
  story_id: number | null;
  title: string | null;
  subject: string | null;
  action: string | null;
  object: string | null;
  conditions: string | null;
  occurred_at: Date | null;
  version: number;
  manual: boolean;
};
const factRows = factIds.length
  ? await sql<FactRow[]>`SELECT id::text AS id, public_id, story_id, title, subject, action, object, conditions, occurred_at, version, manual
                         FROM facts WHERE id IN ${sql(factIds.map(Number))}`
  : [];
const missingFacts = factIds.filter((f) => !factRows.some((r) => r.id === f));
if (missingFacts.length > 0) throw new Error(`no such fact(s): ${missingFacts.join(", ")} — refusing a partial delete`);

const byRowId = new Map([...byId, ...byKey].map((r) => [r.id, r]));
const rows = idList.map((id) => byRowId.get(id)!);

const manifest = rows.map((r) => ({
  id: r.id,
  identity_key: r.identity_key,
  source_id: r.source_id,
  url: r.url,
  title: r.title,
  revision: r.revision,
  processing_state: r.processing_state,
  published_at: r.published_at,
  created_at: r.created_at,
  content_hash: r.content_hash,
}));
if (manifest.length) console.log("pre-delete manifest:", JSON.stringify(manifest, null, 2));
const factManifest = factRows.map((r) => ({ ...r }));
if (factManifest.length) console.log("pre-delete fact manifest:", JSON.stringify(factManifest, null, 2));

// A CASCADE child table the script does not know about would delete unaccounted — stop.
const drifted = (await sql<{ relid: string }[]>`
  SELECT DISTINCT conrelid::regclass::text AS relid FROM pg_constraint
  WHERE confrelid = 'articles'::regclass AND contype = 'f' AND confdeltype = 'c'`)
  .map((r) => r.relid)
  .filter((t) => !CHILD_TABLES.includes(t));
if (drifted.length > 0)
  throw new Error(`articles has CASCADE child table(s) missing from CHILD_TABLES: ${drifted.join(", ")} — add them before deleting`);

const n = (t: { n: number }[]) => t[0].n;
const countChild = (tx: Tx, table: string, column: string, values: (string | number)[]) =>
  tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1)`, [values]);

await sql.begin(async (tx) => {
  if (idList.length) {
    const locked = await tx<{ id: string }[]>`SELECT id FROM articles WHERE id IN ${sql(idList)} FOR UPDATE`;
    if (locked.length !== idList.length) throw new Error(`concurrent change: ${idList.length} target(s) but ${locked.length} locked — retry`);

    const selected = await tx<{ article_id: string }[]>`
      SELECT DISTINCT p.article_id FROM publications p
      WHERE p.article_id IN ${sql(idList)} AND p.selected_ready_at IS NOT NULL AND p.visibility <> 'withdrawn'`;
    if (selected.length > 0)
      throw new Error(`refusing: ${selected.length} article(s) still selected — withdraw via the admin surface first: ${selected.map((s) => s.article_id).join(", ")}`);

    const required = [
      "articles_archive_del", "publications_archive_del", "analyses_archive_del",
      "articles_archived_append_only", "publications_archived_append_only", "analyses_archived_append_only",
    ];
    const triggers = await tx<{ tgname: string; tgenabled: string }[]>`
      SELECT t.tgname, t.tgenabled FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname IN ${sql(required)}`;
    for (const name of required) {
      const t = triggers.find((x) => x.tgname === name);
      if (!t || t.tgenabled !== "O")
        throw new Error(`archive trigger ${name} missing or disabled (${t?.tgenabled ?? "none"}) — archival path not guaranteed, refusing`);
    }

    const pre = {
      articlesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM articles_archived WHERE id IN ${sql(idList)}`),
      publicationsArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM publications_archived WHERE article_id IN ${sql(idList)}`),
      analysesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses_archived WHERE article_id IN ${sql(idList)}`),
    };
    const cascades: Record<string, number> = {};
    for (const t of CHILD_TABLES) cascades[t] = n(await countChild(tx, t, "article_id", idList));
    const orphansBefore = n(await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM facts f WHERE NOT EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id = f.id)`);

    await tx`DELETE FROM articles WHERE id IN ${sql(idList)}`;

    const post = {
      articlesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM articles_archived WHERE id IN ${sql(idList)}`),
      publicationsArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM publications_archived WHERE article_id IN ${sql(idList)}`),
      analysesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses_archived WHERE article_id IN ${sql(idList)}`),
    };
    if (post.articlesArchived !== pre.articlesArchived + idList.length)
      throw new Error(`archive mismatch: articles_archived ${pre.articlesArchived} -> ${post.articlesArchived}, expected +${idList.length} — rolling back`);
    if (post.publicationsArchived !== pre.publicationsArchived + cascades["publications"])
      throw new Error(`archive mismatch: publications_archived ${pre.publicationsArchived} -> ${post.publicationsArchived}, expected +${cascades["publications"]} — rolling back`);
    if (post.analysesArchived !== pre.analysesArchived + cascades["analyses"])
      throw new Error(`archive mismatch: analyses_archived ${pre.analysesArchived} -> ${post.analysesArchived}, expected +${cascades["analyses"]} — rolling back`);
    for (const t of CHILD_TABLES) {
      const left = n(await countChild(tx, t, "article_id", idList));
      if (left !== 0) throw new Error(`cascade residue: ${t} still has ${left} row(s) for deleted article(s) — rolling back`);
    }
    const orphansAfter = n(await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM facts f WHERE NOT EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id = f.id)`);

    const subject = idList.length === 1 ? `article:${idList[0]}` : `article:${idList[0]} (+${idList.length - 1} more)`;
    await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
             VALUES (${ACTOR}, ${"article.delete"}, ${subject}, ${reason},
                     ${sql.json(manifest as never)},
                     ${sql.json({
                       archived: post,
                       cascades,
                       factsOrphanedByDelete: orphansAfter - orphansBefore,
                     } as never)})`;
    const cascaded = Object.entries(cascades).filter(([, c]) => c > 0).map(([t, c]) => `${t}:${c}`).join(", ") || "none";
    console.log(`archived: articles +${post.articlesArchived - pre.articlesArchived}, publications +${post.publicationsArchived - pre.publicationsArchived}, analyses +${post.analysesArchived - pre.analysesArchived}; cascaded: ${cascaded}`);
    if (orphansAfter - orphansBefore > 0)
      console.log(`note: ${orphansAfter - orphansBefore} fact(s) lost their last supporting article — reported, not deleted (explicit fact:<id> targets if wanted)`);
  }

  if (factIds.length) {
    const numeric = factIds.map(Number);
    const locked = await tx<{ id: string }[]>`SELECT id FROM facts WHERE id IN ${sql(numeric)} FOR UPDATE`;
    if (locked.length !== numeric.length) throw new Error(`concurrent change: ${numeric.length} fact target(s) but ${locked.length} locked — retry`);
    const factArticles = n(await countChild(tx, "fact_articles", "fact_id", numeric));
    await tx`DELETE FROM facts WHERE id IN ${sql(numeric)}`;
    const left = n(await countChild(tx, "fact_articles", "fact_id", numeric));
    if (left !== 0) throw new Error(`cascade residue: fact_articles still has ${left} row(s) for deleted fact(s) — rolling back`);

    const subject = numeric.length === 1 ? `fact:${numeric[0]}` : `fact:${numeric[0]} (+${numeric.length - 1} more)`;
    await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
             VALUES (${ACTOR}, ${"fact.delete"}, ${subject}, ${reason},
                     ${sql.json(factManifest as never)},
                     ${sql.json({ factArticlesCascade: factArticles } as never)})`;
    console.log(`facts deleted: ${numeric.length}, fact_articles cascaded: ${factArticles}`);
  }
});

console.log(`deleted ${idList.length} article(s) and ${factIds.length} fact(s); archives reconciled; audit_log written`);
await closeDb();
