// Refresh orchestration for brand profiles (zw14): collect every seed brand from the encyclopedia
// sources, then summarise the rows whose source text is new. A row whose source_hash is unchanged
// and already ready keeps its paid summary (re-runs are cheap). Scheduled weekly by the worker
// (brandprofiles.refresh); the API reads through listBrandProfiles/getBrandProfile.
import { createId } from "@paralleldrive/cuid2";
import { sql } from "../db.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { collectBrand, readBrandSeeds, type CollectedProfile } from "./collect.ts";
import { summarizeBrand } from "./summarize.ts";
import { annotateArticleEntities } from "../entitytags/matcher.ts";
import { extractEntitySignals } from "../entitytags/signals.ts";

export interface BrandProfileRow {
  slug: string;
  name: string;
  origin: string | null;
  channels: string | null;
  audience: string | null;
  priceRange: string | null;
  mainCategory: string | null;
  scale: string | null;
  philosophy: string | null;
  strength: string | null;
  foundedYear: number | null;
  listedAt: string | null;
  summary: string;
  summaryChars: number;
  evidence: string;
  wikiUrl: string | null;
  baikeUrl: string | null;
  status: string;
  summarizedAt: string | null;
}

interface ProfileRecord {
  slug: string;
  source_hash: string | null;
  status: string;
}

/** Returns whether the row needs (re)summarising. Exported for the ym132-④ trigger dry-run script
 *  (a ready row whose source is unchanged re-summarises only when newer approved signals exist). */
export async function upsertCollected(c: CollectedProfile): Promise<boolean> {
  const [row] = await sql<{ needs_summary: boolean }[]>`
    INSERT INTO brand_profiles (id, slug, name, wiki_url, baike_url, evidence, source_text, source_hash,
                                status, collected_at, updated_at)
    VALUES (${createId()}, ${c.slug}, ${c.name}, ${c.wikiUrl}, ${c.baikeUrl}, ${c.evidence}, ${c.sourceText},
            ${c.sourceHash}, 'pending', now(), now())
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name, wiki_url = EXCLUDED.wiki_url, baike_url = EXCLUDED.baike_url,
      evidence = EXCLUDED.evidence, source_text = EXCLUDED.source_text, source_hash = EXCLUDED.source_hash,
      -- ym132-④：除「源文本变更」外，晚于上次摘要的已审核文章信号也触发重摘要（让八问吸收信号；
      -- 审核位是人工闸，信号增量为低频有界事件，周批节奏消化）。
      status = CASE WHEN brand_profiles.source_hash = EXCLUDED.source_hash AND brand_profiles.status = 'ready'
                    AND NOT EXISTS (
                      SELECT 1 FROM entity_signal_drafts d
                      WHERE d.entity_type = 'brand' AND d.entity_slug = EXCLUDED.slug AND d.status = 'approved'
                        AND coalesce(d.reviewed_at, d.created_at) > coalesce(brand_profiles.summarized_at, 'epoch'::timestamptz)
                    )
                    THEN 'ready' ELSE 'pending' END,
      collected_at = now(), updated_at = now(), error = NULL
    RETURNING (status = 'pending') AS needs_summary`;
  return row?.needs_summary ?? true;
}

async function summarizeRow(c: CollectedProfile): Promise<"ready" | "failed"> {
  const outcome = await summarizeBrand(c);
  if (!outcome.ok || !outcome.fields) {
    await sql`UPDATE brand_profiles SET status = 'failed', model = ${outcome.model},
              receipt_id = ${outcome.receiptId ? String(outcome.receiptId) : null},
              error = ${outcome.error}, updated_at = now() WHERE slug = ${c.slug}`;
    return "failed";
  }
  const f = outcome.fields;
  await sql`UPDATE brand_profiles SET
      origin = ${f.origin}, channels = ${f.channels}, audience = ${f.audience}, price_range = ${f.priceRange},
      main_category = ${f.mainCategory}, scale = ${f.scale}, philosophy = ${f.philosophy}, strength = ${f.strength},
      founded_year = ${f.foundedYear}, listed_at = ${f.listedAt ?? null},
      summary = ${f.summary}, summary_chars = ${f.summaryChars},
      status = 'ready', model = ${outcome.model},
      receipt_id = ${outcome.receiptId ? String(outcome.receiptId) : null},
      error = NULL, summarized_at = now(), updated_at = now()
    WHERE slug = ${c.slug}`;
  return "ready";
}

/** One full round: collect all seed brands, summarise what is new. Interruption-safe per brand. */
export async function refreshBrandProfiles(): Promise<{ brands: number; collected: number; summarised: number; unchanged: number; failed: number; entityTags?: { scanned: number; tagged: number; entities: number }; entitySignals?: { scanned: number; extracted: number; inserted: number } }> {
  const seeds = readBrandSeeds();
  const stats: { brands: number; collected: number; summarised: number; unchanged: number; failed: number; entityTags?: { scanned: number; tagged: number; entities: number }; entitySignals?: { scanned: number; extracted: number; inserted: number } } = { brands: seeds.length, collected: 0, summarised: 0, unchanged: 0, failed: 0 };
  const pending: CollectedProfile[] = [];
  for (const seed of seeds) {
    if (shutdownSignal.signal.aborted) break;
    const collected = await collectBrand(seed);
    stats.collected += 1;
    if (await upsertCollected(collected)) pending.push(collected);
    else stats.unchanged += 1;
  }
  for (const c of pending) {
    if (shutdownSignal.signal.aborted) break;
    if (stats.summarised + stats.failed > 0) {
      // Pace the paid calls: the analysis queues share the same key and rate limit.
      await new Promise((r) => setTimeout(r, 1500));
    }
    if ((await summarizeRow(c)) === "ready") stats.summarised += 1;
    else stats.failed += 1;
  }
  // zx18: entity tags share this weekly pass (the brand vocabulary lives in the same seed);
  // reads fall back to live matching, this keeps the related-news index warm.
  try {
    stats.entityTags = await annotateArticleEntities();
  } catch {
    // A cold table only costs the live-matching fallback, never the profile refresh.
  }
  // ym82: article→profile signal backfill shares the weekly pass. Drafts await human review
  // before anything reaches a profile; ENTITY_SIGNALS_ENABLED=off stops this channel alone.
  if (process.env.ENTITY_SIGNALS_ENABLED !== "off") {
    try {
      stats.entitySignals = await extractEntitySignals();
    } catch {
      // Best-effort: the signal channel must never fail the profile refresh itself.
    }
  }
  return stats;
}

/** True when the table has no rows yet — the worker bootstraps a first round at startup. */
export async function brandProfilesEmpty(): Promise<boolean> {
  const [row] = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM brand_profiles`;
  return Number(row?.count ?? 0) === 0;
}

/** All ready profiles for the site (leaderboard pop-ups, article side cards). */
export async function listBrandProfiles(): Promise<BrandProfileRow[]> {
  return sql<BrandProfileRow[]>`
    SELECT slug, name, origin, channels, audience, price_range AS "priceRange", main_category AS "mainCategory",
           scale, philosophy, strength, founded_year AS "foundedYear", listed_at AS "listedAt",
           summary, summary_chars AS "summaryChars", evidence, wiki_url AS "wikiUrl", baike_url AS "baikeUrl",
           status, summarized_at AS "summarizedAt"
    FROM brand_profiles WHERE status = 'ready' ORDER BY slug`;
}

export async function getBrandProfile(slug: string): Promise<BrandProfileRow | null> {
  const rows = await sql<BrandProfileRow[]>`
    SELECT slug, name, origin, channels, audience, price_range AS "priceRange", main_category AS "mainCategory",
           scale, philosophy, strength, founded_year AS "foundedYear", listed_at AS "listedAt",
           summary, summary_chars AS "summaryChars", evidence, wiki_url AS "wikiUrl", baike_url AS "baikeUrl",
           status, summarized_at AS "summarizedAt"
    FROM brand_profiles WHERE slug = ${slug} AND status = 'ready'`;
  return rows[0] ?? null;
}
