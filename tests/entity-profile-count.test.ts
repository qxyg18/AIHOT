// ym242 (T11): the entity page headline count shares the article list's visibility gate
// (public publication × editorial source) and stays the full visible set, not the 20-row page.
// Reverse cases: withdrawn / summary-only / hot_signal / isolated / non-public backfill items
// are neither listed nor counted — on the annotated path and on the ILIKE fallback a fresh
// entity walks before annotation lands.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { entityProfile } from "@aihot/backend/entitytags/read";
import { entityTerms } from "@aihot/backend/entitytags/matcher";
import { tag } from "./setup.ts";

const T = tag();
const SRC_ED = `ym242-ed-${T}`;
const SRC_HOT = `ym242-hot-${T}`;
const SRC_ISO = `ym242-iso-${T}`;
const BRAND_A = `ym242-brand-a-${T}`;
const HIDDEN_IDS = { withdrawn: "", summaryOnly: "", hotSource: "", isolatedSource: "", backfillWithdrawn: "" };

let n = 0;
/** One article + its publication (+ optional entity annotation row). */
async function article(opts: {
  sourceId: string;
  visibility?: "public" | "summary-only" | "withdrawn";
  backfill?: boolean;
  title: string;
  annotate?: boolean;
  slug?: string;
  name?: string;
}): Promise<string> {
  n += 1;
  const id = `${T}a${n}`;
  const publishedAt = new Date(Date.now() - n * 60_000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${id}, ${opts.sourceId}, ${`ym242-${T}-${n}`}, ${`https://example.com/${T}/${n}`}, ${opts.title}, ${publishedAt}, ${publishedAt})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, visibility, backfill, sort_at)
            VALUES (${id}, ${opts.title}, ${opts.sourceId}, 'news', ${`https://example.com/${T}/${n}`}, ${publishedAt}, ${publishedAt},
                    ${opts.visibility ?? "public"}, ${opts.backfill ?? false}, ${publishedAt})`;
  if (opts.annotate) {
    await sql`INSERT INTO article_entities (id, article_id, entity_type, entity_slug, entity_name, matched_via)
              VALUES (${`${T}e${n}`}, ${id}, 'brand', ${opts.slug!}, ${opts.name!}, ${opts.name!})`;
  }
  return id;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC_ED}, 'ym242 editorial', 'rss', 'T1', 'editorial', '2100-01-01'),
                   (${SRC_HOT}, 'ym242 hot signal', 'rss', 'T1', 'hot_signal', '2100-01-01'),
                   (${SRC_ISO}, 'ym242 isolated', 'rss', 'T1', 'isolated', '2100-01-01')`;
  // Brand A exercises the annotated path: 25 visible + one hidden item per reverse case.
  await sql`INSERT INTO brand_profiles (id, slug, name, status) VALUES (${`ym242p-${T}`}, ${BRAND_A}, ${"测牌" + T}, 'ready')`;
  for (let i = 1; i <= 25; i++) {
    await article({ sourceId: SRC_ED, title: `${"测牌" + T} 动态 ${T} #${i}`, annotate: true, slug: BRAND_A, name: "测牌" + T });
  }
  HIDDEN_IDS.withdrawn = await article({ sourceId: SRC_ED, visibility: "withdrawn", title: `${"测牌" + T} 撤稿稿`, annotate: true, slug: BRAND_A, name: "测牌" + T });
  HIDDEN_IDS.summaryOnly = await article({ sourceId: SRC_ED, visibility: "summary-only", title: `${"测牌" + T} 仅摘要稿`, annotate: true, slug: BRAND_A, name: "测牌" + T });
  HIDDEN_IDS.hotSource = await article({ sourceId: SRC_HOT, title: `${"测牌" + T} 热信号源稿`, annotate: true, slug: BRAND_A, name: "测牌" + T });
  HIDDEN_IDS.isolatedSource = await article({ sourceId: SRC_ISO, title: `${"测牌" + T} 隔离源稿`, annotate: true, slug: BRAND_A, name: "测牌" + T });
  HIDDEN_IDS.backfillWithdrawn = await article({ sourceId: SRC_ED, visibility: "withdrawn", backfill: true, title: `${"测牌" + T} 回填撤稿`, annotate: true, slug: BRAND_A, name: "测牌" + T });
});

after(async () => {
  try {
    // Articles first: their FKs (publications, article_entities) cascade; sources must go last.
    await sql`DELETE FROM articles`;
    await sql`DELETE FROM brand_profiles WHERE slug IN (${BRAND_A}, ${FALLBACK_SLUG})`;
    await sql`DELETE FROM sources WHERE id IN (${SRC_ED}, ${SRC_HOT}, ${SRC_ISO})`;
  } finally {
    await closeDb();
  }
});

test("主路径：25 可见 + 5 反例 → list 20 / count 25，反例不计入不列出", async () => {
  const p = await entityProfile("brand", BRAND_A);
  assert.ok(p);
  assert.equal(p.articleCount, 25);
  assert.equal(p.articles.length, 20);
  const listed = new Set(p.articles.map((a) => a.id));
  for (const id of Object.values(HIDDEN_IDS)) assert.equal(listed.has(id), false, `hidden ${id} must stay off the page`);
  // 既有排序规则不变：published_at DESC，首位是最新可见篇（n=1）。
  assert.equal(p.articles[0]!.id, `${T}a1`);
});

// Fallback path (ym95 gate): a brand from the seed terms with no annotation rows yet. The count
// comes from the annotation table, so it stays 0 there — pre-existing semantics, untouched here.
const seedBrand = entityTerms()
  .filter((t) => t.type === "brand" && t.keyword.length >= 4)
  .sort((a, b) => a.slug.localeCompare(b.slug))[0]!;
const FALLBACK_SLUG = seedBrand.slug;

test("fallback 路径：25 可见 + 1 withdrawn → ILIKE 列表 20 且撤稿不列", async () => {
  await sql`INSERT INTO brand_profiles (id, slug, name, status) VALUES (${`ym242f-${T}`}, ${FALLBACK_SLUG}, ${seedBrand.name}, 'ready')
            ON CONFLICT (slug) DO NOTHING`;
  for (let i = 1; i <= 25; i++) {
    await article({ sourceId: SRC_ED, title: `${seedBrand.name} 观察手记 ${T} #${i}` });
  }
  const withdrawn = await article({ sourceId: SRC_ED, visibility: "withdrawn", title: `${seedBrand.name} 观察撤稿 ${T}` });

  const p = await entityProfile("brand", FALLBACK_SLUG);
  assert.ok(p);
  assert.equal(p.articles.length, 20);
  const listed = new Set(p.articles.map((a) => a.id));
  assert.equal(listed.has(withdrawn), false);
  assert.equal(p.articleCount, 0);
});
