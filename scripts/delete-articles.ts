// Standard entry for deleting articles (ym146): manual and automated deletions of articles
// must go through this script — the ad-hoc SQL DELETE of 10-02 (170 articles, archives wiped
// afterwards) is what made that round untraceable (ym141). This bakes in the ym141 §八.2
// recipe: pre-delete manifest -> in-transaction guards -> delete (the 0045 triggers archive
// every removed row) -> archive reconciliation -> one audit_log `article.delete` row, all in
// the same transaction, so a rollback takes the audit row back with it.
//   node --env-file=.env scripts/delete-articles.ts "<reason>" (<article-id>|key:<identity-key>)...
// Targets must be explicit ids or `key:`-prefixed identity keys — no ad-hoc WHERE filters.
// Refuses: unknown targets, articles still selected (withdraw via the admin surface first),
// disabled archive/guard triggers, or archive counts that do not reconcile after the delete.
import { closeDb, sql } from "@aihot/backend/db";

const ACTOR = "ops-script";
const [reason, ...targets] = process.argv.slice(2);
if (!reason || targets.length === 0)
  throw new Error('usage: delete-articles.ts "<reason>" (<article-id>|key:<identity-key>)...');

const ids = targets.filter((t) => !t.startsWith("key:"));
const keys = targets.filter((t) => t.startsWith("key:")).map((t) => t.slice(4));

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
for (const t of targets) {
  const hit = t.startsWith("key:")
    ? byKey.find((r) => r.identity_key === t.slice(4))
    : byId.find((r) => r.id === t);
  if (hit) resolve.set(t, hit.id);
}
const missing = targets.filter((t) => !resolve.has(t));
if (missing.length > 0) throw new Error(`no such article(s): ${missing.join(", ")} — refusing a partial delete`);
const idList = [...new Set(resolve.values())];
if (idList.length < targets.length) console.log(`note: ${targets.length} target(s) resolve to ${idList.length} article(s)`);
const byRowId = new Map(byId.concat(byKey).map((r) => [r.id, r]));
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
console.log("pre-delete manifest:", JSON.stringify(manifest, null, 2));

await sql.begin(async (tx) => {
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

  const n = (t: { n: number }[]) => t[0].n;
  const pre = {
    articlesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM articles_archived WHERE id IN ${sql(idList)}`),
    publicationsCascade: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id IN ${sql(idList)}`),
    publicationsArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM publications_archived WHERE article_id IN ${sql(idList)}`),
    analysesCascade: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id IN ${sql(idList)}`),
    analysesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses_archived WHERE article_id IN ${sql(idList)}`),
  };

  await tx`DELETE FROM articles WHERE id IN ${sql(idList)}`;

  const post = {
    articlesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM articles_archived WHERE id IN ${sql(idList)}`),
    publicationsArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM publications_archived WHERE article_id IN ${sql(idList)}`),
    analysesArchived: n(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses_archived WHERE article_id IN ${sql(idList)}`),
  };
  if (post.articlesArchived !== pre.articlesArchived + idList.length)
    throw new Error(`archive mismatch: articles_archived ${pre.articlesArchived} -> ${post.articlesArchived}, expected +${idList.length} — rolling back`);
  if (post.publicationsArchived !== pre.publicationsArchived + pre.publicationsCascade)
    throw new Error(`archive mismatch: publications_archived ${pre.publicationsArchived} -> ${post.publicationsArchived}, expected +${pre.publicationsCascade} — rolling back`);
  if (post.analysesArchived !== pre.analysesArchived + pre.analysesCascade)
    throw new Error(`archive mismatch: analyses_archived ${pre.analysesArchived} -> ${post.analysesArchived}, expected +${pre.analysesCascade} — rolling back`);

  const subject = idList.length === 1 ? `article:${idList[0]}` : `article:${idList[0]} (+${idList.length - 1} more)`;
  await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
           VALUES (${ACTOR}, ${"article.delete"}, ${subject}, ${reason},
                   ${sql.json(manifest as never)},
                   ${sql.json({ archived: post, publicationsCascade: pre.publicationsCascade, analysesCascade: pre.analysesCascade } as never)})`;
  console.log(`archived: articles +${post.articlesArchived - pre.articlesArchived}, publications +${post.publicationsArchived - pre.publicationsArchived}, analyses +${post.analysesArchived - pre.analysesArchived}`);
});

console.log(`deleted ${idList.length} article(s); archives reconciled; audit_log article.delete written`);
await closeDb();
