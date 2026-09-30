// Entity tags (zx18): deterministic keyword matching of articles against the entity directory
// (lb-brands / lb-malls seeds) plus the extras seed (mall chains, retail channels). No model calls:
// the same article text always yields the same tags, so annotating is idempotent and replayable.
// Articles with no hit keep one `__none__` marker row carrying the text hash, so unchanged
// articles are skipped on re-runs and vocabulary refreshes only re-tag what really changed…
// unless `all` forces a full rebuild.
import { createId } from "@paralleldrive/cuid2";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { BRANDS_FILE, MALLS_FILE } from "../leaderboard/directory.ts";

export type EntityType = "brand" | "mall" | "mall-chain" | "channel";

export interface EntityTerm {
  type: EntityType;
  slug: string;
  name: string;
  keyword: string;
  needle: string;
  /** Directory malls carry their city: a name hit without the city in the text is a cross-city
   *  false positive (「万象城」 alone says the chain, not which city's mall). */
  city?: string | null;
}

/** Vocabulary hygiene, per type: directory malls and mall chains carry generic two-character
 *  names (「中心」「老街」「万达」) that match far beyond the entity, so they need 3+ characters.
 *  Brand and channel names are curated proper nouns — a two-character name like 「森马」 or 「乐友」
 *  belongs to that entity alone — so their own seed keywords pass at 2+. */
const MIN_NEEDLE: Record<EntityType, number> = { brand: 2, channel: 2, mall: 3, "mall-chain": 3 };

interface ExtrasFile {
  mallChains: Array<{ slug: string; name: string; keywords: string[]; note?: string }>;
  channels: Array<{ slug: string; name: string; keywords: string[]; note?: string }>;
}

const EXTRAS_FILE = path.join(REPO_ROOT, "database/seeds/entity-extras-2026-10.json");

/** Every searchable term: directory brands and malls first, then chains and channels. */
export function entityTerms(): EntityTerm[] {
  const out: EntityTerm[] = [];
  const brands = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: Array<{ slug: string; name: string; keywords?: string[] }> };
  for (const b of brands.brands) {
    for (const k of new Set([b.name, ...(b.keywords ?? [])])) {
      if (k.length < MIN_NEEDLE.brand) continue;
      out.push({ type: "brand", slug: b.slug, name: b.name, keyword: k, needle: k.toLowerCase() });
    }
  }
  const malls = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls: Array<{ slug: string; name: string; city?: string; keywords?: string[] }> };
  for (const m of malls.malls) {
    for (const k of new Set([m.name, ...(m.keywords ?? [])])) {
      if (k.length < MIN_NEEDLE.mall) continue;
      out.push({ type: "mall", slug: m.slug, name: m.name, keyword: k, needle: k.toLowerCase(), city: m.city ?? null });
    }
  }
  const extras = JSON.parse(readFileSync(EXTRAS_FILE, "utf8")) as ExtrasFile;
  for (const c of extras.mallChains) {
    for (const k of new Set([c.name, ...c.keywords])) {
      if (k.length < MIN_NEEDLE["mall-chain"]) continue;
      out.push({ type: "mall-chain", slug: c.slug, name: c.name, keyword: k, needle: k.toLowerCase() });
    }
  }
  for (const c of extras.channels) {
    for (const k of new Set([c.name, ...c.keywords])) {
      if (k.length < MIN_NEEDLE.channel) continue;
      out.push({ type: "channel", slug: c.slug, name: c.name, keyword: k, needle: k.toLowerCase() });
    }
  }
  // Longer needles first so a directory hit like a full mall name beats its chain root.
  return out.sort((a, b) => b.needle.length - a.needle.length);
}

export interface ArticleText { id: string; title: string; excerpt: string | null; body: string | null }

export interface EntityHit { type: EntityType; slug: string; name: string; matchedVia: string }

/** Deterministic: longest matched keyword wins per (type, slug); one row per entity per article. */
export function matchEntities(text: string, terms: EntityTerm[]): EntityHit[] {
  const hay = text.toLowerCase();
  const bySlug = new Map<string, EntityHit>();
  for (const t of terms) {
    if (!hay.includes(t.needle)) continue;
    // A directory mall only counts when its city is present too: the bare chain name alone
    // must not pin the article to one city's mall.
    if (t.type === "mall" && t.city && !hay.includes(t.city.toLowerCase())) continue;
    const key = `${t.type}:${t.slug}`;
    const existing = bySlug.get(key);
    if (!existing || t.keyword.length > existing.matchedVia.length) {
      bySlug.set(key, { type: t.type, slug: t.slug, name: t.name, matchedVia: t.keyword });
    }
  }
  return [...bySlug.values()];
}

export const textOf = (a: ArticleText) => `${a.title} ${a.excerpt ?? ""} ${(a.body ?? "").slice(0, 600)}`;
export const hashOf = (a: ArticleText) => createHash("sha256").update(textOf(a)).digest("hex").slice(0, 32);

/** Annotate new articles and articles whose text changed; `all` re-tags everything. */
export async function annotateArticleEntities(opts: { all?: boolean; limit?: number } = {}): Promise<{ scanned: number; tagged: number; entities: number }> {
  const terms = entityTerms();
  // Vocabulary-drift self-healing: rows whose (type, slug) left the current vocabulary — a seed
  // rewritten by a parallel task — are dropped so their articles re-annotate instead of 404ing.
  const alive = [...new Set(terms.map((t) => `${t.type}:${t.slug}`)), "brand:__none__"];
  await sql`DELETE FROM article_entities WHERE NOT ((entity_type || ':' || entity_slug) = ANY(${alive}))`;
  const rows = await sql<(ArticleText & { stored_hash: string | null })[]>`
    SELECT a.id, a.title, a.excerpt, left(coalesce(a.body_text, ''), 600) AS body, e.h AS stored_hash
    FROM articles a
    LEFT JOIN LATERAL (SELECT article_hash AS h FROM article_entities WHERE article_id = a.id LIMIT 1) e ON true
    WHERE ${opts.all ?? false} OR e.h IS NULL OR e.h = ''
    ORDER BY a.discovered_at LIMIT ${opts.limit ?? 2000}`;
  let tagged = 0;
  let entities = 0;
  for (const a of rows) {
    const h = hashOf(a);
    if (!opts.all && a.stored_hash === h) continue;
    const hits = matchEntities(textOf(a), terms);
    await sql`DELETE FROM article_entities WHERE article_id = ${a.id}`;
    if (hits.length > 0) {
      const values = hits.map((hit) => ({ id: createId(), article_id: a.id, entity_type: hit.type, entity_slug: hit.slug, entity_name: hit.name, matched_via: hit.matchedVia, article_hash: h }));
      await sql`INSERT INTO article_entities ${sql(values, "id", "article_id", "entity_type", "entity_slug", "entity_name", "matched_via", "article_hash")}
                ON CONFLICT (article_id, entity_type, entity_slug) DO NOTHING`;
      entities += values.length;
    } else {
      await sql`INSERT INTO article_entities (id, article_id, entity_type, entity_slug, entity_name, matched_via, article_hash)
                VALUES (${createId()}, ${a.id}, 'brand', '__none__', '__none__', '__none__', ${h})
                ON CONFLICT (article_id, entity_type, entity_slug) DO UPDATE SET article_hash = EXCLUDED.article_hash, annotated_at = now()`;
    }
    tagged += 1;
  }
  return { scanned: rows.length, tagged, entities };
}
