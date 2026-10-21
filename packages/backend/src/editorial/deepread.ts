// Deep read (ka4): one plain-language paragraph per article for the visitor who never opens the
// source — what happened and what it means, grounded in the site's own memory: past coverage of
// the same brand or mall, the brand profile, the mall directory facts. Owner rules (2026-09-30):
//   1. brand/mall keyword match → pull that entity's site history;
//   2. the model reads history + article into 大白话;
//   3. without history it may borrow a comparable brand (labelled as analogy) or read the article
//      as it stands;
//   4. no brand/mall match at all → no reading, the AI 导读 stays the only copy (older articles
//      only — see rule 7);
//   5. market-wide pieces (policy, macro data, industry statistics) always get a reading;
//   7. (2026-10-05) the reading is standard for everything published on/after 2026-10-01
//      (Beijing): a no-signal article earns a plain direct reading instead of the rule-4 skip.
// The sweep runs off-peak with the other model-heavy jobs (deepread.sweep); rows are keyed by
// article, so a rerun only pays for articles that have no row yet. Vocab = the two leaderboard
// seed files (SSOT) plus the structure step's own entity tags.
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../db.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { modelFor, ShiftWaitError } from "./models.ts";
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

/** Transient-failure retry ceiling (T08/ym245): attempts count per input identity — a revision or
 *  basis change restarts the clock; the same input backs off 15min, then 30min, then stops
 *  auto-retrying until its input moves again (AC2 "有重试上界"). */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MINUTES = 15;

// ---------------------------------------------------------------------------
// Input identity (T08/ym245, F5): a reading is only valid for the inputs that produced it — the
// article's revision (content) plus a basis hash over the prompt version and the vocabulary seed
// bytes. Code/taxonomy identity is deliberately out: it only changes with a deploy, and keying on
// it would void the whole table on every release (ADR decision=simplify). Legacy rows (identity
// NULL, migration 0052's contract) are never current — they read as a miss and get re-swept.
// ---------------------------------------------------------------------------

let basisCache: { value: string; at: number } | null = null;
const BASIS_TTL_MS = 30_000;

/** sha256(DEEPREAD_PROMPT_VERSION + brand/mall seed file bytes). The seeds are hot files (the
 *  ym238 M1 note above), so this reads the raw bytes on a short TTL instead of trusting the
 *  process-start vocab cache — a seed edit surfaces within BASIS_TTL_MS. When the value moves it
 *  also drops vocab()'s parse cache: without that, a sweep would re-read every row against the
 *  OLD vocabulary while stamping the NEW basis on the results (audit P1-1). An unreadable seed
 *  holds the last good value instead of flipping the basis (an IO hiccup must not void every
 *  row and re-read them all, audit P3-6). */
function currentBasis(): string {
  const now = Date.now();
  if (basisCache && now - basisCache.at < BASIS_TTL_MS) return basisCache.value;
  const h = createHash("sha256");
  h.update(`${DEEPREAD_PROMPT_VERSION}\n`);
  let unreadable = false;
  for (const file of [BRANDS_FILE, MALLS_FILE]) {
    try {
      h.update(readFileSync(file));
    } catch {
      unreadable = true;
    }
  }
  if (unreadable && basisCache) return basisCache.value;
  const value = h.digest("hex");
  if (basisCache && value !== basisCache.value) vocabCache = null;
  basisCache = { value, at: now };
  return value;
}

/** Test-only hooks: the basis cache and its TTL are process state, which no test can reach
 *  otherwise (audit P2-3 — the basis change path used to be verified only by simulation).
 *  resetBasisCache drops the vocab parse cache too: with the basis cache simply nulled there is
 *  no old value to diff against, so the change-driven drop inside currentBasis() would never
 *  fire — a forced re-read must mean both caches (the TTL-expiry path in production always has
 *  the previous value to compare, so the drop fires there). */
export const __deepreadTestHooks = {
  resetBasisCache: (): void => {
    basisCache = null;
    vocabCache = null;
  },
  currentBasis: (): string => currentBasis(),
};

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
  // 种子裸读守卫（ym168 / ym160 shoumen P1-1）：读路径面=空词表降级不 500（分类退化为
  // 纯规则匹配）；任一文件读失败不入缓存负态，下次读再试（种子部署后自动生效）。
  let seedUnreadable = false;
  let brandsFile: { brands?: Array<{ slug: string; name: string; keywords?: string[] }> } = {};
  let mallsFile: { malls?: Array<{ slug: string; name: string; city?: string; keywords?: string[]; area?: number; openedAt?: string; revenue?: number; footfallTier?: number }> } = {};
  try {
    brandsFile = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as {
      brands?: Array<{ slug: string; name: string; keywords?: string[] }>;
    };
  } catch (err) {
    seedUnreadable = true;
    console.warn(`[editorial] deepread brands seed unreadable (${BRANDS_FILE}):`, err instanceof Error ? err.message : err);
  }
  try {
    mallsFile = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as {
      malls?: Array<{ slug: string; name: string; city?: string; keywords?: string[]; area?: number; openedAt?: string; revenue?: number; footfallTier?: number }>;
    };
  } catch (err) {
    seedUnreadable = true;
    console.warn(`[editorial] deepread malls seed unreadable (${MALLS_FILE}):`, err instanceof Error ? err.message : err);
  }
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
  const built = {
    brands: (brandsFile.brands ?? []).map((b) => ({ slug: b.slug, name: b.name, keywords: withName(b) })),
    malls,
  };
  if (seedUnreadable) return built; // 错误态禁缓存：下次读重试（tenancyByMall 同款负态）
  vocabCache = built;
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
  kind: "brand" | "mall" | "mixed" | "macro" | "plain";
  brands: MatchedEntity[];
  malls: MatchedEntity[];
  macro: string[];
}

/** Digest titles and the overseas category always earn a plain reading (owner rule 6, 2026-10-01):
 *  早报/周报合集 and foreign-subject pieces (Landsec 等) previously fell through owner rule 4's
 *  "no match → no reading" gap, leaving the article with a bare translation and no interpretation. */
const PLAIN_READ_TITLE_RE = /(早报|日报|周报|晚报|月报|速递|合集|盘点)/;
const plainRead = (input: { title: string; category: string | null }): boolean =>
  input.category === "overseas" || PLAIN_READ_TITLE_RE.test(input.title);

/** Owner rule 7 (2026-10-05): the deep read is standard for everything published on/after
 *  2026-10-01 00:00 Beijing — a no-signal article still earns a plain direct reading, and only
 *  older pieces keep rule 4's skip. An article with no date at all stays on the signal rules.
 *  The "at" convention is the pool's own: coalesce(published_at, discovered_at). */
const DEFAULT_READ_FROM_MS = Date.parse("2026-09-30T16:00:00.000Z");
const defaultRead = (at: Date | null): boolean => at != null && at.getTime() >= DEFAULT_READ_FROM_MS;

/** The lowercase haystack entity matching runs on (card fields + a head of the body). */
function matchTextOf(input: { title: string; originalTitle: string | null; summary: string | null; tags: string[]; body: string | null }): string {
  return [input.title, input.originalTitle, input.summary, ...(input.tags ?? []), (input.body ?? "").slice(0, MATCH_BODY_CHARS)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/** Null = nothing to read on (owner rule 4): the article keeps its AI 导读 only — this now only
 *  happens to no-signal articles published before the rule-7 cutoff (or with no date). */
export function classifyArticle(input: {
  title: string;
  originalTitle: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  body: string | null;
  publishedAt: Date | null;
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

  if (hitBrands.size === 0 && hitMalls.size === 0 && macro.length === 0) {
    // Owner rule 6: 海外类目与打包稿保底出直接解读；rule 7: 10月起发布的文章无信号也保底直读，
    // 不落「无匹配即无解读」的空档。
    if (plainRead(input) || defaultRead(input.publishedAt)) return { kind: "plain", brands: [], malls: [], macro: [] };
    return null;
  }
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
  /** Set when the pass never reached the provider (budget exhausted): the sweep stops the whole
   *  round and the row must stay untouched — a budget state is global, not this article's. */
  budgetStopped?: true;
}

/** The input identity a pass actually saw (T08/ym245 + T08A/ym316): stored on every outcome row
 *  so the sweep and the public read can tell a current reading from a stale one. Three layers:
 *  revision (articles.revision — content edits), pubRevision (publications.revision — re-analysis
 *  rewrites of summary/tags that leave the article row untouched), basis (prompt + vocab seeds). */
interface InputIdentity {
  revision: number;
  pubRevision: number;
  basis: string;
}

async function identityOf(articleId: string): Promise<InputIdentity> {
  const [r] = await sql<{ revision: number; pub_revision: number | null }[]>`
    SELECT a.revision, p.revision AS pub_revision
    FROM articles a JOIN publications p ON p.article_id = a.id
    WHERE a.id = ${articleId}`;
  return { revision: r?.revision ?? 0, pubRevision: r?.pub_revision ?? 0, basis: currentBasis() };
}

async function storeRow(
  articleId: string,
  status: "skipped" | "failed",
  reason: string,
  identity?: InputIdentity,
): Promise<void> {
  // skipped keeps its reason in skip_reason; failed keeps the error text in error (audit P3).
  // T08/ym245: every outcome carries its input identity; attempts count per identity (a moved
  // input restarts at 1, the same input climbs toward MAX_ATTEMPTS, then retry_at goes NULL and
  // automatic retries stop). A failure downgrades the row's status but never touches the reading
  // payload columns (kind/angle/interpretation/…) — the old reading survives until a newer
  // success replaces it (AC3), while the row itself stops presenting as a valid ready.
  const id = identity ?? (await identityOf(articleId));
  const [existing] = await sql<{ status: string; input_revision: number | null; pub_revision: number | null; input_hash: string | null; attempts: number }[]>`
    SELECT status, input_revision, pub_revision, input_hash, attempts FROM article_deep_reads WHERE article_id = ${articleId}`;
  const sameInput = existing != null
    && existing.input_revision === id.revision
    && existing.pub_revision === id.pubRevision
    && existing.input_hash === id.basis;
  const attempts = sameInput ? existing.attempts + 1 : 1;
  // Only failed waits (AC2): a skipped row is a permanent no-signal verdict, not a retry — its
  // retry_at stays NULL, so the sweep only revisits it when its input identity actually moves.
  const retryAt = status === "failed" && attempts < MAX_ATTEMPTS
    ? new Date(Date.now() + RETRY_BASE_MINUTES * 2 ** (attempts - 1) * 60_000)
    : null;
  await sql`
    INSERT INTO article_deep_reads (article_id, status, skip_reason, error, input_revision, pub_revision, input_hash, attempts, retry_at, updated_at)
    VALUES (${articleId}, ${status}, ${status === "skipped" ? reason : null}, ${status === "failed" ? reason : null},
            ${id.revision}, ${id.pubRevision}, ${id.basis}, ${attempts}, ${retryAt}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      status = ${status},
      skip_reason = ${status === "skipped" ? reason : null}, error = ${status === "failed" ? reason : null},
      input_revision = ${id.revision}, pub_revision = ${id.pubRevision}, input_hash = ${id.basis},
      attempts = ${attempts}, retry_at = ${retryAt}, updated_at = now()`;
}

/**
 * The reading for one published article. Transient provider trouble records a failed row with a
 * retry_at backoff (T08: the sweep re-picks it after the delay, up to MAX_ATTEMPTS per input
 * identity); an unusable model output is recorded as failed the same way; a budget stop leaves
 * no row at all — that state is global, and the sweep halts the round. A success commits in one
 * transaction under the article row lock with a revision CAS: a revision that moved while the
 * model ran abandons the pass instead of overwriting the newer reading's inputs (AC1).
 */
export async function generateDeepRead(articleId: string): Promise<DeepReadOutcome> {
  const [row] = await sql<{
    title: string;
    original_title: string | null;
    summary: string | null;
    category: string | null;
    tags: string[] | null;
    body_text: string | null;
    at: Date | null;
    revision: number;
    pub_revision: number;
  }[]>`
    SELECT p.title, p.original_title, p.summary, p.category, p.tags, a.body_text,
           coalesce(p.published_at, p.discovered_at) AS at, a.revision, p.revision AS pub_revision
    FROM publications p JOIN articles a ON a.id = p.article_id
    WHERE p.article_id = ${articleId} AND p.visibility = 'public' AND p.eligible`;
  if (!row) return { ok: false, status: "pending", error: "not published" };
  const identity: InputIdentity = { revision: row.revision, pubRevision: row.pub_revision, basis: currentBasis() };

  const input = { title: row.title, originalTitle: row.original_title, summary: row.summary, category: row.category, tags: row.tags ?? [], body: row.body_text, publishedAt: row.at };
  const cls = classifyArticle(input);
  if (!cls) {
    await storeRow(articleId, "skipped", "no_entity_no_macro", identity);
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
    if (cls.macro.length === 0 && !plainRead(input) && !defaultRead(input.publishedAt)) {
      await storeRow(articleId, "skipped", "no_entity_no_macro", identity);
      return { ok: true, status: "skipped" };
    }
    cls.kind = cls.macro.length > 0 ? "macro" : "plain";
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
    if (error instanceof BudgetExceededError) {
      // Global state, not this article's: no row, no attempt count — the sweep halts the round.
      return { ok: false, status: "pending", error: message, budgetStopped: true };
    }
    if (error instanceof ShiftWaitError) {
      // F-2/ym558: a shift-window wait is a fleet condition (free pool empty + circuit window),
      // not this article's fault — no row, no attempt burn (content.ts waiting-branch semantics).
      // Halting the round like budget-stop keeps the backlog riding out the window untouched;
      // letting it fall through to the rejected branch would burn attempts toward MAX_ATTEMPTS
      // and strand the articles (deep read lost until their input identity moves).
      return { ok: false, status: "pending", error: message, budgetStopped: true };
    }
    if (error instanceof ProviderRejectedError || error instanceof ReceiptBusyError || error instanceof ReceiptUnknownError) {
      // Recoverable wait (AC2): a failed row with a retry_at backoff — not a fake terminal skip,
      // and no model swap retry; the receipt's verdict stands.
      await storeRow(articleId, "failed", message, identity);
      return { ok: false, status: "pending", error: message };
    }
    if (error instanceof ModelOutputError) {
      await storeRow(articleId, "failed", message, identity);
      return { ok: false, status: "failed", error: message };
    }
    throw error;
  }

  const interpretation = res.data.interpretation.trim().slice(0, 480);
  const entities = [...cls.brands, ...cls.malls].map((m) => ({ type: m.type, slug: m.slug, name: m.name }));
  // One transaction under the article row lock with a revision CAS (T07/ym240 pattern): a
  // revision that moved while the model ran rolls the whole write back (AC1) — the row keeps its
  // prior state and the next sweep retries on the current inputs.
  const written = await sql.begin(async (tx) => {
    const [cur] = await tx<{ revision: number; pub_revision: number }[]>`
      SELECT a.revision, p.revision AS pub_revision
      FROM articles a JOIN publications p ON p.article_id = a.id
      WHERE a.id = ${articleId} FOR UPDATE OF a, p`;
    if (!cur) return "article missing" as const;
    if (cur.revision !== row.revision || cur.pub_revision !== row.pub_revision) return "stale revision" as const;
    await tx`
      INSERT INTO article_deep_reads (article_id, status, kind, entities, angle, interpretation, model, prompt_version, receipt_id, input_revision, pub_revision, input_hash, attempts, retry_at, updated_at)
      VALUES (${articleId}, 'ready', ${cls.kind}, ${sql.json(entities as never)}, ${res.data.angle}, ${interpretation},
              ${res.model}, ${DEEPREAD_PROMPT_VERSION}, ${res.receiptId}, ${identity.revision}, ${identity.pubRevision}, ${identity.basis}, 0, NULL, now())
      ON CONFLICT (article_id) DO UPDATE SET
        status = 'ready', skip_reason = NULL, error = NULL, kind = ${cls.kind}, entities = ${sql.json(entities as never)},
        angle = ${res.data.angle}, interpretation = ${interpretation}, model = ${res.model},
        prompt_version = ${DEEPREAD_PROMPT_VERSION}, receipt_id = ${res.receiptId},
        input_revision = ${identity.revision}, pub_revision = ${identity.pubRevision}, input_hash = ${identity.basis}, attempts = 0, retry_at = NULL, updated_at = now()`;
    return "written" as const;
  });
  if (written !== "written") return { ok: false, status: "pending", error: written };
  return { ok: true, status: "ready", model: res.model };
}

/**
 * One sweep round (T08/ym245). Candidates, entirely in SQL: articles with no row yet; rows whose
 * input identity no longer matches (content revision moved, or the prompt/vocab basis changed —
 * including legacy NULL rows) once their backoff has expired and under the attempt ceiling; and
 * failed rows due for a retry, or whose input moved again after they hit the ceiling. The LIMIT
 * keeps invalidation bounded: a vocab/prompt change re-reads the backlog a few rows per round,
 * newest articles first, never as one unpaid mass re-run. `scanned` counts rows actually worked
 * (a budget stop counts nothing) so the backfill loop's `scanned === 0` exit can't spin on a
 * global budget stop.
 */
export async function sweepDeepReads(limit = 12): Promise<{ scanned: number; ready: number; skipped: number; failed: number }> {
  const basis = currentBasis();
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id
    FROM publications p
    JOIN articles a ON a.id = p.article_id
    LEFT JOIN article_deep_reads d ON d.article_id = p.article_id
    WHERE p.visibility = 'public' AND p.eligible AND p.title IS NOT NULL
      AND (
        d.article_id IS NULL
        OR (d.status IN ('ready', 'skipped')
            AND (d.input_revision IS DISTINCT FROM a.revision OR d.pub_revision IS DISTINCT FROM p.revision
                 OR d.input_hash IS DISTINCT FROM ${basis})
            AND (d.retry_at IS NULL OR d.retry_at <= now()))
        OR (d.status = 'failed'
            AND ((d.retry_at IS NOT NULL AND d.retry_at <= now() AND d.attempts < ${MAX_ATTEMPTS})
                 OR ((d.input_revision IS DISTINCT FROM a.revision OR d.pub_revision IS DISTINCT FROM p.revision
                      OR d.input_hash IS DISTINCT FROM ${basis})
                     AND (d.retry_at IS NULL OR d.retry_at <= now()))))
      )
    ORDER BY (CASE WHEN d.article_id IS NULL THEN 0 WHEN d.status = 'failed' THEN 1 ELSE 2 END),
             coalesce(p.published_at, p.discovered_at) DESC
    LIMIT ${limit}`;
  const stats = { scanned: 0, ready: 0, skipped: 0, failed: 0 };
  for (const r of rows) {
    if (shutdownSignal.signal.aborted) break;
    let out: DeepReadOutcome;
    try {
      out = await generateDeepRead(r.article_id);
    } catch (error) {
      // One bad article must not kill the round: record it and move on (the next sweep retries it).
      await storeRow(r.article_id, "failed", String(error instanceof Error ? error.message : error).slice(0, 300)).catch(() => {});
      stats.failed += 1;
      stats.scanned += 1;
      continue;
    }
    if (out.budgetStopped) break; // global stop: the round ends, unworked rows count nothing
    stats.scanned += 1;
    if (out.status === "ready") stats.ready += 1;
    else if (out.status === "skipped") stats.skipped += 1;
    // Both failed and pending outcomes sit on a failed row awaiting retry_at — count them as
    // failed so the sweep's numbers match what the table actually holds (audit P3-5).
    else stats.failed += 1;
    // Pace only after a paid call; skips cost nothing.
    if (out.status === "ready" && stats.scanned < rows.length) await new Promise((resolve) => setTimeout(resolve, CALL_PACE_MS));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Read side (the article detail payload)
// ---------------------------------------------------------------------------

export interface SiteDeepReadRow {
  kind: "brand" | "mall" | "mixed" | "macro" | "plain";
  angle: "history" | "analogy" | "direct" | "macro";
  interpretation: string;
  entities: Array<{ type: "brand" | "mall"; name: string }>;
  updatedAt: string;
}

export async function loadDeepReadForSite(articleId: string): Promise<SiteDeepReadRow | null> {
  // Only a reading whose input identity is still current is public (AC3): the article's revision
  // must match and the stored basis (prompt version + vocab seeds) must equal the current one —
  // a legacy NULL identity row reads as a miss (0052's contract), and the item detail payload's
  // AI 导读 stays the visitor's copy until a fresh reading lands.
  const [row] = await sql<{ kind: SiteDeepReadRow["kind"]; angle: SiteDeepReadRow["angle"]; interpretation: string; entities: unknown; updated_at: Date }[]>`
    SELECT d.kind, d.angle, d.interpretation, d.entities, d.updated_at
    FROM article_deep_reads d
    JOIN articles a ON a.id = d.article_id
    JOIN publications p ON p.article_id = d.article_id
    WHERE d.article_id = ${articleId} AND d.status = 'ready'
      AND d.input_revision = a.revision AND d.pub_revision = p.revision AND d.input_hash = ${currentBasis()}`;
  if (!row) return null;
  return {
    kind: row.kind,
    angle: row.angle,
    interpretation: row.interpretation,
    entities: Array.isArray(row.entities) ? (row.entities as SiteDeepReadRow["entities"]) : [],
    updatedAt: row.updated_at.toISOString(),
  };
}
