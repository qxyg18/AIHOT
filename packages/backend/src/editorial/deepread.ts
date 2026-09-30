// Deep read (ka4): one plain-language paragraph per article for the visitor who never opens the
// source — what happened and what it means, grounded in the site's own memory: past coverage of
// the same brand or mall, the brand profile, the mall directory facts. Owner rules (2026-09-30):
//   1. brand/mall keyword match → pull that entity's site history;
//   2. the model reads history + article into 大白话;
//   3. without history it may borrow a comparable brand (labelled as analogy) or read the article
//      as it stands;
//   4. no brand/mall match at all → no reading, the AI 导读 stays the only copy;
//   5. market-wide pieces (policy, macro data, industry statistics) always get a reading.
// The sweep runs off-peak with the other model-heavy jobs (deepread.sweep); rows are keyed by
// article, so a rerun only pays for articles that have no row yet. Vocab = the two leaderboard
// seed files (SSOT) plus the structure step's own entity tags.
import { z } from "zod";
import { readFileSync } from "node:fs";
import { sql } from "../db.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { modelFor } from "./models.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { BRANDS_FILE, MALLS_FILE } from "../leaderboard/directory.ts";
import { ENTITIES } from "@aihot/industry/taxonomy";
import { shutdownSignal } from "../jobs/queue.ts";

export const DEEPREAD_PROMPT_VERSION = promptVersion("deep-read");
const SYSTEM = promptText("deep-read");

/** Match text is the card + a head of the body; the model context gets a longer head. */
const MATCH_BODY_CHARS = 1200;
const CONTEXT_BODY_CHARS = 3500;
const MAX_BRANDS = 3;
const MAX_MALLS = 2;
const HISTORY_PER_ENTITY = 4;
/** Paid-call pacing, shared key with the analysis queues (brandprofiles rule). */
const CALL_PACE_MS = 1500;

// ---------------------------------------------------------------------------
// Vocabulary: the leaderboard seed files, loaded once per process.
// ---------------------------------------------------------------------------

interface SeedBrand {
  slug: string;
  name: string;
  keywords: string[];
}

interface SeedMall {
  slug: string;
  name: string;
  city: string | null;
  keywords: string[];
  area: number | null;
  openedAt: string | null;
  revenueYi: number | null;
  footfallTier: number | null;
}

let vocabCache: { brands: SeedBrand[]; malls: SeedMall[] } | null = null;

function vocab(): { brands: SeedBrand[]; malls: SeedMall[] } {
  if (vocabCache) return vocabCache;
  const brandsFile = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as {
    brands?: Array<{ slug: string; name: string; keywords?: string[] }>;
  };
  const mallsFile = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as {
    malls?: Array<{ slug: string; name: string; city?: string; keywords?: string[]; area?: number; openedAt?: string; revenue?: number; footfallTier?: number }>;
  };
  const withName = <T extends { name: string; keywords?: string[] }>(e: T): string[] =>
    [...new Set([...(e.keywords ?? []), e.name])].filter((k) => k.length >= 2);
  const mallsRaw = (mallsFile.malls ?? []).map((m) => ({
    slug: m.slug,
    // Seed names may carry a qualifier ("杭州新天地(购物中心+街区)") — display the bare name.
    name: m.name.replace(/[（(].*$/, "").trim() || m.name,
    city: m.city ?? null,
    keywords: withName(m),
    area: m.area ?? null, openedAt: m.openedAt ?? null, revenueYi: m.revenue ?? null, footfallTier: m.footfallTier ?? null,
  }));
  // Ambiguity filter (remediation round 3): city-scoped entries share generic keywords ("万象城",
  // "SKP", "吾悦广场"), and which city such a keyword pins down is file order — noise. A keyword
  // used by 2+ entries (or equal to another entry's name) can no longer match; only each venue's
  // own (trimmed) name and its unique keywords may.
  const kwUsers = new Map<string, number>();
  for (const m of mallsRaw) for (const k of new Set([...m.keywords, m.name])) kwUsers.set(k, (kwUsers.get(k) ?? 0) + 1);
  const malls: SeedMall[] = mallsRaw.map((m) => ({
    ...m,
    keywords: [...new Set([m.name, ...m.keywords.filter((k) => kwUsers.get(k) === 1)])],
  }));
  vocabCache = {
    brands: (brandsFile.brands ?? []).map((b) => ({ slug: b.slug, name: b.name, keywords: withName(b) })),
    malls,
  };
  return vocabCache;
}

// ---------------------------------------------------------------------------
// Classification (owner rules 1, 4, 5)
// ---------------------------------------------------------------------------

/** Categories the structure step already assigns to market-wide pieces (owner rule 5). */
const MACRO_CATEGORIES = new Set(["统计/数据", "市场/数据", "政策/合规", "人口/出生率", "行业研报", "原材料成本"]);
/** Title/summary signals too narrow to false-positive on brand copy ("加盟政策" etc.);
 *  bare 同比/环比 left out on purpose — a single brand's revenue report is not 大盘 (audit P2). */
const MACRO_TEXT_RE =
  /(国家统计局|统计局|商务部|市场监管总局|工信部|发改委|国务院|人社部|新国标|GB\s?\d{4,5}|社零|社会消费品零售总额|出生率|生育率|出生人口|PMI)/;

export interface MatchedEntity {
  type: "brand" | "mall";
  slug: string;
  name: string;
  keywords: string[];
}

export interface DeepReadClassification {
  kind: "brand" | "mall" | "mixed" | "macro";
  brands: MatchedEntity[];
  malls: MatchedEntity[];
  macro: string[];
}

/** The lowercase haystack entity matching runs on (card fields + a head of the body). */
function matchTextOf(input: { title: string; originalTitle: string | null; summary: string | null; tags: string[]; body: string | null }): string {
  return [input.title, input.originalTitle, input.summary, ...(input.tags ?? []), (input.body ?? "").slice(0, MATCH_BODY_CHARS)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/** Null = nothing to read on (owner rule 4): the article keeps its AI 导读 only. */
export function classifyArticle(input: {
  title: string;
  originalTitle: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  body: string | null;
}): DeepReadClassification | null {
  const { brands, malls } = vocab();
  const text = matchTextOf(input);

  // Macro signals ride the structure step's Chinese tags; the category column stores English keys,
  // so matching it against the Chinese label set would be dead code.
  const macro: string[] = [];
  for (const t of input.tags ?? []) if (MACRO_CATEGORIES.has(t) && !macro.includes(t)) macro.push(t);
  if (macro.length === 0 && MACRO_TEXT_RE.test(`${input.title}\n${input.summary ?? ""}`)) macro.push("宏观/统计信号");

  const hitBrands = new Map<string, MatchedEntity>();
  // The structure step's own subjects arrive as entity:<id> tags; resolve them through the seed list.
  for (const t of input.tags ?? []) {
    if (!t.startsWith("entity:")) continue;
    const id = t.slice("entity:".length);
    const e = ENTITIES[id];
    if (!e) continue;
    const seed = brands.find((b) => b.name === e.name || b.keywords.includes(e.name));
    const slug = seed?.slug ?? id;
    hitBrands.set(slug, { type: "brand", slug, name: seed?.name ?? e.name, keywords: seed ? seed.keywords : [e.name, ...e.aliases] });
  }
  for (const b of brands) {
    if (hitBrands.has(b.slug)) continue;
    if (b.keywords.some((k) => text.includes(k.toLowerCase()))) hitBrands.set(b.slug, { type: "brand", slug: b.slug, name: b.name, keywords: b.keywords });
  }

  const hitMalls = new Map<string, MatchedEntity>();
  for (const m of malls) {
    // City guard (remediation round 2): a city-scoped mall ("上海万象城") must not ride a generic
    // keyword ("万象城") onto another city's article — its city has to appear in the text too.
    if (m.city && !text.includes(m.city.toLowerCase())) continue;
    if (m.keywords.some((k) => text.includes(k.toLowerCase()))) hitMalls.set(m.slug, { type: "mall", slug: m.slug, name: m.name, keywords: m.keywords });
  }

  if (hitBrands.size === 0 && hitMalls.size === 0 && macro.length === 0) return null;
  const brandList = [...hitBrands.values()].slice(0, MAX_BRANDS);
  const mallList = [...hitMalls.values()].slice(0, MAX_MALLS);
  const kind = brandList.length > 0 && mallList.length > 0 ? "mixed" : brandList.length > 0 ? "brand" : mallList.length > 0 ? "mall" : "macro";
  return { kind, brands: brandList, malls: mallList, macro };
}

// ---------------------------------------------------------------------------
// Context: the site's own memory about the matched entities
// ---------------------------------------------------------------------------

const DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

const like = (k: string) => `%${k.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`;

/** Past public coverage of one entity, newest first (the current article excluded). */
async function historyLines(match: MatchedEntity, excludeId: string): Promise<string[]> {
  const kws = match.keywords.filter((k) => k.length >= 2).slice(0, 3);
  if (kws.length === 0) return [];
  const cond = kws.map((k) => sql`p.search_text LIKE ${like(k)}`).reduce((a, b) => sql`${a} OR ${b}`);
  const rows = await sql<{ title: string; summary: string | null; at: Date | null }[]>`
    SELECT p.title, p.summary, coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p
    WHERE p.visibility = 'public' AND p.eligible AND p.article_id <> ${excludeId} AND (${cond})
    ORDER BY at DESC
    LIMIT ${HISTORY_PER_ENTITY}`;
  return rows.map((r) => `${r.at ? DAY.format(r.at) : "日期不详"}《${r.title}》${r.summary ? `——${r.summary.slice(0, 70)}` : ""}`);
}

interface ProfileBlock {
  name: string;
  origin: string | null;
  audience: string | null;
  price_range: string | null;
  main_category: string | null;
  scale: string | null;
  summary: string;
}

/** The site's memory of the matched entities, as the model's background block ("无" when bare). */
async function contextBlocks(cls: DeepReadClassification, articleId: string): Promise<string> {
  const parts: string[] = [];
  for (const m of [...cls.brands, ...cls.malls]) {
    const hist = await historyLines(m, articleId);
    const histText = hist.length > 0 ? `站内近期报道：\n${hist.map((l) => `- ${l}`).join("\n")}` : "站内近期无相关报道";
    if (m.type === "brand") {
      const [p] = await sql<ProfileBlock[]>`
        SELECT name, origin, audience, price_range, main_category, scale, summary
        FROM brand_profiles WHERE slug = ${m.slug} AND status = 'ready' LIMIT 1`;
      const facts: string[] = [];
      if (p?.main_category) facts.push(`品类：${p.main_category}`);
      if (p?.origin) facts.push(`发源：${p.origin}`);
      if (p?.audience) facts.push(`主打人群：${p.audience}`);
      if (p?.price_range) facts.push(`价位：${p.price_range}`);
      if (p?.scale) facts.push(`规模：${p.scale}`);
      if (p?.summary) facts.push(`站内简介：${p.summary}`);
      parts.push([`关于品牌「${p?.name ?? m.name}」`, facts.length > 0 ? facts.join("；") : "站内暂无档案", histText].join("\n"));
    } else {
      const seed = vocab().malls.find((x) => x.slug === m.slug);
      const facts: string[] = [];
      if (seed?.city) facts.push(`城市：${seed.city}`);
      if (seed?.revenueYi != null) facts.push(`年销售额约${seed.revenueYi}亿（公开概数）`);
      if (seed?.area != null) facts.push(`体量约${seed.area}万㎡`);
      if (seed?.openedAt) facts.push(`${seed.openedAt}年开业`);
      parts.push([`关于商业体「${m.name}」`, facts.length > 0 ? facts.join("；") : "站内暂无档案", histText].join("\n"));
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : "无";
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DeepReadOut = z.object({
  angle: z.enum(["history", "analogy", "direct", "macro"]),
  interpretation: z.string().min(40).max(600),
});

export type DeepReadStatus = "ready" | "skipped" | "failed" | "pending";

export interface DeepReadOutcome {
  ok: boolean;
  status: DeepReadStatus;
  model?: string | null;
  error?: string | null;
}

async function storeRow(articleId: string, status: "skipped" | "failed", reason: string): Promise<void> {
  // skipped keeps its reason in skip_reason; failed keeps the error text in error (audit P3).
  await sql`
    INSERT INTO article_deep_reads (article_id, status, skip_reason, error, updated_at)
    VALUES (${articleId}, ${status}, ${status === "skipped" ? reason : null}, ${status === "failed" ? reason : null}, now())
    ON CONFLICT (article_id) DO UPDATE SET status = ${status},
      skip_reason = ${status === "skipped" ? reason : null}, error = ${status === "failed" ? reason : null}, updated_at = now()`;
}

/**
 * The reading for one published article. Transient provider trouble leaves no row (the next sweep
 * retries); an unusable model output is recorded as failed so it stops burning calls.
 */
export async function generateDeepRead(articleId: string): Promise<DeepReadOutcome> {
  const [row] = await sql<{
    title: string;
    original_title: string | null;
    summary: string | null;
    category: string | null;
    tags: string[] | null;
    body_text: string | null;
  }[]>`
    SELECT p.title, p.original_title, p.summary, p.category, p.tags, a.body_text
    FROM publications p JOIN articles a ON a.id = p.article_id
    WHERE p.article_id = ${articleId} AND p.visibility = 'public' AND p.eligible`;
  if (!row) return { ok: false, status: "pending", error: "not published" };

  const input = { title: row.title, originalTitle: row.original_title, summary: row.summary, category: row.category, tags: row.tags ?? [], body: row.body_text };
  const cls = classifyArticle(input);
  if (!cls) {
    await storeRow(articleId, "skipped", "no_entity_no_macro");
    return { ok: true, status: "skipped" };
  }

  // Belt and suspenders (audit M1): a seed file edited by a sibling session mid-sweep once handed
  // the matcher entities whose keyword is not in the article at all ("兰州中心" polluted 14 rows).
  // Re-verify every match against the same haystack classification saw; keep only verified hits.
  const text = matchTextOf(input);
  const verified = (list: MatchedEntity[]) => list.filter((m) => m.keywords.some((k) => text.includes(k.toLowerCase())));
  cls.brands = verified(cls.brands);
  cls.malls = verified(cls.malls);
  if (cls.brands.length === 0 && cls.malls.length === 0) {
    if (cls.macro.length === 0) {
      await storeRow(articleId, "skipped", "no_entity_no_macro");
      return { ok: true, status: "skipped" };
    }
    cls.kind = "macro";
  } else {
    cls.kind = cls.brands.length > 0 && cls.malls.length > 0 ? "mixed" : cls.brands.length > 0 ? "brand" : cls.malls.length > 0 ? "mall" : "macro";
  }

  const blocks = await contextBlocks(cls, articleId);
  const body = (row.body_text ?? "").slice(0, CONTEXT_BODY_CHARS);
  const user = [
    "【文章内容】",
    `标题：${row.title}`,
    row.original_title ? `原标题：${row.original_title}` : null,
    row.summary ? `AI摘要：${row.summary}` : null,
    `分类：${row.category ?? "未分类"}；标签：${(row.tags ?? []).filter((t) => !t.startsWith("entity:")).join("、") || "无"}`,
    body ? `正文节选：\n${body}` : null,
    "【站内历史信息】",
    blocks,
  ]
    .filter(Boolean)
    .join("\n\n");

  let res: Awaited<ReturnType<typeof chatJson<typeof DeepReadOut>>>;
  try {
    const model = await modelFor("deepread");
    res = await chatJson({
      model,
      purpose: "article_deep_read",
      subject: row.title.slice(0, 60),
      promptVersion: DEEPREAD_PROMPT_VERSION,
      system: SYSTEM,
      user,
      schema: DeepReadOut,
      temperature: 0.3,
      // The GLM Anthropic layer always thinks first and thinking tokens share the maxTokens budget;
      // too small and the JSON is cut off before it starts (first sweep lost 2/4 to truncation).
      maxTokens: 8192,
      timeoutMs: 180_000,
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    if (error instanceof ProviderRejectedError || error instanceof ReceiptBusyError || error instanceof BudgetExceededError || error instanceof ReceiptUnknownError) {
      return { ok: false, status: "pending", error: message };
    }
    if (error instanceof ModelOutputError) {
      await storeRow(articleId, "failed", message);
      return { ok: false, status: "failed", error: message };
    }
    throw error;
  }

  const interpretation = res.data.interpretation.trim().slice(0, 480);
  const entities = [...cls.brands, ...cls.malls].map((m) => ({ type: m.type, slug: m.slug, name: m.name }));
  await sql`
    INSERT INTO article_deep_reads (article_id, status, kind, entities, angle, interpretation, model, prompt_version, receipt_id, updated_at)
    VALUES (${articleId}, 'ready', ${cls.kind}, ${sql.json(entities as never)}, ${res.data.angle}, ${interpretation},
            ${res.model}, ${DEEPREAD_PROMPT_VERSION}, ${res.receiptId}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      status = 'ready', skip_reason = NULL, error = NULL, kind = ${cls.kind}, entities = ${sql.json(entities as never)},
      angle = ${res.data.angle}, interpretation = ${interpretation}, model = ${res.model},
      prompt_version = ${DEEPREAD_PROMPT_VERSION}, receipt_id = ${res.receiptId}, updated_at = now()`;
  return { ok: true, status: "ready", model: res.model };
}

/** One sweep round: the newest public articles without a row, newest first. */
export async function sweepDeepReads(limit = 12): Promise<{ scanned: number; ready: number; skipped: number; failed: number }> {
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id
    FROM publications p
    LEFT JOIN article_deep_reads d ON d.article_id = p.article_id
    WHERE d.article_id IS NULL AND p.visibility = 'public' AND p.eligible AND p.title IS NOT NULL
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC
    LIMIT ${limit}`;
  const stats = { scanned: rows.length, ready: 0, skipped: 0, failed: 0 };
  for (const [i, r] of rows.entries()) {
    if (shutdownSignal.signal.aborted) break;
    let out: DeepReadOutcome;
    try {
      out = await generateDeepRead(r.article_id);
    } catch (error) {
      // One bad article must not kill the round: record it and move on (the next sweep retries it).
      await storeRow(r.article_id, "failed", String(error instanceof Error ? error.message : error).slice(0, 300)).catch(() => {});
      stats.failed += 1;
      continue;
    }
    if (out.status === "ready") stats.ready += 1;
    else if (out.status === "skipped") stats.skipped += 1;
    else if (out.status === "failed") stats.failed += 1;
    // Pace only after a paid call; skips cost nothing.
    if (out.status === "ready" && i < rows.length - 1) await new Promise((resolve) => setTimeout(resolve, CALL_PACE_MS));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Read side (the article detail payload)
// ---------------------------------------------------------------------------

export interface SiteDeepReadRow {
  kind: "brand" | "mall" | "mixed" | "macro";
  angle: "history" | "analogy" | "direct" | "macro";
  interpretation: string;
  entities: Array<{ type: "brand" | "mall"; name: string }>;
  updatedAt: string;
}

export async function loadDeepReadForSite(articleId: string): Promise<SiteDeepReadRow | null> {
  const [row] = await sql<{ kind: SiteDeepReadRow["kind"]; angle: SiteDeepReadRow["angle"]; interpretation: string; entities: unknown; updated_at: Date }[]>`
    SELECT kind, angle, interpretation, entities, updated_at
    FROM article_deep_reads
    WHERE article_id = ${articleId} AND status = 'ready'`;
  if (!row) return null;
  return {
    kind: row.kind,
    angle: row.angle,
    interpretation: row.interpretation,
    entities: Array.isArray(row.entities) ? (row.entities as SiteDeepReadRow["entities"]) : [],
    updatedAt: row.updated_at.toISOString(),
  };
}
