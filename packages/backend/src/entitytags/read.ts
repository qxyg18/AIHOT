// Entity reads (zx18): the tag chain the article page and the entity page render —
// per-article entity lists, and per-entity (profile + leaderboard rank + related articles).
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { entityTerms, matchEntities, type ArticleText, type EntityType } from "./matcher.ts";
import { listApprovedSignals, type ApprovedSignal } from "./signals.ts";

/** The article-page visibility gate (ym95/ym242): public publication × editorial source. One
 * shared fragment so no query in this file can drift out of the gate — ym566: the entity count
 * query once did, and the entity page headline counted the reverse cases the list correctly hid. */
const PUBLIC_EDITORIAL = sql`AND p.visibility = 'public' AND s.participation_mode = 'editorial'`;

export interface ArticleEntityRow {
  type: EntityType;
  slug: string;
  name: string;
  matchedVia: string;
}

/** Live matching for one article, used as the fallback when the table has no rows yet. */
async function matchArticleRealtime(articleId: string): Promise<ArticleEntityRow[]> {
  const [a] = await sql<ArticleText[]>`
    SELECT id, title, excerpt, coalesce(body_text, '') AS body FROM articles WHERE id = ${articleId}`;
  if (!a) return [];
  return matchEntities(`${a.title} ${a.excerpt ?? ""} ${a.body ?? ""}`, entityTerms())
    .map((h) => ({ type: h.type, slug: h.slug, name: h.name, matchedVia: h.matchedVia }));
}

/** The visible tags of one article (marker rows excluded), brands first. Table first, live match
 *  as the fallback so a fresh article has its tags before the next annotation pass. By-id reads
 *  pass the same gate as the article page (hasItemPage): no public page, no public tags (ym95). */
export async function articleEntities(articleId: string): Promise<ArticleEntityRow[]> {
  const [gate] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id = ${articleId} ${PUBLIC_EDITORIAL}`;
  if (!gate || gate.n === 0) return [];
  const rows = await sql<ArticleEntityRow[]>`
    SELECT entity_type AS type, entity_slug AS slug, entity_name AS name, matched_via AS "matchedVia"
    FROM article_entities
    WHERE article_id = ${articleId} AND entity_slug <> '__none__'
    ORDER BY (CASE entity_type WHEN 'brand' THEN 0 WHEN 'channel' THEN 1 WHEN 'mall' THEN 2 ELSE 3 END), entity_slug`;
  return rows.length > 0 ? rows : matchArticleRealtime(articleId);
}

export interface EntityArticleRow { id: string; title: string; publishedAt: string | null }

export interface CoOccurrenceRow { slug: string; name: string; count: number }

export interface StoreStatRow { province: string; count: number }

/** Brand page store statistics (ym118), from the Amap expansion line's archive tables:
 *  listed* = Amap search hit count ("收录口径"; an upper bound — deep pagination returns
 *  fewer rows than the count claims), archivedTotal = per-store rows collected so far,
 *  mallMatched = rows resolved to a specific mall in the directory. */
export interface StoreStats {
  listedTotal: number;
  listedByProvince: StoreStatRow[];
  archivedTotal: number;
  mallMatched: number;
  updatedAt: string | null;
}

async function brandStoreStats(slug: string): Promise<StoreStats | null> {
  const [tot] = await sql<{ listed: number; archived: number; matched: number; updatedAt: string | null }[]>`
    SELECT coalesce(sum(listed_count), 0)::int AS listed,
           (SELECT count(*)::int FROM brand_stores s WHERE s.brand_slug = ${slug}) AS archived,
           (SELECT count(*)::int FROM brand_stores s WHERE s.brand_slug = ${slug} AND s.mall_slug IS NOT NULL) AS matched,
           (SELECT max(s.updated_at)::text FROM brand_stores s WHERE s.brand_slug = ${slug}) AS "updatedAt"
    FROM brand_store_counts WHERE brand_slug = ${slug}`;
  if (!tot || (tot.listed === 0 && tot.archived === 0)) return null;
  const byProvince = await sql<StoreStatRow[]>`
    SELECT province, sum(listed_count)::int AS count FROM brand_store_counts
    WHERE brand_slug = ${slug} AND province IS NOT NULL
    GROUP BY province HAVING sum(listed_count) > 0
    ORDER BY count DESC, province`;
  return { listedTotal: tot.listed, listedByProvince: byProvince, archivedTotal: tot.archived, mallMatched: tot.matched, updatedAt: tot.updatedAt };
}

export interface MallDynamic {
  articleId: string;
  title: string;
  publishedAt: string | null;
  kind: "open" | "close";
  word: string;
}

export interface EntityProfile {
  type: EntityType;
  slug: string;
  name: string;
  /** brand: the eight-question summary + facts; mall: seed facts; chain/channel: the note. */
  summary: string | null;
  facts: Array<{ label: string; value: string }>;
  chainNote: string | null;
  leaderboard: { board: "brand" | "mall"; rank: number; score: number } | null;
  articles: EntityArticleRow[];
  articleCount: number;
  /** mall page: kids brands co-mentioned in the same articles, per lookback window. */
  coBrands?: { w90: CoOccurrenceRow[]; w365: CoOccurrenceRow[] };
  /** brand page: malls co-mentioned in the same articles, per lookback window. */
  relatedMalls?: { w90: CoOccurrenceRow[]; w365: CoOccurrenceRow[] };
  /** brand page: Amap store archive statistics (ym118). */
  storeStats?: StoreStats | null;
  /** mall page: open/close event timeline from headline-level keyword signals. */
  dynamics?: MallDynamic[];
  /** ym132-③④：已审核文章信号（人工审核位通过；brand/mall 同型读面，空=无信号）。 */
  signals?: ApprovedSignal[];
}

interface MallSeed { slug: string; name: string; city?: string; area?: number | null; openedAt?: string | null; revenue?: number | null }
interface ExtrasSeed { mallChains: Array<{ slug: string; name: string; keywords: string[]; note?: string }>; channels: Array<{ slug: string; name: string; keywords: string[]; note?: string }> }

const EXTRAS_FILE = path.join(REPO_ROOT, "database/seeds/entity-extras-2026-10.json");
const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");

/** Open/close event vocabulary (a21 exploration, 2 rounds of precision tuning): words with a wide
 *  ambiguity surface (「新开」 matches inside 「焕新开放」, 「亮相」「离场」) stay out. */
const OPEN_WORDS = ["开业", "新店", "首店", "进驻", "入驻", "开幕", "启幕"];
const CLOSE_WORDS = ["闭店", "停业", "撤店", "撤铺", "歇业", "关店"];

/** Brand×mall co-occurrence counts per lookback window (90/365 days), from the article_entities
 *  self-join. Mall rows count only confident hits — matched_via equal to the full seed name or
 *  4+ characters: shared generic keywords (「万象城」 pins 15 cities) plus a city anywhere in a
 *  long roundup article would otherwise inflate cross-city pairs. */
async function coOccurrences(side: "mall" | "brand", slug: string): Promise<{ w90: CoOccurrenceRow[]; w365: CoOccurrenceRow[] }> {
  const other = side === "mall" ? "brand" : "mall";
  const conf1 = side === "mall" ? sql`AND (e1.matched_via = e1.entity_name OR char_length(e1.matched_via) >= 4)` : sql``;
  const conf2 = side === "brand" ? sql`AND (e2.matched_via = e2.entity_name OR char_length(e2.matched_via) >= 4)` : sql``;
  const rows = await sql<{ slug: string; name: string; count: number; recent: boolean }[]>`
    SELECT e2.entity_slug AS slug, max(e2.entity_name) AS name, count(*)::int AS count,
           (coalesce(a.published_at, a.discovered_at) >= now() - interval '90 days') AS recent
    FROM article_entities e1
    JOIN article_entities e2 ON e2.article_id = e1.article_id AND e2.entity_type = ${other}
    JOIN articles a ON a.id = e1.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e1.entity_type = ${side} AND e1.entity_slug = ${slug}
      ${PUBLIC_EDITORIAL}
      AND coalesce(a.published_at, a.discovered_at) >= now() - interval '365 days'
      ${conf1} ${conf2}
    GROUP BY e2.entity_slug, recent`;
  const bySlug = new Map<string, { slug: string; name: string; total: number; recent: number }>();
  for (const r of rows) {
    const cur = bySlug.get(r.slug) ?? { slug: r.slug, name: r.name, total: 0, recent: 0 };
    cur.total += r.count;
    if (r.recent) cur.recent += r.count;
    bySlug.set(r.slug, cur);
  }
  const list = [...bySlug.values()];
  const pick = (key: "total" | "recent") =>
    list
      .filter((x) => x[key] > 0)
      .sort((a, b) => b[key] - a[key] || a.slug.localeCompare(b.slug))
      .map(({ slug, name, ...rest }) => ({ slug, name, count: rest[key] }));
  return { w90: pick("recent"), w365: pick("total") };
}

/** Open/close timeline for one mall: an event needs the mall's full seed name AND an open/close
 *  keyword co-occurring in title+excerpt. Body-level keyword rules measured far below the 80%
 *  precision bar (city roundups mention the words with no event at this mall), so the timeline
 *  ships as the headline-level subset; re-check precision as the corpus grows. */
async function mallDynamics(slug: string, name: string): Promise<MallDynamic[]> {
  const rows = await sql<{ id: string; title: string; excerpt: string; publishedAt: string | null }[]>`
    SELECT DISTINCT a.id, a.title, coalesce(a.excerpt, '') AS excerpt,
           coalesce(a.published_at, a.discovered_at)::text AS "publishedAt"
    FROM article_entities e JOIN articles a ON a.id = e.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e.entity_type = 'mall' AND e.entity_slug = ${slug}
      ${PUBLIC_EDITORIAL}
      AND (e.matched_via = e.entity_name OR char_length(e.matched_via) >= 4)
      AND coalesce(a.published_at, a.discovered_at) >= now() - interval '365 days'
    ORDER BY "publishedAt" DESC NULLS LAST LIMIT 60`;
  const needle = name.toLowerCase();
  const out: MallDynamic[] = [];
  for (const r of rows) {
    const head = `${r.title} ${r.excerpt}`.toLowerCase();
    if (!head.includes(needle)) continue;
    const open = OPEN_WORDS.find((w) => head.includes(w));
    const close = CLOSE_WORDS.find((w) => head.includes(w));
    if (open) out.push({ articleId: r.id, title: r.title, publishedAt: r.publishedAt, kind: "open", word: open });
    if (close) out.push({ articleId: r.id, title: r.title, publishedAt: r.publishedAt, kind: "close", word: close });
  }
  return out.slice(0, 20);
}

/** Everything one entity page shows. Unknown slugs return null (a 404 for the route). */
export async function entityProfile(type: EntityType, slug: string): Promise<EntityProfile | null> {
  let name: string | null = null;
  let summary: string | null = null;
  let facts: Array<{ label: string; value: string }> = [];
  let chainNote: string | null = null;
  let board: "brand" | "mall" | null = null;
  let coBrands: EntityProfile["coBrands"];
  let relatedMalls: EntityProfile["relatedMalls"];
  let storeStats: EntityProfile["storeStats"];
  let dynamics: EntityProfile["dynamics"];
  let signals: EntityProfile["signals"];

  if (type === "brand") {
    const [p] = await sql<{ name: string; summary: string; origin: string | null; main_category: string | null; scale: string | null; price_range: string | null; founded_year: number | null; listed_at: string | null }[]>`
      SELECT name, summary, origin, main_category, scale, price_range, founded_year, listed_at FROM brand_profiles WHERE slug = ${slug} AND status = 'ready'`;
    if (!p) return null;
    name = p.name;
    summary = p.summary;
    if (p.origin) facts.push({ label: "品牌属地", value: p.origin });
    if (p.main_category) facts.push({ label: "主营品类", value: p.main_category });
    if (p.price_range) facts.push({ label: "价位", value: p.price_range });
    if (p.scale) facts.push({ label: "规模", value: p.scale });
    if (p.listed_at) facts.push({ label: "上市", value: p.listed_at });
    board = "brand";
    relatedMalls = await coOccurrences("brand", slug);
    storeStats = await brandStoreStats(slug);
    signals = await listApprovedSignals("brand", slug);
  } else if (type === "mall") {
    const malls = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls: MallSeed[] };
    const m = malls.malls.find((x) => x.slug === slug);
    if (!m) return null;
    name = m.name;
    if (m.city) facts.push({ label: "城市", value: m.city });
    if (m.area) facts.push({ label: "面积", value: `${m.area} 万㎡` });
    if (m.openedAt) facts.push({ label: "开业", value: m.openedAt });
    if (m.revenue) facts.push({ label: "年业绩", value: `约 ${m.revenue} 亿` });
    board = "mall";
    coBrands = await coOccurrences("mall", slug);
    dynamics = await mallDynamics(slug, m.name);
    signals = await listApprovedSignals("mall", slug);
  } else {
    const extras = JSON.parse(readFileSync(EXTRAS_FILE, "utf8")) as ExtrasSeed;
    const c = [...extras.mallChains, ...extras.channels].find((x) => x.slug === slug);
    if (!c) return null;
    name = c.name;
    chainNote = c.note ?? null;
  }

  // The article list shares the article-page gate (ym95): withdrawn/isolated items stay off the
  // entity page, including the ILIKE fallback a fresh entity walks before annotation lands.
  let articles = await sql<EntityArticleRow[]>`
    SELECT a.id, a.title, a.published_at AS "publishedAt"
    FROM article_entities e JOIN articles a ON a.id = e.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e.entity_type = ${type} AND e.entity_slug = ${slug}
      ${PUBLIC_EDITORIAL}
    ORDER BY coalesce(a.published_at, a.discovered_at) DESC LIMIT 20`;
  if (articles.length === 0) {
    // Same fallback: a live scan keeps a fresh entity's page non-empty before annotation lands.
    const terms = entityTerms().filter((t) => t.type === type && t.slug === slug);
    if (terms.length > 0) {
      articles = await sql<EntityArticleRow[]>`
        SELECT a.id, a.title, a.published_at AS "publishedAt" FROM articles a
        WHERE (coalesce(a.title, '') || ' ' || coalesce(a.excerpt, '') || ' ' || left(coalesce(a.body_text, ''), 600)) ILIKE ${"%" + terms[0]!.keyword + "%"}
          AND EXISTS (SELECT 1 FROM publications p JOIN sources s ON s.id = p.source_id
                      WHERE p.article_id = a.id ${PUBLIC_EDITORIAL})
        ORDER BY coalesce(a.published_at, a.discovered_at) DESC LIMIT 20`;
    }
  }
  // ym242: the headline count shares the article-page gate (public × editorial) and counts the
  // whole visible set, not the 20-row page — reverse cases (withdrawn / summary-only / hot
  // source / isolated source / non-public backfill) stay annotated but are neither listed nor
  // counted. The fallback path keeps count 0: its ILIKE hits are not annotation rows.
  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM article_entities e
    JOIN articles a ON a.id = e.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e.entity_type = ${type} AND e.entity_slug = ${slug}
      ${PUBLIC_EDITORIAL}`;

  let leaderboard: EntityProfile["leaderboard"] = null;
  if (board) {
    const [row] = await sql<{ rank: number; score: number }[]>`
      SELECT r.rank, r.score FROM lb_rankings r
      JOIN lb_runs run ON run.id = r.run_id AND run.status = 'published'
      JOIN lb_models m ON m.id = r.model_id AND m.slug = ${slug}
      WHERE r.board = ${board}
      ORDER BY run.generated_at DESC LIMIT 1`;
    if (row) leaderboard = { board, rank: Number(row.rank), score: Number(row.score) };
  }

  return { type, slug, name, summary, facts, chainNote, leaderboard, articles, articleCount: Number(count), coBrands, relatedMalls, storeStats, dynamics, signals };
}
