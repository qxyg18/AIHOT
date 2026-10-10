// ym95: by-id reads and entity pages follow the article page's gate (hasItemPage: publications
// visibility public + editorial source). Before the gate, a withdrawn or isolated article's
// insights and entity tags stayed reachable by id through /api/site/insights/article/:id and
// /api/site/articles/:id/entities even though its own page 404s.
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
const ED = `test-visgate-ed-${T}`;
const ISO = `test-visgate-iso-${T}`;
const BRAND = `visgate-brand-${T}`;
const BRAND_NAME = `门禁品牌${T}`;
const app = await buildApp();

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });

let pubId = "", wdId = "", isoId = "";

async function seed(sourceId: string, slug: string): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${slug}`, title: `门禁测试 ${slug} ${T}`,
    bodyText: `研报正文，关于${BRAND_NAME}的观点与数据。`.repeat(20), bodyHtml: `<p>body</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题 ${slug} ${T}`}, ${`摘要 ${T}`}, '理由', 90, false)`;
  await sql`INSERT INTO report_insights (article_id, entity_id, entity_name, kind, stance, statement, quote, org)
            VALUES (${articleId}, ${BRAND}, ${BRAND_NAME}, 'rating', 'positive', ${`${slug} 认为该品牌评级上调 ${T}`}, '引文', '机构')`;
  await sql`INSERT INTO article_entities (id, article_id, entity_type, entity_slug, entity_name, matched_via)
            VALUES (${"ve-" + articleId}, ${articleId}, 'brand', ${BRAND}, ${BRAND_NAME}, ${BRAND_NAME})`;
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${ED}, 'Vis gate editorial', 'rss', 'T1', 'editorial', true, true, '2100-01-01'),
                   (${ISO}, 'Vis gate isolated', 'rss', 'T1', 'isolated', true, true, '2100-01-01')`;
  await sql`INSERT INTO brand_profiles (id, slug, name, status) VALUES (${BRAND}, ${BRAND}, ${BRAND_NAME}, 'ready')`;
  pubId = await seed(ED, "pub");
  wdId = await seed(ED, "wd");
  isoId = await seed(ISO, "iso");
  await publishArticle(pubId, released());
  await publishArticle(wdId, released());
  await publishArticle(isoId, released());
  await setVisibility(wdId, { visibility: "withdrawn", reason: "ym95 gate test", version: 0 }, "test");
});

after(async () => {
  await sql`DELETE FROM report_insights WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM article_entities WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM editorial_overrides WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM publications WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM analyses WHERE article_id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM articles WHERE id IN (${pubId}, ${wdId}, ${isoId})`;
  await sql`DELETE FROM brand_profiles WHERE slug = ${BRAND}`;
  await sql`DELETE FROM sources WHERE id IN (${ED}, ${ISO})`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("insights by-id: public article answers, withdrawn/isolated answer empty", async () => {
  const pub = await app.inject({ method: "GET", url: `/api/site/insights/article/${pubId}` });
  assert.equal(pub.statusCode, 200);
  assert.equal((pub.json().insights as unknown[]).length, 1);
  for (const id of [wdId, isoId]) {
    const res = await app.inject({ method: "GET", url: `/api/site/insights/article/${id}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().insights, []);
  }
});

test("insights by-entity: only public-page articles quote their insights", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/insights/entity/${BRAND}` });
  assert.equal(res.statusCode, 200);
  const insights = res.json().insights as Array<{ statement: string }>;
  assert.equal(insights.length, 1);
  assert.match(insights[0]!.statement, /pub/);
});

test("entity tags by-id: withdrawn/isolated articles answer empty, public keeps tags", async () => {
  const pub = await app.inject({ method: "GET", url: `/api/site/articles/${pubId}/entities` });
  assert.equal(pub.statusCode, 200);
  assert.equal((pub.json().entities as unknown[]).length, 1);
  for (const id of [wdId, isoId]) {
    const res = await app.inject({ method: "GET", url: `/api/site/articles/${id}/entities` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().entities, []);
  }
});

test("entity page: related articles exclude withdrawn/isolated, keep public", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/entity/brand/${BRAND}` });
  assert.equal(res.statusCode, 200);
  const ids = (res.json().articles as Array<{ id: string }>).map((a) => a.id);
  assert.ok(ids.includes(pubId));
  assert.ok(!ids.includes(wdId));
  assert.ok(!ids.includes(isoId));
});
