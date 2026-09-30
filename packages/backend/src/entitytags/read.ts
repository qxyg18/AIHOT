// Entity reads (zx18): the tag chain the article page and the entity page render —
// per-article entity lists, and per-entity (profile + leaderboard rank + related articles).
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { entityTerms, matchEntities, type ArticleText, type EntityType } from "./matcher.ts";

export interface ArticleEntityRow {
  type: EntityType;
  slug: string;
  name: string;
  matchedVia: string;
}

/** Live matching for one article, used as the fallback when the table has no rows yet. */
async function matchArticleRealtime(articleId: string): Promise<ArticleEntityRow[]> {
  const [a] = await sql<ArticleText[]>`
    SELECT id, title, excerpt, left(coalesce(body_text, ''), 600) AS body FROM articles WHERE id = ${articleId}`;
  if (!a) return [];
  return matchEntities(`${a.title} ${a.excerpt ?? ""} ${(a.body ?? "").slice(0, 600)}`, entityTerms())
    .map((h) => ({ type: h.type, slug: h.slug, name: h.name, matchedVia: h.matchedVia }));
}

/** The visible tags of one article (marker rows excluded), brands first. Table first, live match
 *  as the fallback so a fresh article has its tags before the next annotation pass. */
export async function articleEntities(articleId: string): Promise<ArticleEntityRow[]> {
  const rows = await sql<ArticleEntityRow[]>`
    SELECT entity_type AS type, entity_slug AS slug, entity_name AS name, matched_via AS "matchedVia"
    FROM article_entities
    WHERE article_id = ${articleId} AND entity_slug <> '__none__'
    ORDER BY (CASE entity_type WHEN 'brand' THEN 0 WHEN 'channel' THEN 1 WHEN 'mall' THEN 2 ELSE 3 END), entity_slug`;
  return rows.length > 0 ? rows : matchArticleRealtime(articleId);
}

export interface EntityArticleRow { id: string; title: string; publishedAt: string | null }

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
}

interface MallSeed { slug: string; name: string; city?: string; area?: number | null; openedAt?: string | null; revenue?: number | null }
interface ExtrasSeed { mallChains: Array<{ slug: string; name: string; keywords: string[]; note?: string }>; channels: Array<{ slug: string; name: string; keywords: string[]; note?: string }> }

const EXTRAS_FILE = path.join(REPO_ROOT, "database/seeds/entity-extras-2026-10.json");
const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");

/** Everything one entity page shows. Unknown slugs return null (a 404 for the route). */
export async function entityProfile(type: EntityType, slug: string): Promise<EntityProfile | null> {
  let name: string | null = null;
  let summary: string | null = null;
  let facts: Array<{ label: string; value: string }> = [];
  let chainNote: string | null = null;
  let board: "brand" | "mall" | null = null;

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
  } else {
    const extras = JSON.parse(readFileSync(EXTRAS_FILE, "utf8")) as ExtrasSeed;
    const c = [...extras.mallChains, ...extras.channels].find((x) => x.slug === slug);
    if (!c) return null;
    name = c.name;
    chainNote = c.note ?? null;
  }

  let articles = await sql<EntityArticleRow[]>`
    SELECT a.id, a.title, a.published_at AS "publishedAt"
    FROM article_entities e JOIN articles a ON a.id = e.article_id
    WHERE e.entity_type = ${type} AND e.entity_slug = ${slug}
    ORDER BY coalesce(a.published_at, a.discovered_at) DESC LIMIT 20`;
  if (articles.length === 0) {
    // Same fallback: a live scan keeps a fresh entity's page non-empty before annotation lands.
    const terms = entityTerms().filter((t) => t.type === type && t.slug === slug);
    if (terms.length > 0) {
      articles = await sql<EntityArticleRow[]>`
        SELECT id, title, published_at AS "publishedAt" FROM articles
        WHERE (coalesce(title, '') || ' ' || coalesce(excerpt, '') || ' ' || left(coalesce(body_text, ''), 600)) ILIKE ${"%" + terms[0]!.keyword + "%"}
        ORDER BY coalesce(published_at, discovered_at) DESC LIMIT 20`;
    }
  }
  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM article_entities WHERE entity_type = ${type} AND entity_slug = ${slug}`;

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

  return { type, slug, name, summary, facts, chainNote, leaderboard, articles, articleCount: Number(count) };
}
