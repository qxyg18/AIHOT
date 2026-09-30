// Weighted-score method v3 (2026-10, rd4 业绩优先+数据置信级): 童装品牌榜 + 全国商业体榜.
// v2 (zw18 权重独立化) → v3 (rd4)：商场榜权重改版（业绩上调声量下调）、维度数据带 source_tier
// 置信级披露、商场榜机器客流源缺席不再降级直榜（seed 档参排）。v15 stays in the tree, unreferenced.
// 命主定稿权重写死在本文件：改任何常量=新方法版本+rules 页同步（架构规矩：页面写的必须和算法一致）。
import { sha256, stableJson } from "../../lib/ids.ts";
import { sql } from "../../db.ts";

export const METHOD_VERSION = "2026.10-weighted-v3";
export const SCORE_DEFINITION = "维度内归一后按命主定稿权重加权求和，分母固定为权重总和（各维度独立计权，缺数维度计 0 贡献不补位不猜测）；覆盖度单独披露；维度数据按来源标注置信级（机器源＞研报提取＞人工种子）";
export const DISPLAY_METHOD = "weighted-score-1.0";
/** Equal final scores order by published score then slug — deterministic and disclosed on the rules page. */
export const TIE_POLICY = "score-then-slug/weighted-1";

/** 窗口内提及类指标低于该值不计分（防小样本噪声），页面标「样本不足」。 */
export const MENTION_MIN = 3;
/** 有效维度权重占比低于该值的实体不入正式榜，展示在「样本不足」区。 */
export const COVERAGE_MIN = 0.3;
/** 提及类信号的统计窗口（天）。 */
export const SIGNAL_WINDOW_DAYS = 30;

export type BoardKind = "brand" | "mall";

export interface DimensionSpec {
  key: string;
  name: string;
  weight: number;
  /** Contributing metric keys; the dimension score is the mean of the per-metric normalised scores. */
  metrics: string[];
  /** Log-compress before min-max (count-style metrics). */
  logScale: boolean;
  /** 商场榜业绩缺数时滚给客流（命主定稿条款）。 */
  rollToOnEmpty?: string;
}

/** Mention-count metrics gated by MENTION_MIN（指数/名录类种子值不卡门槛）。 */
export const MENTION_GATED_METRICS = new Set(["brand-volume", "brand-hotsearch", "brand-expansion", "mall-affinity", "mall-firststore", "mall-media"]);

export const BRAND_DIMENSIONS: DimensionSpec[] = [
  { key: "volume", name: "媒体声量", weight: 0.2, metrics: ["brand-volume", "brand-hotsearch", "brand-social"], logScale: true },
  { key: "revenue", name: "业绩", weight: 0.4, metrics: ["brand-revenue"], logScale: false },
  { key: "stores", name: "规模", weight: 0.3, metrics: ["brand-stores"], logScale: false },
  { key: "expansion", name: "扩张", weight: 0.1, metrics: ["brand-expansion"], logScale: true },
];

export const MALL_DIMENSIONS: DimensionSpec[] = [
  // rd4 权重改版（命主 2026-09-30「热点权重下降业绩提上去+排名置信级」）：甲案在役
  // footfall30/affinity20/revenue30/firststore12/media8；乙案 footfall25/affinity20/revenue35/
  // firststore12/media8 挂决策看板（d-rd4-mall-weight-scheme）候命主，切换=改本数组+重算 --force。
  { key: "footfall", name: "客流规模", weight: 0.3, metrics: ["mall-footfall", "winshang-mall"], logScale: false },
  { key: "affinity", name: "童装业态亲和", weight: 0.2, metrics: ["mall-affinity"], logScale: true },
  { key: "revenue", name: "业绩", weight: 0.3, metrics: ["mall-revenue"], logScale: false, rollToOnEmpty: "footfall" },
  { key: "firststore", name: "首店快闪动能", weight: 0.12, metrics: ["mall-firststore"], logScale: true },
  { key: "media", name: "媒体声量", weight: 0.08, metrics: ["mall-media"], logScale: true },
];

export const BOARDS: Array<{ key: BoardKind; name: string; dimensions: DimensionSpec[]; directorySource: string }> = [
  { key: "brand", name: "童装品牌榜", dimensions: BRAND_DIMENSIONS, directorySource: "entity-directory-brand" },
  { key: "mall", name: "全国商业体榜", dimensions: MALL_DIMENSIONS, directorySource: "entity-directory-mall" },
];

/** Metric → operating source key (manual seeds are a first-party supplement channel, see source-registry). */
export const METRIC_OPERATORS: Record<string, string> = {
  "brand-volume": "internal-signal",
  "brand-expansion": "internal-signal",
  "brand-hotsearch": "dailyhot",
  "brand-social": "manual-supplement",
  "brand-revenue": "manual-supplement",
  "brand-stores": "manual-supplement",
  "mall-footfall": "manual-supplement",
  "mall-affinity": "internal-signal",
  "mall-firststore": "internal-signal",
  "mall-media": "internal-signal",
  "mall-revenue": "manual-supplement",
  "winshang-mall": "winshang-monthly",
};

/** winshang 客流快照出现前，商场榜客流维度由人工种子层级参排（rd4 起 seed 档入加权榜，不再降级直榜）。 */
export const MALL_FOOTFALL_MACHINE_METRICS = new Set(["winshang-mall"]);

/** rd4 数据置信级：machine=机器源自动采集 > report=研报/新闻整理 > seed=人工种子；值随维度分一路透传到榜单行/详情页角标。 */
export type SourceTier = "machine" | "report" | "seed";
export const SOURCE_TIER_RANK: Record<SourceTier, number> = { machine: 3, report: 2, seed: 1 };
/** 指标 → 置信级。两榜每指标单源（快照按 metric key 唯一），指标级映射与值级字段一一对应。 */
export const METRIC_SOURCE_TIER: Record<string, SourceTier> = {
  "brand-volume": "machine",
  "brand-expansion": "machine",
  "brand-hotsearch": "machine",
  "brand-social": "seed",
  "brand-revenue": "report",
  "brand-stores": "seed",
  "mall-footfall": "seed",
  "mall-affinity": "machine",
  "mall-firststore": "machine",
  "mall-media": "machine",
  "mall-revenue": "report",
  "winshang-mall": "machine",
};

export interface SignalRow {
  score: number;
  modelSlug: string;
  lowerBound: number | null;
  upperBound: number | null;
  configuration: string;
}

export interface RegistryEntry {
  family: string;
  weight: number;
  operator: string;
  protocol: string;
  direction: "HIGHER";
  interval_sd: number | null;
  /** rd4 置信级：该指标数据的来源档位（machine/report/seed），随 run 落库供前端角标。 */
  tier: SourceTier;
}

export interface BoardInput {
  board: BoardKind;
  names: Record<string, string>;
  models: string[];
  registry: Record<string, RegistryEntry>;
  signals: Array<{ key: string; rows: SignalRow[] }>;
  /** mall only: "weighted" | "footfall-only"（降级直榜模式判定）。 */
  mode: "weighted" | "footfall-only";
}

export interface BoardEntry {
  slug: string;
  rank: number;
  score: number;
  coverage: number;
  sourceCount: number;
  operatorCount: number;
  sampleInsufficient: boolean;
  dimensions: Record<string, number | null>;
}

export interface BoardOutput {
  board: BoardKind;
  mode: "weighted" | "footfall-only";
  entries: BoardEntry[];
  /** rd4 置信级：维度 key → 该维度在役指标的最高档（machine>report>seed），随 run 落库供角标。 */
  tiers: Record<string, SourceTier>;
}

export interface WeightedInputs {
  at: Date;
  snapshotIds: string[];
  boards: BoardInput[];
  evidence: Record<string, { unit: string; operator: string; snapshotId: string; carriedForward: boolean }>;
}

interface SnapshotRow {
  id: string;
  source_key: string;
  fetched_at: Date;
  metadata: Record<string, unknown>;
}

interface ScoreRow {
  snapshot_id: string;
  metric_key: string;
  slug: string;
  name: string;
  raw_score: number | null;
  metadata: Record<string, unknown>;
}

const METRIC_KEYS = Object.keys(METRIC_OPERATORS);

export function protocolOf(sourceKey: string, meta: Record<string, unknown>): string {
  const tag = meta.seedVersion !== undefined ? `seedVersion=${meta.seedVersion}` : meta.upstreamPublishedAt !== undefined ? `upstream=${meta.upstreamPublishedAt}` : "published-schema";
  return `${sourceKey}:weighted-v1:${tag}`;
}

/** Latest snapshot per metric (snapshots are keyed by metric key — one source per metric in the
 * two-board design); rows join the board pools by lb_models.metadata_source. */
export async function buildWeightedInputs(opts: { at?: Date } = {}): Promise<WeightedInputs> {
  const at = opts.at ?? new Date();
  const snapshots = await sql<SnapshotRow[]>`
    SELECT DISTINCT ON (source_key) id, source_key, fetched_at, metadata FROM lb_snapshots
    WHERE source_key = ANY(${METRIC_KEYS}) AND fetched_at <= ${at}
    ORDER BY source_key, fetched_at DESC`;

  const scoreRows = snapshots.length
    ? await sql<ScoreRow[]>`
        SELECT c.snapshot_id, c.metric_key, m.slug, m.name, c.raw_score, c.metadata
        FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
        WHERE c.snapshot_id = ANY(${snapshots.map((s) => s.id)}) AND c.selected_for_product AND c.raw_score IS NOT NULL`
    : [];

  const pools = await sql<{ slug: string; metadata_source: string | null }[]>`
    SELECT slug, metadata_source FROM lb_models WHERE metadata_source = ANY(${BOARDS.map((b) => b.directorySource)})`;
  const boardOfSlug = new Map<string, BoardKind>();
  for (const p of pools) boardOfSlug.set(p.slug, (BOARDS.find((b) => b.directorySource === p.metadata_source)?.key ?? "brand") as BoardKind);

  // unit → slug → row（快照按 metric key 唯一，行的 metric 与快照天然同键）
  const unitRows = new Map<string, Map<string, SignalRow>>();
  const names = new Map<string, string>();
  const evidence: WeightedInputs["evidence"] = {};
  const snapshotOfMetric = new Map<string, SnapshotRow>();
  for (const r of scoreRows) {
    const board = boardOfSlug.get(r.slug);
    if (!board) continue;
    const operator = METRIC_OPERATORS[r.metric_key];
    if (!operator) continue;
    const snap = snapshots.find((s) => s.id === r.snapshot_id);
    if (!snap) continue;
    snapshotOfMetric.set(r.metric_key, snap);
    if (!unitRows.has(r.metric_key)) unitRows.set(r.metric_key, new Map());
    unitRows.get(r.metric_key)!.set(r.slug, {
      score: r.raw_score!,
      modelSlug: r.slug,
      lowerBound: null,
      upperBound: null,
      configuration: String(r.metadata.configurationIdentity ?? ""),
    });
    names.set(r.slug, r.name);
    evidence[`${r.metric_key}:${r.slug}`] = { unit: r.metric_key, operator, snapshotId: snap.id, carriedForward: false };
  }

  const has = (unit: string) => unitRows.has(unit) && unitRows.get(unit)!.size > 0;
  const boards: BoardInput[] = [];
  for (const b of BOARDS) {
    const activeUnits = b.dimensions.flatMap((d) => d.metrics).filter(has);
    if (!activeUnits.length) continue;

    // rd4（命主 2026-09-30「业绩优先+数据置信级」）：机器客流源缺席不再降级直榜——人工种子层级
    // 以 seed 档参与五维加权（置信级角标披露数据成色）；机器源在场时仍只认机器值、种子退位备查
    // （winshang 或替代机器源接入后自动升档）。
    const footfallMachine = b.dimensions.find((d) => d.key === "footfall");
    let mode: BoardInput["mode"] = "weighted";
    let dims = b.dimensions;
    if (b.key === "mall" && footfallMachine) {
      const machineLive = footfallMachine.metrics.some((m) => MALL_FOOTFALL_MACHINE_METRICS.has(m) && has(m));
      if (machineLive) {
        dims = dims.map((d) => (d.key === "footfall" ? { ...d, metrics: d.metrics.filter((m) => MALL_FOOTFALL_MACHINE_METRICS.has(m)) } : d));
      }
    }
    if (mode === "weighted") {
      // 业绩缺数滚给客流（命主条款）：维度全空且有 rollToOnEmpty 时转移权重。
      const liveKeys = new Set(b.dimensions.filter((d) => d.metrics.some(has)).map((d) => d.key));
      const rolledWeight = new Map<string, number>();
      for (const d of b.dimensions) {
        if (!liveKeys.has(d.key) && d.rollToOnEmpty && liveKeys.has(d.rollToOnEmpty)) {
          rolledWeight.set(d.rollToOnEmpty, (rolledWeight.get(d.rollToOnEmpty) ?? 0) + d.weight);
        }
      }
      if (rolledWeight.size) {
        dims = b.dimensions.map((d) =>
          rolledWeight.has(d.key)
            ? { ...d, weight: d.weight + (rolledWeight.get(d.key) ?? 0) }
            : !liveKeys.has(d.key) && d.rollToOnEmpty
              ? { ...d, weight: 0 }
              : d,
        );
      }
    }

    const registry: Record<string, RegistryEntry> = {};
    for (const d of dims) {
      const live = d.metrics.filter(has);
      if (!live.length || d.weight <= 0) continue;
      for (const u of live) {
        const snap = snapshotOfMetric.get(u);
        registry[u] = {
          family: d.key,
          weight: d.weight / live.length,
          operator: METRIC_OPERATORS[u]!,
          protocol: protocolOf(u, snap?.metadata ?? {}),
          direction: "HIGHER",
          interval_sd: null,
          tier: METRIC_SOURCE_TIER[u] ?? "seed",
        };
      }
    }
    const units = [...new Set(dims.flatMap((d) => (d.weight > 0 ? d.metrics.filter(has) : [])))];
    const models = [...new Set(units.flatMap((u) => [...unitRows.get(u)!.keys()]))].filter((s) => boardOfSlug.get(s) === b.key).sort();
    boards.push({
      board: b.key,
      names: Object.fromEntries(models.map((m) => [m, names.get(m) ?? m])),
      models,
      registry,
      signals: units.map((u) => ({
        key: u,
        rows: [...unitRows.get(u)!.values()].filter((r) => models.includes(r.modelSlug)).sort((a, z) => (a.modelSlug < z.modelSlug ? -1 : 1)),
      })),
      mode,
    });
  }

  return { at, snapshotIds: snapshots.map((s) => s.id), boards, evidence };
}

export function inputFingerprint(inputs: WeightedInputs): string {
  return sha256(stableJson({ method: METHOD_VERSION, boards: inputs.boards.map((b) => ({ board: b.board, mode: b.mode, registry: b.registry, signals: b.signals })) }));
}

function normalise(values: number[], logScale: boolean): number[] {
  const v = logScale ? values.map((x) => Math.log1p(Math.max(0, x))) : values;
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max === min) return v.map(() => (max > 0 ? 100 : 0));
  return v.map((x) => ((x - min) / (max - min)) * 100);
}

/** Dimension scores per entity: mention-gated metrics drop below MENTION_MIN; each metric normalises
 * over the board pool, then the dimension score is the mean of its live metrics. */
export function dimensionScores(board: BoardInput, dims: DimensionSpec[]): Map<string, Map<string, number>> {
  const perDim = new Map<string, Map<string, number>>();
  for (const d of dims) {
    const metricMaps = d.metrics
      .filter((u) => board.registry[u])
      .map((u) => {
        const rows = board.signals.find((s) => s.key === u)?.rows ?? [];
        const gated = MENTION_GATED_METRICS.has(u) ? rows.filter((r) => r.score >= MENTION_MIN) : rows;
        if (!gated.length) return null;
        const norm = normalise(gated.map((r) => r.score), d.logScale);
        const m = new Map<string, number>();
        gated.forEach((r, i) => m.set(r.modelSlug, norm[i]!));
        return m;
      })
      .filter((m): m is Map<string, number> => m !== null);
    if (!metricMaps.length) continue;
    const slugs = [...new Set(metricMaps.flatMap((m) => [...m.keys()]))];
    const dim = new Map<string, number>();
    for (const s of slugs) {
      const vals = metricMaps.map((m) => m.get(s)).filter((v): v is number => v !== undefined);
      if (vals.length) dim.set(s, vals.reduce((a, x) => a + x, 0) / vals.length);
    }
    perDim.set(d.key, dim);
  }
  return perDim;
}

/** The board computation: weighted sum with the fixed total-weight denominator (v2 — missing
 * dimensions contribute zero, no per-entity re-normalisation), coverage, sample-sufficiency
 * flag and the mall footfall-only fallback. */
export function computeBoard(board: BoardInput, dims: DimensionSpec[]): BoardOutput {
  const activeDims = dims.filter((d) => d.weight > 0);
  const perDim = dimensionScores(board, activeDims);
  const totalWeight = activeDims.reduce((a, d) => a + d.weight, 0);
  const candidates = [...new Set(activeDims.flatMap((d) => [...(perDim.get(d.key) ?? new Map<string, number>()).keys()]))];

  let scored: Array<{ slug: string; score: number; coverage: number; dimensions: Record<string, number | null> }>;
  if (board.mode === "footfall-only") {
    const dim = perDim.get("footfall")!;
    scored = candidates.filter((s) => dim.has(s)).map((s) => ({ slug: s, score: dim.get(s)!, coverage: 1, dimensions: { footfall: dim.get(s)! } }));
  } else {
    scored = candidates.map((slug) => {
      const dims_out: Record<string, number | null> = {};
      let sum = 0;
      let liveWeight = 0;
      for (const d of activeDims) {
        const v = perDim.get(d.key)?.get(slug);
        dims_out[d.key] = v ?? null;
        if (v !== undefined) {
          sum += d.weight * v;
          liveWeight += d.weight;
        }
      }
      // v2（命主 2026-09-30 指令「业绩与规模不交叉参考」）：统一以权重总和为分母，
      // 缺数维度计 0 贡献——单维种子实体不再因实体级重归一放大登顶；覆盖度单独披露。
      return { slug, score: sum / totalWeight, coverage: liveWeight / totalWeight, dimensions: dims_out };
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1));
  const withRounded = scored.map((e) => ({ ...e, coverageRounded: Math.round(e.coverage * 100) / 100 }));
  const rankedFirst = withRounded.filter((e) => e.coverageRounded >= COVERAGE_MIN);
  const insufficient = withRounded.filter((e) => e.coverageRounded < COVERAGE_MIN);
  // 正式区名次连续；样本不足实体追加在榜尾（页面单列展示，不进正式名次）。
  const ordered = [...rankedFirst, ...insufficient];
  const operatorCount = new Set(Object.values(board.registry).map((r) => r.operator)).size;
  const sourceCount = Object.keys(board.registry).length;
  // 维度置信级=该维度在役指标（进 registry 者）的最高档；footfall-only 直榜只披露客流维度。
  const tierOf = (d: DimensionSpec): SourceTier | null => {
    const live = d.metrics.filter((u) => board.registry[u]).map((u) => board.registry[u]!.tier);
    return live.length ? live.reduce((a, x) => (SOURCE_TIER_RANK[x] > SOURCE_TIER_RANK[a] ? x : a)) : null;
  };
  let tiers: Record<string, SourceTier>;
  if (board.mode === "footfall-only") {
    const t = tierOf(dims.find((d) => d.key === "footfall")!);
    tiers = t ? { footfall: t } : {};
  } else {
    tiers = Object.fromEntries(activeDims.map((d) => [d.key, tierOf(d)]).filter((p): p is [string, SourceTier] => p[1] != null));
  }
  const entries: BoardEntry[] = ordered.map((e, i) => {
    const coverage = Math.round(e.coverage * 100) / 100;
    return {
      slug: e.slug,
      rank: i + 1,
      score: Math.round(e.score * 10) / 10,
      coverage,
      sourceCount,
      operatorCount,
      sampleInsufficient: coverage < COVERAGE_MIN,
      dimensions: e.dimensions,
    };
  });
  return { board: board.board, mode: board.mode, entries, tiers };
}

export function computeBoards(inputs: WeightedInputs): BoardOutput[] {
  const out: BoardOutput[] = [];
  for (const b of inputs.boards) {
    const spec = BOARDS.find((x) => x.key === b.board)!;
    out.push(computeBoard(b, spec.dimensions));
  }
  return out;
}
