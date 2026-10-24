// Article → entity profile signal backfill (ym82 信息串联首期施工二): extracts structured
// facts — store openings, revenue figures, store counts — from the headline and excerpt of every
// recently annotated article, attributes each fact to the entity whose matched name appears in
// the same sentence, and files it as a reviewable draft. Nothing reaches a brand profile until a
// human approves the draft; re-running the extractor over the same article never duplicates a
// fact (unique key article+entity+kind+value+unit). Mall facts stay archived in the drafts table
// because the mall seed file remains hand-maintained.
import { createId } from "@paralleldrive/cuid2";
import { createHash } from "node:crypto";
import { sql } from "../db.ts";

export type SignalKind = "openings" | "revenue" | "stores";
export const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  openings: "新开店数",
  revenue: "业绩数字",
  stores: "门店数",
};

export interface DraftSignal {
  kind: SignalKind;
  value: number;
  unit: string;
  caliber: string | null;
  quote: string;
}

/** Sentence split over headline + excerpt + body head, then comma-level segments — the same
 *  text surface the entity annotator matches on, refined to the segment a number belongs to.
 *  Financial prose gives each comma segment its own subject ("休闲服饰收入为18.1亿元，儿童服饰收入为
 *  40.7亿元"), so requiring the entity name inside the same segment keeps division-level figures
 *  from being attributed to a brand merely mentioned later in the sentence (measured on the real
 *  corpus: 4 of 8 first-pass drafts were such cross-segment misattributions). A signal still
 *  needs FOUR co-occurrences in one segment (entity name + signal word + number + unit). */
function sentences(headline: string, excerpt: string, body: string): string[] {
  return `${headline}\n${excerpt}\n${body}`
    .split(/[。；;！!？?\n]/)
    .flatMap((s) => s.split(/[,，、]/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const COUNT_RE = /([0-9][0-9,，]{0,9})\s*(?:余)?家(?!长|属|具)/g;
const YI_RE = /([0-9][0-9,，]{0,9}(?:\.[0-9]+)?)\s*(?:多)?亿/;
/** Kind is decided by the words near each number (前 10 字), so one sentence can carry both
 *  "净增 15 家" and "总数 1,200 家" without cross-labelling. */
const OPENING_NEAR = /(新开|新开了|开出|开出了|拓店|新增|扩张|开业)/;
const STORE_WORDS = /(门店|网点|直营店|加盟店|专卖店|总店数|门店数)/;
const NET_NEAR = /(净增|增加)/;
const REVENUE_WORDS = /(营收|收入|销售额|营业额|零售额|业绩)/;
/** Currencies other than CNY keep the figure out of the profile (mixed calibers beat the purpose). */
const FOREIGN_CURRENCY = /[美港日欧英]元/;

function parseNumber(raw: string): number {
  return Number(raw.replace(/[,，]/g, ""));
}

/** One sentence → one signal per number; kind from the words just before the number. */
export function extractFromSentence(s: string): DraftSignal[] {
  const out: DraftSignal[] = [];
  const quote = s.length > 200 ? s.slice(0, 200) : s;
  for (const m of s.matchAll(COUNT_RE)) {
    const value = parseNumber(m[1]!);
    if (!Number.isFinite(value)) continue;
    const before = s.slice(Math.max(0, m.index - 10), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 4);
    if (OPENING_NEAR.test(before) && /(店|门店)/.test(before + after)) {
      out.push({ kind: "openings", value, unit: "家", caliber: "新开店数", quote });
    } else if (STORE_WORDS.test(s)) {
      out.push({ kind: "stores", value, unit: "家", caliber: NET_NEAR.test(before) ? "净增" : "门店数", quote });
    }
  }
  const yiMatch = YI_RE.exec(s);
  if (yiMatch) {
    const after = s.slice((yiMatch.index ?? 0) + yiMatch[0].length, (yiMatch.index ?? 0) + yiMatch[0].length + 2);
    const value = parseNumber(yiMatch[1]!);
    if (Number.isFinite(value) && REVENUE_WORDS.test(s) && !FOREIGN_CURRENCY.test(s) && !/^[美港日欧英]元/.test(after)) {
      out.push({ kind: "revenue", value, unit: "亿元", caliber: "营收概数", quote });
    }
  }
  return out;
}

/** All signals from one article text for one entity: only sentences that name the entity
 *  (by its seed name or the keyword the annotator matched) attribute facts to it. */
export function extractSignalsForEntity(headline: string, excerpt: string, body: string, names: string[]): DraftSignal[] {
  const out: DraftSignal[] = [];
  const seen = new Set<string>();
  for (const s of sentences(headline, excerpt, body)) {
    if (!names.some((n) => n && s.includes(n))) continue;
    for (const sig of extractFromSentence(s)) {
      const key = `${sig.kind}:${sig.value}:${sig.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sig);
    }
  }
  return out;
}

export interface ExtractStats {
  scanned: number;
  extracted: number;
  inserted: number;
}

/** Scan articles annotated in the lookback window and file new drafts. Safe to re-run.
 *  The window rides on discovered_at, not published_at: backfilled literature (research
 *  reports, ranking reprints) lands with old publication dates, and those facts are exactly
 *  what a profile wants — re-scans of the same article are deduped by the unique key. */
export async function extractEntitySignals(opts: { windowDays?: number } = {}): Promise<ExtractStats> {
  const windowDays = opts.windowDays ?? 14;
  const rows = await sql<{ id: string; title: string; excerpt: string; body: string; entity_type: "brand" | "mall"; entity_slug: string; entity_name: string; matched_via: string }[]>`
    SELECT a.id, a.title, coalesce(a.excerpt, '') AS excerpt, left(coalesce(a.body_text, ''), 2000) AS body,
           e.entity_type, e.entity_slug, e.entity_name, e.matched_via
    FROM article_entities e JOIN articles a ON a.id = e.article_id
    WHERE e.entity_slug <> '__none__' AND e.entity_type IN ('brand', 'mall')
      AND a.discovered_at >= now() - (${windowDays} || ' days')::interval
    ORDER BY a.discovered_at LIMIT 3000`;
  const stats: ExtractStats = { scanned: rows.length, extracted: 0, inserted: 0 };
  const byArticle = new Map<string, { title: string; excerpt: string; body: string; entities: Array<{ type: "brand" | "mall"; slug: string; name: string; via: string }> }>();
  for (const r of rows) {
    const cur = byArticle.get(r.id) ?? { title: r.title, excerpt: r.excerpt, body: r.body, entities: [] };
    cur.entities.push({ type: r.entity_type, slug: r.entity_slug, name: r.entity_name, via: r.matched_via });
    byArticle.set(r.id, cur);
  }
  for (const [articleId, a] of byArticle) {
    // Same shape as the annotator's content hash, over the extraction surface (headline +
    // excerpt + body head): which text version a fact was read from, for later re-extraction.
    const articleHash = createHash("sha256").update(`${a.title} ${a.excerpt} ${a.body}`).digest("hex").slice(0, 32);
    const values = [];
    for (const ent of a.entities) {
      for (const sig of extractSignalsForEntity(a.title, a.excerpt, a.body, [ent.name, ent.via])) {
        stats.extracted += 1;
        values.push({
          id: createId(), article_id: articleId, entity_type: ent.type, entity_slug: ent.slug,
          entity_name: ent.name, kind: sig.kind, value: sig.value, unit: sig.unit,
          caliber: sig.caliber, quote: sig.quote, article_hash: articleHash,
        });
      }
    }
    if (values.length > 0) {
      const inserted = await sql`
        INSERT INTO entity_signal_drafts ${sql(values, "id", "article_id", "entity_type", "entity_slug", "entity_name", "kind", "value", "unit", "caliber", "quote", "article_hash")}
        ON CONFLICT (article_id, entity_slug, kind, value, unit) DO NOTHING
        RETURNING id`;
      stats.inserted += inserted.length;
    }
  }
  return stats;
}

export interface SignalDraftRow {
  id: string;
  articleId: string;
  articleTitle: string | null;
  entityType: "brand" | "mall";
  entitySlug: string;
  entityName: string;
  kind: SignalKind;
  value: string;
  unit: string;
  caliber: string | null;
  quote: string;
  status: string;
  reviewNote: string | null;
  createdAt: string;
}

export async function listEntitySignalDrafts(status?: string): Promise<SignalDraftRow[]> {
  const rows = await sql<SignalDraftRow[]>`
    SELECT d.id, d.article_id AS "articleId", a.title AS "articleTitle", d.entity_type AS "entityType",
           d.entity_slug AS "entitySlug", d.entity_name AS "entityName", d.kind, d.value::text AS value,
           d.unit, d.caliber, d.quote, d.status, d.review_note AS "reviewNote", d.created_at::text AS "createdAt"
    FROM entity_signal_drafts d LEFT JOIN articles a ON a.id = d.article_id
    WHERE ${status ?? null}::text IS NULL OR d.status = ${status ?? null}
    ORDER BY d.created_at DESC LIMIT 200`;
  return rows;
}

export interface ApprovedSignal {
  id: string;
  kind: SignalKind;
  value: number;
  unit: string;
  caliber: string | null;
  quote: string;
  articleId: string;
  articleTitle: string | null;
  /** 审核通过时刻（reviewed_at；缺则落库时刻）——展示面「何时吸收」的时间戳。 */
  at: string;
}

/** Approved signals of one entity, newest first (ym132-③④): the display face for entity pages and
 *  the absorption input for the profile summary. The drafts table is the single review record for
 *  both types — brand rows also mirror into brand_profiles.entity_signals, mall rows stay archived
 *  here — so both pages read symmetrically. Same page gate as every article reading (ym99): a
 *  withdrawn article's signal rows no longer quote out. */
export async function listApprovedSignals(type: "brand" | "mall", slug: string, limit = 12): Promise<ApprovedSignal[]> {
  const rows = await sql<ApprovedSignal[]>`
    SELECT d.id, d.kind, d.value::float8 AS value, d.unit, d.caliber, d.quote,
           d.article_id AS "articleId", a.title AS "articleTitle",
           coalesce(d.reviewed_at, d.created_at)::text AS at
    FROM entity_signal_drafts d
    JOIN articles a ON a.id = d.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE d.entity_type = ${type} AND d.entity_slug = ${slug} AND d.status = 'approved'
      AND p.visibility = 'public' AND s.participation_mode = 'editorial'
    ORDER BY coalesce(d.reviewed_at, d.created_at) DESC, d.id DESC
    LIMIT ${limit}`;
  return rows;
}

export type ReviewOutcome = "approved" | "rejected" | "missing" | "already_reviewed" | "backfill_skipped";
export interface ReviewResult {
  outcome: ReviewOutcome;
  /** P2-1（审计建议）：同实体同事实（kind+value+unit）已有 approved 行时置真——两篇文章报道同一事实
   *  会各留一条草稿，审核员可据此拒回其一，防档案内同事实多行堆积。 */
  duplicateApproved?: boolean;
}

/** Human review gate: pending → approved/rejected. Approving a brand draft mirrors it into
 *  brand_profiles.entity_signals (append-only JSONB, bound via tx.json — a plain string
 *  parameter gets serialised a second time by the driver and lands as a nested string);
 *  no brand profile row → archived only. */
export async function reviewEntitySignal(id: string, decision: "approve" | "reject", note = ""): Promise<ReviewResult> {
  const status = decision === "approve" ? "approved" : "rejected";
  return sql.begin(async (tx) => {
    const rows = await tx<{ entity_type: string; entity_slug: string; entity_name: string; kind: SignalKind; value: string; unit: string; caliber: string | null; quote: string; article_id: string }[]>`
      UPDATE entity_signal_drafts SET status = ${status}, review_note = ${note}, reviewed_at = now()
      WHERE id = ${id} AND status = 'pending' RETURNING entity_type, entity_slug, entity_name, kind, value::text AS value, unit, caliber, quote, article_id`;
    if (rows.length === 0) {
      const [existing] = await tx<{ status: string }[]>`SELECT status FROM entity_signal_drafts WHERE id = ${id}`;
      return existing ? { outcome: "already_reviewed" } : { outcome: "missing" };
    }
    let duplicateApproved = false;
    if (decision === "approve") {
      const dup = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM entity_signal_drafts
        WHERE status = 'approved' AND entity_slug = ${rows[0]!.entity_slug} AND entity_type = ${rows[0]!.entity_type}
          AND kind = ${rows[0]!.kind} AND value = ${rows[0]!.value} AND unit = ${rows[0]!.unit} AND id <> ${id}`;
      duplicateApproved = Number(dup[0]?.n ?? 0) > 0;
      if (rows[0]!.entity_type === "brand") {
        const sig = {
          id, kind: rows[0]!.kind, value: Number(rows[0]!.value), unit: rows[0]!.unit,
          caliber: rows[0]!.caliber, quote: rows[0]!.quote, articleId: rows[0]!.article_id, at: new Date().toISOString(),
        };
        const updated = await tx`
          UPDATE brand_profiles SET entity_signals = entity_signals || ${tx.json([sig] as never)}, updated_at = now()
          WHERE slug = ${rows[0]!.entity_slug} RETURNING slug`;
        if (updated.length === 0) return { outcome: "backfill_skipped", duplicateApproved };
      }
    }
    return { outcome: status, duplicateApproved };
  });
}
