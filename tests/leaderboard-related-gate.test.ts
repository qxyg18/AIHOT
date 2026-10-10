// ym99: leaderboard model-detail relatedArticles/relatedArticleCount follow the same article-page
// gate as ym95 reads (publications visibility public + editorial source). Before the gate, an
// article that was published, entity-tagged, then withdrawn stayed listed (title + count) on
// /api/site/leaderboard/models/:slug for its whole 90-day window.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { setVisibility } from "@aihot/backend/admin/content";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const ED = `test-lbgate-ed-${T}`;
const ISO = `test-lbgate-iso-${T}`;
const BRAND = `lbgate-brand-${T}`;
const BRAND_NAME = `榜门品牌${T}`;
const RUN = `test-lbrun-${T}`;
const MODEL = `test-lbmodel-${T}`;
const app = await buildApp();

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });

let pubId = "", wdId = "", isoId = "";

async function seed(sourceId: string, slug: string): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${slug}`, title: `榜门测试 ${slug} ${T}`,
    bodyText: `正文，关于${BRAND_NAME}的报道。`.repeat(20), bodyHtml: `<p>body</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO article_entities (id, article_id, entity_type, entity_slug, entity_name, matched_via)
            VALUES (${"vl-" + articleId}, ${articleId}, 'brand', ${BRAND}, ${BRAND_NAME}, ${BRAND_NAME})`;
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${ED}, 'Lb gate editorial', 'rss', 'T1', 'editorial', true, true, '2100-01-01'),
                   (${ISO}, 'Lb gate isolated', 'rss', 'T1', 'isolated', true, true, '2100-01-01')`;
  pubId = await seed(ED, "pub");
  wdId = await seed(ED, "wd");
  isoId = await seed(ISO, "iso");
  await publishArticle(pubId, released());
  await publishArticle(wdId, released());
  await publishArticle(isoId, released());
  await setVisibility(wdId, { visibility: "withdrawn", reason: "ym99 gate test", version: 0 }, "test");
  // 最小在售 run：consensus.input 由 lb_runs.summary JSON 承载（无需 signals/scores 实表），
  // 品牌榜一行 rank=1 使 BRAND 进入 pageSlugs，路由可命中。
  await sql`INSERT INTO lb_models (id, slug, name, provider, context_window_tokens)
            VALUES (${MODEL}, ${BRAND}, ${BRAND_NAME}, 'test', 1000)`;
  await sql`INSERT INTO lb_runs (id, methodology_version, generated_at, source_snapshot_ids, summary, status)
            VALUES (${RUN}, 'test', now(), '{}', ${sql.json({
              consensus: { input: [{ board: "brand", registry: {}, signals: [] }] },
            })}, 'published')`;
  await sql`INSERT INTO lb_rankings (run_id, board, model_id, rank, score, coverage, confidence, metric_count)
            VALUES (${RUN}, 'brand', ${MODEL}, 1, 90, 1, 'high', 1)`;
});

after(async () => {
  await sql`DELETE FROM lb_rankings WHERE run_id = ${RUN}`;
  await sql`DELETE FROM lb_runs WHERE id = ${RUN}`;
  await sql`DELETE FROM lb_models WHERE id = ${MODEL}`;
  await sql`DELETE FROM article_entities WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM editorial_overrides WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  // ym99 审计 P3-1：setVisibility 经 admin/auth.ts 落 audit_log（ym83 测试残留教训，按 subject 精确清）
  await sql`DELETE FROM audit_log WHERE subject IN (${"content:" + pubId}, ${"content:" + wdId}, ${"content:" + isoId})`;
  await sql`DELETE FROM publications WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM analyses WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM articles WHERE id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM sources WHERE id IN (${ED}, ${ISO})`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("leaderboard model detail: relatedArticles exclude withdrawn/isolated, keep public", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/leaderboard/models/${BRAND}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const ids = (body.relatedArticles as Array<{ id: string }>).map((a) => a.id);
  assert.ok(ids.includes(pubId), "public article must stay listed");
  assert.ok(!ids.includes(wdId), "withdrawn article must be gated off the leaderboard page");
  assert.ok(!ids.includes(isoId), "isolated-source article must be gated off the leaderboard page");
});

test("leaderboard model detail: relatedArticleCount counts only gated-in articles", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/leaderboard/models/${BRAND}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const listed = (body.relatedArticles as unknown[]).length;
  assert.equal(body.relatedArticleCount, 1);
  assert.equal(listed, body.relatedArticleCount, "count must match the gated list");
});
