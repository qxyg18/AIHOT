// Leaderboard read layer: every leaderboard page reads the latest published run through here.
// Page reads never compute rankings; they only format what the run stored.
import { SITE } from "@aihot/industry/site";
import { LEADERBOARD_PUBLIC_BOARDS, type LeaderboardBoardKey } from "@aihot/contracts/taxonomy";
import type {
  LbBoardEntry,
  LbBoardResponse,
  LbComparison,
  LbConfidence,
  LbEvidenceGroup,
  LbEvidenceItem,
  LbModelDetail,
  LbModelRef,
  LbProfile,
  LbPrice,
  LbRunInfo,
  LbSourceDetail,
  LbSourceRow,
  LbSourcesResponse,
  LbSourceSummary,
  LbStability,
} from "@aihot/contracts/leaderboard";
import { LB_DIMENSION_LABELS } from "@aihot/contracts/leaderboard";
import type { SiteBrandCard } from "@aihot/contracts/site";
import { readFileSync } from "node:fs";
import { sql } from "../db.ts";
import { listApprovedSignals } from "../entitytags/signals.ts";
import { BRANDS_FILE, MALLS_FILE, TENANCY_FILE } from "./directory.ts";
import {
  BOARD_COPY,
  SNAPSHOT_ROWS_LIMIT,
  bandBoardEntries,
  boardEntryLimit,
  formatScore,
  modelBrand,
  profileFieldValue,
  registrySource,
  scoreFormat,
  SOURCE_GROUPS,
  sourceBrand,
  sourceKeyOfUnit,
  subViewByKey,
  subViewHref,
  subViewsOfBoard,
} from "./registry.ts";

interface ModelRow {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  provider_slug: string | null;
  released_at: Date | null;
  context_window_tokens: number | null;
}

interface RankingRow {
  model_id: string;
  rank: number;
  score: number;
  coverage: number | null;
  confidence: string | null;
  metric_count: number | null;
  component_scores: { dimensions?: Record<string, number | null>; mode?: string } | null;
  detail: { stability?: LbStability; sourceCount?: number; operatorCount?: number; sampleInsufficient?: boolean; dimensionNames?: Record<string, string>; dimensionTiers?: Record<string, string> } | null;
}

interface SignalRow {
  score: number;
  modelSlug: string;
  lowerBound: number | null;
  upperBound: number | null;
  configuration: string;
}

interface RegistryEntry {
  family: string;
  weight: number;
  operator: string;
  protocol: string;
  direction: string;
  interval_sd: number | null;
  tier?: string;
}

interface EvidenceMeta {
  unit: string;
  operator: string;
  snapshotId: string;
  verifiedAt: string | null;
  evaluatedAt: string | null;
  publishedAt: string | null;
  configuration: string;
  carriedForward: boolean;
}

interface ComparisonRaw {
  net: number;
  slug: string;
  shared: number;
  directCount: number;
}

interface BoardView {
  key: string;
  entries: Array<RankingRow & { slug: string }>;
  bySlug: Map<string, RankingRow & { slug: string }>;
  registry: Record<string, RegistryEntry>;
  signals: Map<string, Map<string, SignalRow>>;
  comparisons: Record<string, ComparisonRaw[]>;
  sourceCount: number;
  operatorCount: number;
  modelCount: number;
  /** weighted v1：商场榜降级直榜标记（"weighted" | "footfall-only"）。 */
  mode: string | null;
}

interface RunView {
  info: LbRunInfo;
  snapshotIds: string[];
  models: Map<string, ModelRow>;
  modelsById: Map<string, ModelRow>;
  prices: Map<string, LbPrice>;
  boards: Map<string, BoardView>;
  pageSlugs: Set<string>;
  evidence: Record<string, EvidenceMeta>;
  sourceWeights: Map<string, number>;
  budgets: Array<{ key: string; name: string; weight: number }>;
  anchors: string[];
}

export class NoLeaderboardRun extends Error {}

let cached: { view: RunView; checkedAt: number } | null = null;
let loading: Promise<RunView> | null = null;

async function latestRunId(): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM lb_runs WHERE status = 'published' ORDER BY generated_at DESC, created_at DESC LIMIT 1`;
  return row?.id ?? null;
}

/** The latest published run, re-checked at most once a minute. */
export async function runView(): Promise<RunView> {
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached.view;
  loading ??= refreshRunView().finally(() => { loading = null; });
  return loading;
}

async function refreshRunView(): Promise<RunView> {
  const id = await latestRunId();
  if (!id) throw new NoLeaderboardRun("no published leaderboard run");
  if (cached && cached.view.info.id === id) {
    cached.checkedAt = Date.now();
    return cached.view;
  }
  const view = await buildRunView(id);
  cached = { view, checkedAt: Date.now() };
  return view;
}

async function buildRunView(runId: string): Promise<RunView> {
  const [run] = await sql<{ id: string; methodology_version: string; generated_at: Date; source_snapshot_ids: string[]; summary: any }[]>`
    SELECT id, methodology_version, generated_at, source_snapshot_ids, summary FROM lb_runs WHERE id = ${runId}`;
  if (!run) throw new NoLeaderboardRun(runId);
  const summary = run.summary ?? {};
  const consensus = summary.consensus ?? {};
  const fxQuote = summary.fxQuote as { asOf: string; rate: number; sourceName: string } | undefined;
  // T13（ym246）：每榜本轮计分依据投影（T01 契约 LbRunBoardBasis）——新 run 由 computeBoard 的
  // activeDims/totalWeight 落库；历史 run 无 scoreBasis 时三字段 null，消费面如实标「历史未知」不猜本轮。
  const boardsBasis = ((summary.boards ?? []) as Array<{ key: LeaderboardBoardKey; scoreBasis?: { effectiveDimensions: string[]; denominator: number } | null }>).map((b) => {
    const sb = b.scoreBasis ?? null;
    return {
      key: b.key,
      effectiveDimensions: sb?.effectiveDimensions ?? null,
      denominator: sb?.denominator ?? null,
      scoreBasis: sb ? `本轮在役维度：${sb.effectiveDimensions.join("、")}；计分分母=在役权重和 ${sb.denominator}（空转维度已滚出）` : null,
    };
  });
  const info: LbRunInfo = {
    id: run.id,
    methodologyVersion: run.methodology_version,
    generatedAt: run.generated_at.toISOString(),
    fx: fxQuote ? { rate: Number(fxQuote.rate), asOf: fxQuote.asOf, sourceName: fxQuote.sourceName } : null,
    boards: boardsBasis,
  };

  const rankingRows = await sql<Array<RankingRow & { board: string }>>`
    SELECT board, model_id, rank, score, coverage, confidence, metric_count, component_scores, detail FROM lb_rankings WHERE run_id = ${runId} ORDER BY board, rank`;
  const modelIds = [...new Set(rankingRows.map((r) => r.model_id))];
  const modelRows = await sql<ModelRow[]>`
    SELECT id, slug, name, provider, provider_slug, released_at, context_window_tokens FROM lb_models WHERE id = ANY(${modelIds})`;
  const modelsById = new Map(modelRows.map((m) => [m.id, m]));
  const models = new Map(modelRows.map((m) => [m.slug, m]));

  const inputs = new Map<string, any>((consensus.input ?? []).map((i: any) => [i.board, i]));
  const outputs = new Map<string, any>((consensus.boards ?? []).map((b: any) => [b.board, b]));
  const boards = new Map<string, BoardView>();
  for (const [key, input] of inputs) {
    const entries = rankingRows
      .filter((r) => r.board === key)
      .map((r) => ({ ...r, slug: modelsById.get(r.model_id)?.slug ?? "" }))
      .filter((r) => r.slug);
    const registry = (input.registry ?? {}) as Record<string, RegistryEntry>;
    const signals = new Map<string, Map<string, SignalRow>>();
    for (const s of input.signals ?? []) signals.set(s.key, new Map((s.rows as SignalRow[]).map((row) => [row.modelSlug, row])));
    const active = Object.entries(registry).filter(([, r]) => r.weight > 0);
    const output = outputs.get(key) ?? {};
    boards.set(key, {
      key,
      entries,
      bySlug: new Map(entries.map((e) => [e.slug, e])),
      registry,
      signals,
      comparisons: output.comparisons ?? {},
      sourceCount: new Set(active.map(([unit]) => sourceKeyOfUnit(unit))).size,
      operatorCount: new Set(active.map(([, r]) => r.operator)).size,
      modelCount: entries.length,
      mode: (input as { mode?: string }).mode ?? null,
    });
  }

  const pageSlugs = new Set<string>();
  for (const key of LEADERBOARD_PUBLIC_BOARDS) {
    for (const e of boards.get(key)?.entries ?? []) if (e.rank <= boardEntryLimit(key)) pageSlugs.add(e.slug);
  }

  const priceRows = await sql<{ model_id: string; currency: "CNY" | "USD"; input: number | null; output: number | null; cached_input: number | null; source_url: string | null; verified_on: Date | null }[]>`
    SELECT model_id, currency, input, output, cached_input, source_url, verified_on FROM lb_prices WHERE kind = 'official' AND model_id = ANY(${modelIds})`;
  const rate = info.fx?.rate ?? null;
  const toCny = (v: number | null, currency: string) => (v == null ? null : currency === "CNY" ? v : rate ? v * rate : null);
  const prices = new Map<string, LbPrice>(
    priceRows.map((p) => [
      p.model_id,
      {
        currency: p.currency,
        input: p.input,
        output: p.output,
        cached: p.cached_input,
        inputCny: toCny(p.input, p.currency),
        outputCny: toCny(p.output, p.currency),
        cachedCny: toCny(p.cached_input, p.currency),
        officialUrl: p.source_url,
        verifiedOn: p.verified_on ? p.verified_on.toISOString().slice(0, 10) : null,
      },
    ]),
  );

  const sourceWeights = new Map<string, number>();
  for (const s of summary.sources ?? []) sourceWeights.set(s.key, Number(s.weight));

  return {
    info,
    snapshotIds: run.source_snapshot_ids ?? [],
    models,
    modelsById,
    prices,
    boards,
    pageSlugs,
    evidence: consensus.evidence ?? {},
    sourceWeights,
    budgets: summary.budgets ?? [],
    anchors: inputs.get("overall")?.anchors ?? [],
  };
}

/** Clears the in-memory run so the next read reloads (after a new run is published). */
export function invalidateLeaderboard() {
  cached = null;
  profileCache = null;
  brandCardsCache = null;
  mallSeedCache = null; // ym152 审计 P3 销项：MALLS_FILE 热更时 mall 入口 gate 不钉死首读
}

function confidenceOf(entry: RankingRow): LbConfidence {
  // Reproduces the published labels: sensitive rankings are low confidence; otherwise broad coverage is high.
  if (entry.detail?.stability?.sensitive) return "LOW";
  return (entry.coverage ?? 0) >= 0.7 ? "HIGH" : "MEDIUM";
}

// ym152：实体档案页存在性——与 entityProfile 同 gate（brand=brand_profiles ready 行；mall=种子商场名录命中），
// 品牌详情页据此渲染实体档案入口链接，缺档不渲染防 404。mall 名录与 entityProfile 同读 MALLS_FILE。
let mallSeedCache: Set<string> | null = null;
function mallSeedSlugs(): Set<string> {
  if (mallSeedCache) return mallSeedCache;
  let malls: { malls?: Array<{ slug: string }> };
  try {
    malls = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls?: Array<{ slug: string }> };
  } catch (err) {
    // ym160：种子缺失不入缓存负态（对齐 tenancyByMall）——下次读再试，空集=实体档案入口不渲染降级；warn 可观测。
    console.warn(`[leaderboard] mall seed unreadable (${MALLS_FILE}):`, err instanceof Error ? err.message : err);
    return new Set();
  }
  mallSeedCache = new Set((malls.malls ?? []).map((m) => m.slug));
  return mallSeedCache;
}
async function entityPageReady(type: "brand" | "mall", slug: string): Promise<boolean> {
  if (type === "mall") return mallSeedSlugs().has(slug);
  const [row] = await sql`SELECT 1 AS ok FROM brand_profiles WHERE slug = ${slug} AND status = 'ready' LIMIT 1`;
  return !!row;
}

// 人工种子档案（品类/上市/业绩/门店/面积/开业），种子文件为 SSOT，运行时按 slug 映射；改种子后重启生效。
let profileCache: Map<string, LbProfile> | null = null;
function seedProfiles(): Map<string, LbProfile> {
  if (profileCache) return profileCache;
  const map = new Map<string, LbProfile>();
  // 种子裸读守卫（ym168 / ym160 shoumen P1-1）：读路径面=坏文件跳过不 500（profile 消费侧
  // 本就 ?? null 兼容缺档）；一文件损坏不拖垮另一文件；错误态不入缓存负态，下次读再试。
  let seedUnreadable = false;
  for (const file of [BRANDS_FILE, MALLS_FILE]) {
    let dir: {
      brands?: Array<{ slug: string; name_en?: string; category?: string; listed?: string; revenue?: number; revenueBasis?: string; stores?: number; intro?: string; priceBand?: string; ageRange?: string; hq?: string; founded?: number; subBrands?: string; channelMix?: string }>;
      malls?: Array<{ slug: string; area?: number; openedAt?: string; revenue?: number; intro?: string; mallType?: string; positioning?: string; groupCompany?: string; province?: string }>;
    };
    try {
      dir = JSON.parse(readFileSync(file, "utf8")) as typeof dir;
    } catch (err) {
      seedUnreadable = true;
      console.warn(`[leaderboard] seed profile file unreadable (${file}):`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const e of dir.brands ?? []) {
      map.set(e.slug, { category: e.category ?? null, nameEn: e.name_en ?? null, listed: e.listed ?? null, revenueYi: e.revenue ?? null, revenueBasis: e.revenueBasis ?? null, stores: e.stores ?? null, priceBand: e.priceBand ?? null, ageRange: e.ageRange ?? null, hq: e.hq ?? null, founded: e.founded ?? null, subBrands: e.subBrands ?? null, channelMix: e.channelMix ?? null, areaWanSqm: null, openedAt: null, intro: e.intro ?? null, mallType: null, positioning: null, groupCompany: null, province: null });
    }
    for (const e of dir.malls ?? []) {
      map.set(e.slug, { category: null, nameEn: null, listed: null, revenueYi: e.revenue ?? null, revenueBasis: null, stores: null, priceBand: null, ageRange: null, hq: null, founded: null, subBrands: null, channelMix: null, areaWanSqm: e.area ?? null, openedAt: e.openedAt ?? null, intro: e.intro ?? null, mallType: e.mallType ?? null, positioning: e.positioning ?? null, groupCompany: e.groupCompany ?? null, province: e.province ?? null });
    }
  }
  if (!seedUnreadable) profileCache = map; // 错误态禁缓存：下次读重试
  return map;
}

// 文章详情品牌简介卡：按标题对品牌名录 keywords 的命中（与声量引擎 mentions 同口径），
// 取名录序前 3 张；只认品牌名录（商场卡不在文章详情展示面）。
let brandCardsCache: Array<SiteBrandCard & { keywords: string[] }> | null = null;
export function brandCardsForText(text: string): SiteBrandCard[] {
  if (!brandCardsCache) {
    // 种子裸读守卫（ym168 / ym160 shoumen P1-1）：读路径面=空集降级不 500（文章详情无品牌卡
    // 可接受）；错误态不入缓存负态，下次读重试。
    let seed: { brands?: Array<{ slug: string; name: string; provider?: string; keywords?: string[] }> };
    try {
      seed = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as {
        brands?: Array<{ slug: string; name: string; provider?: string; keywords?: string[] }>;
      };
    } catch (err) {
      console.warn(`[leaderboard] brand seed unreadable (${BRANDS_FILE}):`, err instanceof Error ? err.message : err);
      return [];
    }
    brandCardsCache = (seed.brands ?? []).map((b) => ({
      slug: b.slug,
      name: b.name,
      provider: b.provider ?? null,
      profile: seedProfiles().get(b.slug) ?? null,
      keywords: b.keywords?.length ? b.keywords : [b.name],
    }));
  }
  const lower = text.toLowerCase();
  return brandCardsCache
    .filter((b) => b.keywords.some((k) => lower.includes(k.toLowerCase())))
    .slice(0, 3)
    .map(({ keywords: _keywords, ...card }) => card);
}

// v4.5（2026-10-02 命主令「已开店品牌上详情页」）：高德 POI 入驻图谱试点快照。mallKind="seed" 的边按
// 种子商场名回连 slug；needsReview=false 才披露（人工复核未过不展示）。缺文件/解析失败=空图谱，详情页区块静默关闭。
interface TenancyEdge {
  brandSlug: string;
  brand: string;
  mallName: string;
  mallKind: string;
  confidence: "strong" | "weak";
  needsReview: boolean;
}

interface TenancyBrand { slug: string; name: string; confidence: "strong" | "weak" }

let tenancyCache: Map<string, TenancyBrand[]> | null = null;
function tenancyByMall(): Map<string, TenancyBrand[]> {
  if (tenancyCache) return tenancyCache;
  const map = new Map<string, TenancyBrand[]>();
  try {
    const edges = JSON.parse(readFileSync(TENANCY_FILE, "utf8")) as TenancyEdge[];
    const dir = JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls?: Array<{ slug: string; name: string }> };
    const slugOfName = new Map((dir.malls ?? []).map((m) => [m.name, m.slug]));
    for (const e of edges) {
      if (e.needsReview || e.mallKind !== "seed") continue;
      const mallSlug = slugOfName.get(e.mallName);
      if (!mallSlug) continue;
      const list = map.get(mallSlug) ?? [];
      if (!list.some((t) => t.slug === e.brandSlug)) list.push({ slug: e.brandSlug, name: e.brand, confidence: e.confidence });
      map.set(mallSlug, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.confidence === b.confidence ? a.slug.localeCompare(b.slug) : a.confidence === "strong" ? -1 : 1));
  } catch (err) {
    // 图谱缺失不入缓存负态：下次读再试（种子文件部署后自动生效）；损坏可观测，防静默数据面消失。
    console.warn(`[leaderboard] tenancy graph unreadable (${TENANCY_FILE}):`, err instanceof Error ? err.message : err);
    return map;
  }
  tenancyCache = map;
  return map;
}

function modelRef(view: RunView, m: ModelRow): LbModelRef {  return {
    slug: m.slug,
    name: m.name,
    provider: m.provider === "其他" ? null : m.provider,
    releasedAt: m.released_at ? m.released_at.toISOString().slice(0, 10) : null,
    brand: modelBrand(m.slug, m.provider_slug, m.provider, m.name),
    profile: seedProfiles().get(m.slug) ?? null,
  };
}

function boardTabs() {
  return LEADERBOARD_PUBLIC_BOARDS.map((key) => ({
    key,
    name: BOARD_COPY[key].name,
    href: key === "brand" ? "/leaderboard" : `/leaderboard/category/${key}`,
  }));
}

// rd13 展示过滤判定：标准档精确匹配优先（rd11 类目标准化），关键词兜底（词含「运动」判运动童装，词含「童鞋/学步鞋」判童鞋）。
function categoryMatchesMainLine(category: string | null | undefined, mainLine: string): boolean {
  if (!category) return false;
  if (category === mainLine) return true;
  if (mainLine === "运动童装") return category.includes("运动");
  if (mainLine === "童鞋") return category.includes("童鞋") || category.includes("学步鞋");
  return false;
}

/**
 * 榜单读取。subKey=rd9 子榜（分层视图）：按人工种子档案字段切层，层内按总榜分数重排名次
 * （rank 1..N，overallRank 保留总榜名次）；分数与计分算法不因分层变化。subKey 不属该榜=null。
 * filter=rd13 展示过滤（仅总榜生效）：hideMainLines 品牌榜主营隐藏档、mallType 商场榜画像类型，幸存行保留原榜名次。
 */
export async function loadBoard(key: LeaderboardBoardKey, subKey: string | null = null, filter: { hideMainLines?: string[]; mallType?: string } = {}): Promise<LbBoardResponse | null> {
  const view = await runView();
  const board = view.boards.get(key);
  if (!board) return null;
  const sub = subKey ? subViewByKey(subKey) : null;
  if (subKey && (!sub || sub.board !== key)) return null;
  const profiles = seedProfiles();
  const displayable = board.entries.filter((e) => e.rank <= boardEntryLimit(key));
  // rd13 榜面截断后过滤：隐藏档实体不占展示位，幸存行 rank 保持原榜名次；子榜带内视图不受过滤影响。
  const hideMainLines = sub || key !== "brand" ? [] : (filter.hideMainLines ?? []);
  const mallType = sub || key !== "mall" ? undefined : filter.mallType;
  const filtered = hideMainLines.length
    ? displayable.filter((e) => {
        const category = profiles.get(e.slug)?.category;
        return !hideMainLines.some((line) => categoryMatchesMainLine(category, line));
      })
    : mallType
      ? displayable.filter((e) => profiles.get(e.slug)?.mallType === mallType)
      : displayable;
  const scoped: Array<{ entry: (typeof filtered)[number]; rank: number; overallRank: number | null }> = sub
    ? bandBoardEntries(displayable, (e) => profileFieldValue(profiles.get(e.slug), sub.field), sub.values)
    : filtered.map((e) => ({ entry: e, rank: e.rank, overallRank: null }));
  // v4.5：客流档位原始值（人工种子 1-10 档）随行披露；品牌榜无此信号恒 null。
  const footfallSignal = board.signals.get("mall-footfall");
  // ym132-①：榜面行内「报道 N 篇」角标——与详情页相关报道同窗同闸（90 天 + 公开可见性，ym99 口径），
  // 一次批聚合按 entity_type 分桶（商场榜→mall，其余→brand，与 loadModel 同映射）。
  const relatedType = key === "mall" ? "mall" : "brand";
  const rowSlugs = scoped.map(({ entry }) => view.modelsById.get(entry.model_id)!.slug);
  const countRows = rowSlugs.length
    ? await sql<{ slug: string; n: number }[]>`
        SELECT e.entity_slug AS slug, count(*)::int AS n
        FROM article_entities e JOIN articles a ON a.id = e.article_id
        JOIN publications p ON p.article_id = a.id
        JOIN sources s ON s.id = p.source_id
        WHERE e.entity_type = ${relatedType} AND e.entity_slug = ANY(${rowSlugs})
          AND p.visibility = 'public' AND s.participation_mode = 'editorial'
          AND coalesce(a.published_at, a.discovered_at) >= now() - interval '90 days'
        GROUP BY e.entity_slug`
    : [];
  const articleCounts = new Map(countRows.map((r) => [r.slug, r.n]));
  const entries: LbBoardEntry[] = scoped.map(({ entry: e, rank, overallRank }) => {
    const m = view.modelsById.get(e.model_id)!;
    return {
      rank,
      overallRank,
      score: e.score,
      model: modelRef(view, m),
      sourceCount: e.detail?.sourceCount ?? e.metric_count ?? 0,
      coverage: e.coverage ?? 0,
      confidence: confidenceOf(e),
      stability: e.detail?.stability ?? null,
      price: view.prices.get(m.id) ?? null,
      sampleInsufficient: e.detail?.sampleInsufficient ?? false,
      dimensions: e.component_scores?.dimensions ?? null,
      mode: e.component_scores?.mode ?? null,
      dimensionTiers: e.detail?.dimensionTiers ?? null,
      footfallTier: footfallSignal?.get(e.slug)?.score ?? null,
      articleCount: articleCounts.get(e.slug) ?? 0,
    };
  });
  const copy = BOARD_COPY[key];
  // v4.5：本轮在役维度权重（run registry 聚合，页面权重条与算法同源——页面写的必须和算法一致）。
  const weights: Record<string, number> = {};
  for (const r of Object.values(board.registry)) {
    if (r.weight <= 0) continue;
    weights[r.family] = Math.round(((weights[r.family] ?? 0) + r.weight) * 1000) / 1000;
  }
  return {
    run: view.info,
    board: {
      ...copy,
      ...(sub ? { name: sub.name, title: sub.title, description: sub.description } : {}),
      sourceCount: board.sourceCount,
      operatorCount: board.operatorCount,
      modelCount: board.modelCount,
      weights,
    },
    tabs: boardTabs(),
    entries,
    subBoards: subViewsOfBoard(key).map((s) => ({
      key: s.key,
      name: s.name,
      short: s.short,
      href: subViewHref(s.key),
      count: bandBoardEntries(displayable, (e) => profileFieldValue(profiles.get(e.slug), s.field), s.values).length,
      values: s.values,
      note: s.note,
    })),
    subView: sub ? { key: sub.key, name: sub.name, values: sub.values, note: sub.note } : null,
  };
}

function signalFormat(unit: string, board: BoardView) {
  const rows = board.signals.get(unit);
  const sample = rows ? rows.values().next().value?.score : null;
  return scoreFormat(sourceKeyOfUnit(unit), sample ?? null);
}

interface ScoreDetailRow {
  snapshot_id: string;
  source_rank: number | null;
  source_model_name: string | null;
  configuration_label: string | null;
  selection_reason: string | null;
  metadata: Record<string, unknown>;
}

function usageLabel(status: string | undefined) {
  if (status === "ranked") return "已计入本轮排名";
  if (status === "cross_reference") return "交叉参考";
  return "仅供参考";
}

export async function loadModel(slug: string): Promise<LbModelDetail | null> {
  const view = await runView();
  if (!view.pageSlugs.has(slug)) return null;
  const m = view.models.get(slug);
  if (!m) return null;
  // 主榜=品牌榜：模型详情页的证据按品牌榜维度组织（实体可能只出现在商场榜，其 overall 为空）。
  const overall = view.boards.get("brand");
  const overallEntry = overall?.bySlug.get(slug) ?? null;

  const categories = LEADERBOARD_PUBLIC_BOARDS.filter((k) => k !== "brand").map((key) => {
    const e = view.boards.get(key)?.bySlug.get(slug);
    return {
      key,
      name: BOARD_COPY[key].name,
      rank: e?.rank ?? null,
      score: e?.score ?? null,
      sourceCount: e?.detail?.sourceCount ?? e?.metric_count ?? 0,
      onBoard: !!e && e.rank <= boardEntryLimit(key),
    };
  });

  // Evidence: every scored unit of the overall board this model has, grouped like the sources page.
  const units = overall ? Object.entries(overall.registry).filter(([unit, r]) => r.weight > 0 && overall.signals.get(unit)?.has(slug)) : [];
  const metas = units.map(([unit]) => view.evidence[`${unit}:${slug}`]).filter((e): e is EvidenceMeta => !!e);
  const details = metas.length
    ? await sql<ScoreDetailRow[]>`
        SELECT snapshot_id, source_rank, source_model_name, configuration_label, selection_reason, metadata
        FROM lb_scores WHERE model_id = ${m.id} AND snapshot_id = ANY(${[...new Set(metas.map((e) => e.snapshotId))]})`
    : [];
  const detailFor = (meta: EvidenceMeta | undefined) =>
    meta ? details.find((d) => d.snapshot_id === meta.snapshotId && d.metadata.configurationIdentity === meta.configuration) ?? null : null;

  const itemsBySource = new Map<string, LbEvidenceItem>();
  for (const [unit, regEntry] of units) {
    const sourceKey = sourceKeyOfUnit(unit);
    const reg = registrySource(sourceKey);
    const signal = overall!.signals.get(unit)!.get(slug)!;
    const meta = view.evidence[`${unit}:${slug}`];
    const detail = detailFor(meta);
    const format = signalFormat(unit, overall!);
    // LiveBench pairs keep their published order ("Language + IF").
    const order = String(detail?.metadata.categories ?? "").split(" + ");
    const components = Object.entries(detail?.metadata ?? {})
      .filter(([k]) => k.startsWith("livebenchCategoryScore:"))
      .map(([k, v]) => ({ label: k.slice("livebenchCategoryScore:".length), display: formatScore(Number(v), "percent") }))
      .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    itemsBySource.set(sourceKey, {
      sourceKey,
      sourceName: reg?.source.name ?? sourceKey,
      brand: reg ? sourceBrand(reg.source) : null,
      officialUrl: reg?.source.officialUrl ?? null,
      usage: usageLabel(reg?.source.status),
      display: formatScore(signal.score, format),
      displayNote: reg?.source.components?.label ?? null,
      sourceRank: detail?.source_rank ?? null,
      sourceModelName: detail?.source_model_name ?? null,
      configurationLabel: detail?.configuration_label ?? null,
      selectionReason: detail?.selection_reason ?? null,
      upstreamAt: meta?.publishedAt ?? null,
      verifiedAt: meta?.verifiedAt ?? null,
      measuredAt: meta?.evaluatedAt ?? null,
      carriedForward: meta?.carriedForward ?? false,
      components,
      componentsNote: components.length ? reg?.source.components?.note ?? null : null,
      tier: (regEntry.tier as LbEvidenceItem["tier"]) ?? null,
    });
  }
  const evidence: LbEvidenceGroup[] = SOURCE_GROUPS.map((g) => ({
    key: g.key,
    name: g.name,
    items: g.sources.map((s) => itemsBySource.get(s.key)).filter((i): i is LbEvidenceItem => !!i),
  })).filter((g) => g.items.length > 0);
  const scoredSources = new Set(overall ? Object.entries(overall.registry).filter(([, r]) => r.weight > 0).map(([u]) => sourceKeyOfUnit(u)) : []);
  const unmeasured = [...scoredSources]
    .filter((k) => !itemsBySource.has(k))
    .map((k) => ({ key: k, name: registrySource(k)?.source.name ?? k }));

  // rd4（shoumen M1 整改）：商场实体详情页维度与置信级披露。商场榜实体在品牌榜视角 overall 为空，
  // 上方证据区按品牌榜维度组织恒空；此处直取商场榜行的维度分与维度置信级，供详情页商场档案区块。
  const mallEntry = view.boards.get("mall")?.bySlug.get(slug) ?? null;
  let mallBoard: LbModelDetail["mallBoard"] = null;
  if (mallEntry) {
    const dimensions = mallEntry.component_scores?.dimensions ?? null;
    const activeFamilies = [...new Set(Object.values(view.boards.get("mall")!.registry).filter((r) => r.weight > 0).map((r) => r.family))];
    // 复审 N1（shoumen PASS带条件）：历史 run 的 dimensionNames 落库为空对象（run.ts 曾把 Map 直进
    // JSON 序列化），fallback 须走契约中文短名，禁英文 key 漏出到页面文案。
    const dimLabel = (k: string) => mallEntry.detail?.dimensionNames?.[k] ?? LB_DIMENSION_LABELS[k] ?? k;
    mallBoard = {
      rank: mallEntry.rank,
      score: mallEntry.score,
      coverage: mallEntry.coverage,
      mode: mallEntry.component_scores?.mode ?? null,
      dimensions,
      dimensionTiers: mallEntry.detail?.dimensionTiers ?? null,
      unmeasuredDimensions: (dimensions ? activeFamilies.filter((f) => dimensions[f] == null) : activeFamilies).map((f) => ({ key: f, name: dimLabel(f) })),
    };
  }

  // rd14（rd12 分句承接）：品牌实体详情页三维得分面板（业绩/规模/声量，对齐商场五维面板）。
  // 直取品牌榜行的维度分与置信级；历史 run 无维度明细时 dimensions=null、未覆盖列=在役维度全列（与 mallBoard 同法）。
  let brandBoard: LbModelDetail["brandBoard"] = null;
  if (overallEntry) {
    const dimensions = overallEntry.component_scores?.dimensions ?? null;
    const activeFamilies = [...new Set(Object.values(overall!.registry).filter((r) => r.weight > 0).map((r) => r.family))];
    const dimLabel = (k: string) => overallEntry.detail?.dimensionNames?.[k] ?? LB_DIMENSION_LABELS[k] ?? k;
    brandBoard = {
      rank: overallEntry.rank,
      score: overallEntry.score,
      coverage: overallEntry.coverage,
      mode: overallEntry.component_scores?.mode ?? null,
      dimensions,
      dimensionTiers: overallEntry.detail?.dimensionTiers ?? null,
      unmeasuredDimensions: (dimensions ? activeFamilies.filter((f) => dimensions[f] == null) : activeFamilies).map((f) => ({ key: f, name: dimLabel(f) })),
    };
  }

  // ym82：榜条目直达文章——实体榜归属定 entity_type（商场榜行→mall，其余→brand；两榜 slug 空间
  // 与 article_entities.entity_slug 同源），直查标注近 90 天关联文章（与声量维同窗口）。
  // ym99（ym95 审计 P2）：两查询补文章页同款可见性闸（publications visibility=public 且
  // sources participation_mode=editorial，与 ym95 六处读取面同口径）——撤文不得经榜详情页
  // 泄漏标题（标注器扫全量 articles，发布→标注→事后撤下正是 ym91 事景类）。
  const relatedType = mallEntry ? "mall" : "brand";
  const relatedArticles = await sql<{ id: string; title: string; publishedAt: string | null }[]>`
    SELECT a.id, a.title, coalesce(a.published_at, a.discovered_at)::text AS "publishedAt"
    FROM article_entities e JOIN articles a ON a.id = e.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e.entity_type = ${relatedType} AND e.entity_slug = ${slug}
      AND p.visibility = 'public' AND s.participation_mode = 'editorial'
      AND coalesce(a.published_at, a.discovered_at) >= now() - interval '90 days'
    ORDER BY coalesce(a.published_at, a.discovered_at) DESC LIMIT 8`;
  const [{ relatedCount }] = await sql<{ relatedCount: string }[]>`
    SELECT count(*)::text AS "relatedCount" FROM article_entities e JOIN articles a ON a.id = e.article_id
    JOIN publications p ON p.article_id = a.id
    JOIN sources s ON s.id = p.source_id
    WHERE e.entity_type = ${relatedType} AND e.entity_slug = ${slug}
      AND p.visibility = 'public' AND s.participation_mode = 'editorial'
      AND coalesce(a.published_at, a.discovered_at) >= now() - interval '90 days'`;
  // ym132-④：已审核文章信号——展示面（详情页/实体页「文章信号」小节）与档案摘要吸收的同源读面。
  const entitySignals = await listApprovedSignals(relatedType, slug, 12);

  // v4.5（2026-10-02 命主令）：商业体详情页「已开店童装品牌」——入驻图谱试点快照回连本商场的边；
  // linked=品牌在品牌榜展示面（可点直达品牌榜详情），其余只列名不链接。
  const tenancyBrands = mallEntry
    ? (tenancyByMall().get(slug) ?? []).map((t) => ({ ...t, linked: view.pageSlugs.has(t.slug) }))
    : null;

  return {
    run: view.info,
    model: { ...modelRef(view, m), contextWindowTokens: m.context_window_tokens },
    price: view.prices.get(m.id) ?? null,
    overall: {
      rank: overallEntry?.rank ?? null,
      score: overallEntry?.score ?? null,
      onBoard: !!overallEntry && overallEntry.rank <= boardEntryLimit("brand"),
      confidence: overallEntry ? confidenceOf(overallEntry) : null,
      stability: overallEntry?.detail?.stability ?? null,
    },
    categories,
    metricCount: itemsBySource.size,
    evidence,
    unmeasured,
    mallBoard,
    brandBoard,
    relatedArticles,
    relatedArticleCount: Number(relatedCount),
    entitySignals,
    tenancyBrands,
    entityProfileReady: await entityPageReady(mallBoard ? "mall" : "brand", slug),
    comparisons: overall && overallEntry ? nearbyComparisons(view, overall, slug, overallEntry.rank) : [],
  };
}

export interface MallInternalSignal {
  key: string;
  label: string;
  /** 最新已发布 run 的原始计数（站内标注口径：提及文章数/共现童装品牌数·v4.8 起去重/事件数）。 */
  score: number;
}

/** ym132-③：商场档案对称通道的站内指标读面——最新已发布 run 的 mall 系内部信号原始计数
 *  （mall-media 站内提及 / mall-affinity 品牌共现 / mall-firststore 首店快闪），零新抓取。
 *  run 不可用（NoLeaderboardRun）时由调用方兜底为空数组，实体页该区静默。 */
export async function mallInternalSignals(slug: string): Promise<MallInternalSignal[]> {
  const view = await runView();
  const board = view.boards.get("mall");
  if (!board) return [];
  const labels: Array<[string, string]> = [
    ["mall-media", "站内声量"],
    ["mall-affinity", "童装业态亲和"],
    ["mall-firststore", "首店快闪动能"],
  ];
  const out: MallInternalSignal[] = [];
  for (const [key, label] of labels) {
    const score = board.signals.get(key)?.get(slug)?.score;
    if (score == null) continue;
    out.push({ key, label, score });
  }
  return out;
}

function nearbyComparisons(view: RunView, board: BoardView, slug: string, rank: number): LbComparison[] {
  const raw = board.comparisons[slug] ?? [];
  const ranked = raw
    .map((c) => ({ c, other: board.bySlug.get(c.slug) }))
    .filter((x): x is { c: ComparisonRaw; other: RankingRow & { slug: string } } => !!x.other)
    .sort((a, b) => Math.abs(a.other.rank - rank) - Math.abs(b.other.rank - rank) || a.other.rank - b.other.rank)
    .slice(0, 5);
  return ranked.map(({ c, other }) => {
    const om = view.modelsById.get(other.model_id)!;
    const rows = Object.entries(board.registry)
      .filter(([unit, r]) => r.weight > 0 && board.signals.get(unit)?.has(slug) && board.signals.get(unit)?.has(c.slug))
      .map(([unit, r]) => {
        const rowsOf = board.signals.get(unit)!;
        const format = signalFormat(unit, board);
        const sourceKey = sourceKeyOfUnit(unit);
        const reg = registrySource(sourceKey);
        return {
          sourceKey,
          sourceName: reg?.source.name ?? sourceKey,
          officialUrl: reg?.source.officialUrl ?? null,
          mine: formatScore(rowsOf.get(slug)!.score, format),
          theirs: formatScore(rowsOf.get(c.slug)!.score, format),
          weight: r.weight,
        };
      });
    const order = new Map(SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => s.key)).map((k, i) => [k, i]));
    rows.sort((a, b) => (order.get(a.sourceKey) ?? 999) - (order.get(b.sourceKey) ?? 999));
    return {
      model: modelRef(view, om),
      rank: other.rank,
      net: c.net,
      sharedWeight: c.shared,
      sharedCount: rows.length,
      hasPage: view.pageSlugs.has(c.slug),
      rows,
    };
  });
}

function sourceSummary(view: RunView, key: string): LbSourceSummary | null {
  const reg = registrySource(key);
  if (!reg) return null;
  const s = reg.source;
  // T13（ym246）：参排态由本轮 run 派生——本轮 run registry 命中（权重>0）即「参与排名」，与算法同源；
  // 登记态 observing/awaiting/awaiting 保留原语义；登记 ranked 但本轮未进 registry 的（如 v4.6 已退出的
  // 首店维）按「仅供参考」显示，不冒充在役。
  const inRun = (view.sourceWeights.get(key) ?? 0) > 0;
  const status = inRun ? "ranked" : s.status === "ranked" ? "reference_only" : s.status;
  return {
    key: s.key,
    name: s.name,
    operator: s.operator,
    description: s.description,
    status,
    brand: sourceBrand(s),
    budget: inRun || s.status === "awaiting" ? view.sourceWeights.get(key) ?? null : null,
  };
}

export async function loadSources(): Promise<LbSourcesResponse> {
  const view = await runView();
  const groups = SOURCE_GROUPS.map((g) => ({
    key: g.key,
    name: g.name,
    blurb: g.blurb,
    sources: g.sources.map((s) => sourceSummary(view, s.key)!),
  }));
  const all = groups.flatMap((g) => g.sources);
  return { run: view.info, rankedCount: all.filter((s) => s.status === "ranked").length, totalCount: all.length, groups };
}

const PUBLIC_ROW_STATUSES = new Set(["ranked", "cross_reference", "reference_only"]);

export async function loadSource(key: string): Promise<LbSourceDetail | null> {
  const reg = registrySource(key);
  if (!reg) return null;
  const view = await runView();
  const summary = sourceSummary(view, key)!;
  const s = reg.source;

  const snapshots = await sql<{ id: string; published_at: Date | null; fetched_at: Date; metadata: Record<string, unknown> }[]>`
    SELECT id, published_at, fetched_at, metadata FROM lb_snapshots WHERE source_key = ${key}
    ORDER BY (id = ANY(${view.snapshotIds})) DESC, fetched_at DESC LIMIT 1`;
  const snapshot = snapshots[0] ?? null;
  const showRows = !!snapshot && PUBLIC_ROW_STATUSES.has(s.status);

  let rows: LbSourceRow[] = [];
  if (showRows) {
    const scoreRows = await sql<{ source_rank: number | null; source_model_name: string | null; raw_score: number | null; configuration_label: string | null; model_id: string; slug: string; name: string; provider: string | null; metadata: Record<string, unknown> }[]>`
      SELECT c.source_rank, c.source_model_name, c.raw_score, c.configuration_label, c.model_id, m.slug, m.name, m.provider, c.metadata
      FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
      WHERE c.snapshot_id = ${snapshot.id} ${s.allRows ? sql`` : sql`AND c.selected_for_product`}
      ORDER BY c.source_rank NULLS LAST, c.raw_score DESC NULLS LAST
      LIMIT ${SNAPSHOT_ROWS_LIMIT}`;
    const sample = scoreRows.find((r) => r.raw_score != null)?.raw_score ?? null;
    const format = scoreFormat(key, sample);
    rows = scoreRows.map((r) => ({
      sourceRank: r.source_rank,
      sourceModelName: r.source_model_name ?? r.name,
      provider: r.provider === "其他" ? null : r.provider,
      display: formatScore(r.raw_score, format),
      configurationLabel: r.configuration_label,
      modelSlug: view.pageSlugs.has(r.slug) ? r.slug : null,
    }));
  }
  const lastSeen = typeof snapshot?.metadata.lastSeenAt === "string" ? snapshot.metadata.lastSeenAt : null;
  return {
    run: view.info,
    source: {
      ...summary,
      fullName: s.fullName ?? s.name,
      area: s.area ?? null,
      group: { key: reg.group.key, name: reg.group.name },
      officialUrl: s.officialUrl,
      what: s.what,
      usage: s.usage,
      limits: s.limits,
      license: s.license,
      attribution: s.attribution ?? `数据由 ${s.operator} 采集登记，原始计数与 ${SITE.name} 加权分使用不同尺度，不能直接相加。`,
    },
    upstreamAt: showRows ? snapshot.published_at?.toISOString() ?? null : null,
    syncedAt: showRows ? lastSeen ?? snapshot.fetched_at.toISOString() : null,
    collected: showRows,
    rows,
    systemRows: !!s.allRows,
    rowsNote: showRows
      ? s.allRows
        ? "下列为按不同运行条件分列的系统记录，条件不同，仅供参考。每项最多展示 30 条。"
        : "按固定规则，每项指标采用一套代表配置，每项最多展示 30 条。"
      : null,
  };
}

export interface LbRulesDimension {
  key: string;
  name: string;
  weight: number;
  sources: string[];
}

export interface LbRulesBoard {
  key: string;
  name: string;
  mode: string | null;
  dimensions: LbRulesDimension[];
  /** rd4：维度 key → 置信级，供 rules 页权重表标注数据成色。 */
  tiers: Record<string, string>;
  /** T13：本轮计分依据（与 run 同源）——null=历史 run 未落元数据，消费面标「历史未知」，静态维度表仅作展示。 */
  basis: { effectiveDimensions: string[]; denominator: number } | null;
}

export interface LbRulesData {
  run: LbRunInfo;
  boards: LbRulesBoard[];
}

/** T13（ym246）：规则页来源的 board 归属过滤（纯函数，导出供测试）。同 familyKey 的维度两榜各有
 *  （如 revenue），来源按 board 归属过滤——brand-revenue 只进品牌榜、mall-revenue 只进商场榜；
 *  更早 run 的 sources 行缺 board 字段时，仅当该 familyKey 不出现在另一榜维度里（无歧义）才收录，
 *  歧义项宁缺勿串。 */
export function runSourcesForBoard(
  sources: Array<{ key: string; familyKey: string; weight: number; board?: string }>,
  selfKey: string,
  otherBoardDimKeys: Set<string>,
): Array<{ key: string; familyKey: string; weight: number; board?: string }> {
  return sources.filter((s) => s.familyKey && s.weight > 0 && (s.board === selfKey || (s.board === undefined && !otherBoardDimKeys.has(s.familyKey))));
}

/** Two-board dimension weight tables for the rules page, straight from the run（页面写的必须和算法一致）. */
export async function loadRulesData(): Promise<LbRulesData> {
  const view = await runView();
  const run = await sql<{ summary: any }[]>`SELECT summary FROM lb_runs WHERE id = ${view.info.id}`;
  const boardDefs = (run[0]?.summary?.boards ?? []) as Array<{
    key: string;
    name: string;
    dimensions: Array<{ key: string; name: string; weight: number }>;
    tiers?: Record<string, string>;
    scoreBasis?: { effectiveDimensions: string[]; denominator: number; dimensions: Array<{ key: string; name: string; weight: number }> } | null;
  }>;
  const sources = (run[0]?.summary?.sources ?? []) as Array<{ key: string; familyKey: string; weight: number; board?: string }>;
  const order = SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => s.key));
  const boards: LbRulesBoard[] = boardDefs.map((b) => {
    const basis = b.scoreBasis?.effectiveDimensions && b.scoreBasis?.denominator != null
      ? { effectiveDimensions: b.scoreBasis.effectiveDimensions, denominator: b.scoreBasis.denominator }
      : null;
    // 本轮实际权重（scoreBasis.dimensions）优先；历史 run 回退静态定义（页面标注历史）。
    const weightOf = new Map((b.scoreBasis?.dimensions ?? []).map((d) => [d.key, d.weight]));
    const otherDimKeys = new Set(boardDefs.filter((bd) => bd.key !== b.key).flatMap((bd) => bd.dimensions.map((d) => d.key)));
    return {
      key: b.key,
      name: b.name,
      mode: view.boards.get(b.key)?.mode ?? null,
      tiers: b.tiers ?? {},
      basis,
      dimensions: b.dimensions.map((d) => ({
        ...d,
        ...(weightOf.has(d.key) ? { weight: weightOf.get(d.key)! } : {}),
        sources: runSourcesForBoard(sources, b.key, otherDimKeys)
          .filter((s) => s.familyKey === d.key)
          .sort((a, c) => order.indexOf(a.key) - order.indexOf(c.key))
          .map((s) => registrySource(s.key)?.source.name ?? s.key),
      })),
    };
  });
  return { run: view.info, boards };
}

/** Public leaderboard URLs for the sitemap. */
export async function leaderboardUrls(): Promise<string[]> {
  try {
    const view = await runView();
    return [
      "/leaderboard",
      ...LEADERBOARD_PUBLIC_BOARDS.filter((k) => k !== "brand").map((k) => `/leaderboard/category/${k}`),
      "/leaderboard/sources",
      "/leaderboard/rules",
      ...SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => `/leaderboard/sources/${s.key}`)),
      ...[...view.pageSlugs].map((slug) => `/leaderboard/${slug}`),
    ];
  } catch {
    return [];
  }
}
