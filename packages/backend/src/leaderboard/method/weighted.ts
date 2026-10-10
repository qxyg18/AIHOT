// Weighted-score method v4 (2026-10, rd8 四版重构): 童装品牌榜 + 全国商业体榜.
// v2 (zw18 权重独立化) → v3 (rd4)：商场榜权重改版、维度数据带 source_tier 置信级披露、机器客流源
// 缺席不再降级直榜（seed 档参排）→ v3.1 (rd7 速赢批)：营收/门店对数化、全榜空转维度权重滚动、
// 声量全文级（90 天）、商场营收值级成色随行披露。v15 stays in the tree, unreferenced.
// v4 (rd8 四版重构) 根治两个机制病（缺数当零分罚/置信级只展示不折价）并唤醒沉睡数据资产：
// ①条件填充（商场缺营收按同客流档、品牌缺营收按同门店量级带取 log 空间中位数；infer 档成色 0.5，
// 高置信真值入场自动覆盖）；②成色折价进分数（machine 1.0/report 0.85/seed 0.7/infer 0.5；
// mall-revenue 值级 annual→report、estimate→seed）；③体量并入客流维（档位归一分×0.6+体量 log
// 分位分×0.4，无体量实体回退档位全额）；④先验亲和分档垫底（mallType×positioning；实测共现覆盖
// 达标后由共现计数接管）；⑤体量类计数指标换百分位名次归一（min-max 的池底恒 0 与极值绑架在分位下消失）。
// 商场榜权重随 v4 落乙案（命主 2026-10-01 09:31 拍板，合并裁决随 v4 切换）。
// v4.1 (ym57 声量靠尾)：被提及门槛剔出声量维且无其他在役维的实体不再整榜除名，改为榜尾追加（门槛与归一池不动）。
// v4.2 (rd12 双榜权重重构，命主 2026-10-01 第 8/9/10/11/13 条定稿)：①删「扩张」维（数据面不再参排）；
// 品牌榜权重改 业绩50/规模30/声量20，商场榜权重改 业绩40/客流25/声量15/亲和12/首店8——业绩第一并置首显示。
// ②营收/门店/商场营收三指标改分层锚点计分（绝对口径，与池内他人无关）：品牌门店 200/600 家→25/50 分、
// 1000 家及以上满值 100（v4.3 裁，见下）；品牌营收 3/5/10/20 亿→25/50/75/100 分、20 亿及以上封顶；商场营收
// 10/30 亿→25/50 分、60 亿及以上满值（命主「按规模值计算权重比例」）。③来源分组按维度拆独立面板（业绩与规模不再合并展示）。
// v4.3 (命主 2026-10-01 18:18 看板 d-rd-store-tier-1000 裁 full-at-1000)：门店断点读法定谳——「1000 家及以上」按满值（恰 1000→100 分，
// 999→1000 为断点跳变）；商场营收 60 亿按同一「断点及以上=满值」读法贯通（恰 60 亿→100）；品牌营收 20 亿锚点本身即满值点，零行为变化。
// v4.4 (ym58 乙案闸，命主 2026-10-01 17:43 看板 d-rd8-area-composite-caliber)：体量复合增覆盖率闸——有体量商场占池比低于
// FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE（50%）时复合整体不启用、客流维全部按档位归一分（两子集在维内可比）；补数达线后自动恢复复合。
// v4.5 (2026-10-02 命主令，两条款)：①并列定序——总分并列时按原始业绩概数高者在前（锚点封顶会让 20 亿与 30 亿
// 同为 100 分，实锚=361°kids 与泰兰尼斯同分 63.5 而种子营收 25.8 vs 30 亿），业绩同或双方均无业绩数据时按 slug 字典序；
// ②商场榜名录全量入池——无任何指标行的实体落在榜尾样本不足区（0 分），不再从榜面消失（品牌榜 ym57 榜尾追加已覆盖）。
// v4.6 (ym112 命主 2026-10-02 定值)：商业体榜 业绩50/客流30/声量10/亲和10、首店快闪维取消（维度整体退出在役，
// 事件词采集面保留不进维度分）；品牌榜 50/30/20 不动。
// v4.8 (ym155 命主 2026-10-03 直令)：业态亲和改品牌数档位计分——每有一个榜内品牌+10 分、满分 100
// （10 个品牌及以上满分，affinityBrandScore 绝对口径与池内他人无关）；数据面单位同步改「共现去重品牌数」
// （internal-signal 品牌并集）；亲和摘 MENTION_MIN 提及门槛（1 个品牌即计 10 分，品牌数是确定性计数）；
// measuredAffinitySlugs 改「有行即实测」，先验垫底退化为 mall-affinity 源整体缺席时的兜底。
// v4.7 (ym153 命主 2026-10-03 直令定稿)：商场营收锚点改六档连续插值——10/20/50/150/200/250 亿→20/40/60/80/90/100 分，
// 下一档最低分=上一档最高分（档间连续无跳变）、档内线性涨至档顶、250 亿及以上满分。口径两转留痕：先拍「按算式字面」
// （60/(50-20)×25=50），命主施工中途插话改定端点连续插值（25 亿=40+20×5/30≈43.33，seq18404）。品牌营收/门店锚点不动。
// 命主定稿权重写死在本文件：改任何常量=新方法版本+rules 页同步（架构规矩：页面写的必须和算法一致）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256, stableJson } from "../../lib/ids.ts";
import { sql } from "../../db.ts";
import { REPO_ROOT } from "../../config.ts";

export const METHOD_VERSION = "2026.10-weighted-v4.8";
export const SCORE_DEFINITION =
  "维度内归一后按命主定稿权重加权求和（营收/门店/商场营收按定稿断点分层锚点绝对计分，其余维度在榜内池归一），分母=本轮在役维度的权重总和（各维度独立计权，实体缺数维度计 0 贡献不补位不猜测；" +
  "全榜空转的维度滚出权重体系、权重按比例摊给其余在役维度——本轮实际在役维度与计分分母随每轮 run 落库披露，页面公示与本算法同源）；缺数维度先做条件填充（同条件组中位数，infer 档折价 0.5，真值入场自动覆盖）；" +
  "维度分按数据成色折价后加权（machine 1.0/report 0.85/seed 0.7/infer 0.5）；覆盖度单独披露；" +
  "维度数据按来源标注置信级（机器源＞研报提取＞人工种子＞推断填充），营收类支持值级成色覆盖";
export const DISPLAY_METHOD = "weighted-score-1.0";
/** v4.5：Equal final scores order by true-value revenue (higher first; infer fills excluded), then slug —
 *  deterministic and disclosed on the rules page. */
export const TIE_POLICY = "score-then-revenue-then-slug/weighted-1";

/** 窗口内提及类指标低于该值不计分（防小样本噪声），页面标「样本不足」。 */
export const MENTION_MIN = 3;
/** 有效维度权重占比低于该值的实体不入正式榜，展示在「样本不足」区。 */
export const COVERAGE_MIN = 0.3;
/** rd7：提及类信号的统计窗口（天）。声量源为 article_entities 全文级实体标注，窗口 30→90 天。 */
export const SIGNAL_WINDOW_DAYS = 90;
/** rd8 体量并入客流维：档位归一分×该占比 + 体量 log 分位分×（1-该占比）；无体量实体回退档位全额。 */
export const FOOTFALL_TIER_SHARE = 0.6;
/** v4.4/ym58 乙案闸（命主 2026-10-01 17:43 裁「先补体量数据、补到覆盖率过半再启用复合，期间有值者回退档位全额」）：
 *  有体量商场占池比低于该值时体量复合不启用、客流维整体回退档位归一分；达线后自动恢复复合，无需二次施工。 */
export const FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE = 0.5;
/** rd8 先验亲和：品牌×商场实测共现覆盖达到该商场数后，先验分档退位、由实测计数接管（v4.8 起实测=有行即接管，
 *  本常量仅留登记不再有消费点；先验只兜底 mall-affinity 源整体缺席）。 */
export const AFFINITY_PRIOR_TAKEOVER_COVERAGE = 100;
/** v4.8（ym155 命主 2026-10-03 直令）：亲和计分=共现童装品牌数×每品牌分值；满分=满分品牌数×每品牌分值。 */
export const AFFINITY_BRAND_SCORE = 10;
export const AFFINITY_FULL_BRANDS = 10;
/** 亲和档位计分（纯函数，可单测直接对拍）：min(品牌数×10, 100)，绝对口径与池内他人无关。 */
export function affinityBrandScore(brands: number): number {
  return Math.min(Math.max(0, brands) * AFFINITY_BRAND_SCORE, AFFINITY_FULL_BRANDS * AFFINITY_BRAND_SCORE);
}

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

/** Mention-count metrics gated by MENTION_MIN（指数/名录类种子值不卡门槛）。rd12：brand-expansion 随扩张维删除。
 *  v4.6（命主 2026-10-02 定值）：mall-firststore 随首店快闪维取消退出在役集合，事件词采集面保留但不再进维度分。
 *  v4.8（ym155）：mall-affinity 随品牌数档位计分摘除——品牌数是确定性计数，1 个品牌即计 10 分，门槛不再适用。 */
export const MENTION_GATED_METRICS = new Set(["brand-volume", "brand-hotsearch", "mall-media"]);

export const BRAND_DIMENSIONS: DimensionSpec[] = [
  // rd12（命主 2026-10-01 第8/11条）：删扩张维；业绩升第一权重 0.5（0.4→0.5），规模 0.3 不变，声量 0.2 不变。
  // 展示顺序=业绩/规模/声量（业绩第一优先级）。营收与门店计分走分层锚点（见 TIER_ANCHORS），logScale 不再参与。
  { key: "revenue", name: "业绩", weight: 0.5, metrics: ["brand-revenue"], logScale: false },
  { key: "stores", name: "规模", weight: 0.3, metrics: ["brand-stores"], logScale: false },
  { key: "volume", name: "媒体声量", weight: 0.2, metrics: ["brand-volume", "brand-hotsearch", "brand-social"], logScale: true },
];

export const MALL_DIMENSIONS: DimensionSpec[] = [
  // v4.6（命主 2026-10-02 定值）：业绩 0.40→0.50 置首，客流 0.25→0.30，声量 0.15→0.10，亲和 0.12→0.10，
  // 首店快闪维取消（整个维度退出在役体系，事件词采集面保留但指标不再进维度分）。比例和=1.0。
  // rd12 历史定稿（命主 2026-10-01 17:29 看板 d-rd-weight-scheme-1001）：业绩 0.35→0.40 置首，客流 0.25 不变，
  // 声量 0.08→0.15 上调，亲和 0.20→0.12、首店 0.12→0.08 下调。机制层承接 rd8 v4（成色折价/条件填充/先验垫底/体量复合）。
  // v4.7（ym153 命主 2026-10-03 定稿）：营收锚点改六档连续插值（10/20/50/150/200/250 亿→20/40/60/80/90/100 分，
  // 250 亿及以上满分，见 TIER_ANCHORS）；权重与维度构成承 v4.6 不变。
  { key: "revenue", name: "业绩", weight: 0.5, metrics: ["mall-revenue"], logScale: false, rollToOnEmpty: "footfall" },
  { key: "footfall", name: "客流规模", weight: 0.3, metrics: ["mall-footfall", "winshang-mall"], logScale: false },
  { key: "media", name: "媒体声量", weight: 0.1, metrics: ["mall-media"], logScale: true },
  // v4.8：亲和=共现童装品牌数×10 分封顶 100（affinityBrandScore 绝对档），不再 log/池内归一。
  { key: "affinity", name: "童装业态亲和", weight: 0.1, metrics: ["mall-affinity"], logScale: false },
];

/** 分层锚点（绝对口径，与池内他人无关：池底恒 0 与极值绑架在定义上消失；锚点值×100 与其余维度同为 0—100 尺度）。
 *  首锚之前从 0 线性升至首锚（同营收「小于3亿线性0~0.25」）；末锚及以上按 fullAbove 语义恒满值 100：
 *  品牌营收 20 亿即满值锚点（连续封顶）；门店 1000 家按命主 2026-10-01 18:18 看板裁定「断点及以上＝满值」
 *  （恰 1000 家→100 分，断点前一档线性最高至 75 分）。
 *  v4.7（ym153 命主 2026-10-03 定稿）：商场营收改六档连续插值——10/20/50/150/200/250 亿→20/40/60/80/90/100 分，
 *  下一档最低分=上一档最高分、档内线性涨至档顶（25 亿=40+20×5/30≈43.33）；250 亿及以上满分。
 *  面积体量（万㎡）不在本表——仍按池内分位分计入客流维复合（mallAdjustments）。
 *  rd8 的百分位名次归一被本表收窄：仅留 percentileRank 服务体量分位（PERCENTILE_METRICS 已随之退役）。 */
export const TIER_ANCHORS: Record<string, { points: Array<[number, number]>; fullAbove: number }> = {
  "brand-revenue": { points: [[0, 0], [3, 0.25], [5, 0.5], [10, 0.75], [20, 1]], fullAbove: 20 },
  "brand-stores": { points: [[0, 0], [200, 0.25], [600, 0.5], [1000, 0.75]], fullAbove: 1000 },
  "mall-revenue": { points: [[0, 0], [10, 0.2], [20, 0.4], [50, 0.6], [150, 0.8], [200, 0.9], [250, 1]], fullAbove: 250 },
};

/** 分层锚点计分（纯函数，可单测直接对拍）：非锚点指标返回 null。 */
export function tierAnchoredScore(metric: string, value: number): number | null {
  const spec = TIER_ANCHORS[metric];
  if (!spec) return null;
  const v = Math.max(0, value);
  if (v >= spec.fullAbove) return 100;
  const points = spec.points;
  let i = 1;
  while (i < points.length - 1 && v > points[i]![0]) i++;
  const [x0, y0] = points[i - 1]!;
  const [x1, y1] = points[i]!;
  return (y0 + ((v - x0) / (x1 - x0)) * (y1 - y0)) * 100;
}

export const BOARDS: Array<{ key: BoardKind; name: string; dimensions: DimensionSpec[]; directorySource: string }> = [
  { key: "brand", name: "童装品牌榜", dimensions: BRAND_DIMENSIONS, directorySource: "entity-directory-brand" },
  { key: "mall", name: "全国商业体榜", dimensions: MALL_DIMENSIONS, directorySource: "entity-directory-mall" },
];

/** Metric → operating source key (manual seeds are a first-party supplement channel, see source-registry). */
export const METRIC_OPERATORS: Record<string, string> = {
  "brand-volume": "internal-signal",
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

/** rd4 数据置信级：machine=机器源自动采集 > report=研报/新闻整理 > seed=人工种子；值随维度分一路透传到榜单行/详情页角标。
 *  rd8 增 infer=推断填充（条件填充值），垫在 seed 之下——披露链（entityTiers/详情页角标）与折价链（SOURCE_TIER_DISCOUNT）同源。 */
export type SourceTier = "machine" | "report" | "seed" | "infer";
export const SOURCE_TIER_RANK: Record<SourceTier, number> = { machine: 3, report: 2, seed: 1, infer: 0 };
/** rd8 成色折价：维度分×该系数后进加权（置信级从「只展示」升级为「进分数」；infer 填充值减半计权）。 */
export const SOURCE_TIER_DISCOUNT: Record<SourceTier, number> = { machine: 1, report: 0.85, seed: 0.7, infer: 0.5 };
/** 指标 → 置信级。两榜每指标单源（快照按 metric key 唯一），指标级映射与值级字段一一对应。 */
export const METRIC_SOURCE_TIER: Record<string, SourceTier> = {
  "brand-volume": "machine",
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
  /** rd7 值级成色：数据行自带的成色档（当前仅 mall-revenue 的 revenueTier：annual→report/estimate→seed），
   *  覆盖指标级 METRIC_SOURCE_TIER 披露到实体行；无值级行缺省 undefined。 */
  tier?: SourceTier;
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

/** rd8 实体事实（商场种子）：体量用于客流复合、类型×定位用于先验亲和、客流档位用于缺营收填充分组；随指纹入哈希。 */
export interface MallFact {
  /** 体量（万㎡）：当前种子 24/419 家有值，其余缺省。 */
  area?: number;
  mallType?: string;
  positioning?: string;
  /** 客流档位（1-10，种子全量有值）：缺营收填充的「同档」分组键。 */
  footfallTier?: number;
}

export interface BoardInput {
  board: BoardKind;
  names: Record<string, string>;
  models: string[];
  registry: Record<string, RegistryEntry>;
  signals: Array<{ key: string; rows: SignalRow[] }>;
  /** mall only: "weighted" | "footfall-only"（降级直榜模式判定）。 */
  mode: "weighted" | "footfall-only";
  /** rd4（shoumen P1-1 整改）：计分用有效维度集（机器源过滤+业绩滚客流后的权重），buildWeightedInputs 产出；缺省回退静态 BOARDS 定义。 */
  dims?: DimensionSpec[];
  /** rd8 实体事实表（商场种子直读）：slug → 体量/类型/定位。改动即入指纹，体量或定位一填即可触发重算。 */
  facts?: Record<string, MallFact>;
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
  /** rd7 值级成色：实体 slug → 维度 → 该实体自身数据行的成色档（在 board tiers 基础上覆盖营收档）；
   *  仅对带值级行的实体存在，其余实体读 tiers。 */
  entityTiers: Record<string, Record<string, SourceTier>>;
  /** T13（ym246）：本轮计分依据元数据——实际参与计分的维度（含滚动后权重）与计分分母（在役权重和）。
   *  由已计算的 activeDims/totalWeight 生成，只披露不改分；消费面=run 落库→read 层 LbRunBoardBasis→规则/来源页。 */
  scoreBasis: {
    /** 按权重定稿序的本轮在役维度（空转/退出维不列）。 */
    dimensions: Array<{ key: string; name: string; weight: number }>;
    /** 计分分母=在役维度权重之和（静态权重和=1.0；空转滚动后<1.0）。 */
    totalWeight: number;
  };
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

/** rd7 值级成色：数据行 metadata.revenueTier（annual=联商年度值→研报提取档；estimate=长图人工估算→人工档），
 *  覆盖指标级 METRIC_SOURCE_TIER 披露到实体行（折价计分归 rd8，本期只标注）。 */
function valueTierOf(meta: Record<string, unknown>): SourceTier | undefined {
  if (meta.revenueTier === "annual") return "report";
  if (meta.revenueTier === "estimate") return "seed";
  return undefined;
}

export function protocolOf(sourceKey: string, meta: Record<string, unknown>): string {
  const tag = meta.seedVersion !== undefined ? `seedVersion=${meta.seedVersion}` : meta.upstreamPublishedAt !== undefined ? `upstream=${meta.upstreamPublishedAt}` : "published-schema";
  return `${sourceKey}:weighted-v1:${tag}`;
}

/** 商场种子（体量/类型/定位）直读：这三项不在 lb_scores 里，只在种子文件维护（a18/ka5 口径）。 */
export const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");

export function loadMallFacts(file: string = MALLS_FILE): Record<string, MallFact> {
  const facts: Record<string, MallFact> = {};
  try {
    const seed = JSON.parse(readFileSync(file, "utf8")) as { malls: Array<{ slug: string; area?: number | null; mallType?: string; positioning?: string; footfallTier?: number }> };
    for (const m of seed.malls) {
      const fact: MallFact = {};
      if (typeof m.area === "number" && m.area > 0) fact.area = m.area;
      if (m.mallType) fact.mallType = m.mallType;
      if (m.positioning) fact.positioning = m.positioning;
      if (typeof m.footfallTier === "number") fact.footfallTier = m.footfallTier;
      if (Object.keys(fact).length) facts[m.slug] = fact;
    }
  } catch (err) {
    // ym160：种子缺失/损坏降级为空对象（体量/类型/定位缺数计零），对齐 read.ts tenancyByMall 守卫；warn 可观测。
    console.warn(`[leaderboard] mall facts seed unreadable (${file}):`, err instanceof Error ? err.message : err);
  }
  return facts;
}

/** rd8 先验亲和分档（命主 2026-10-01 批：购物中心×大众/中端=100、中高端=80、高端=60；百货=50；奥特莱斯/商业街区=40）。
 *  中低端属大众向，按最高档 100（与中端同侧）；未列组合不造先验（返回 null，该实体亲和维保持缺数计零）。
 *  切换位：article_entities 品牌×商场共现覆盖 ≥ AFFINITY_PRIOR_TAKEOVER_COVERAGE 家后，本先验退位、实测共现接管。 */
export function affinityPrior(mallType?: string, positioning?: string): number | null {
  if (mallType === "百货") return 50;
  if (mallType === "奥特莱斯" || mallType === "商业街区") return 40;
  if (mallType === "购物中心") {
    if (positioning === "高端") return 60;
    if (positioning === "中高端") return 80;
    if (positioning === "大众" || positioning === "中端" || positioning === "中低端") return 100;
  }
  return null;
}

/** log 空间中位数（填充与分组统计用）。 */
export function medianLog(values: number[]): number | null {
  if (!values.length) return null;
  const logs = values.map((v) => Math.log1p(Math.max(0, v))).sort((a, b) => a - b);
  const n = logs.length;
  const mid = n % 2 ? logs[(n - 1) / 2]! : (logs[n / 2 - 1]! + logs[n / 2]!) / 2;
  return Math.expm1(mid);
}

/** rd8 门店量级带（log 分位五带，0-4）：品牌缺营收填充的「同量级」分组键。
 *  分位点取全量门店值（含并列）的 log 分位，切点去重防止并列值连跳多带。 */
export function quintileBand(stores: number[], value: number): number {
  const logs = stores.map((s) => Math.log1p(Math.max(0, s))).sort((a, b) => a - b);
  const cuts = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => logs[Math.min(logs.length - 1, Math.floor(q * logs.length))]!))];
  const l = Math.log1p(Math.max(0, value));
  let band = 0;
  while (band < cuts.length && l >= cuts[band]!) band++;
  return band;
}

/** rd8 条件填充（缺数不罚零）：营收缺数实体取同条件组真值中位数（log 空间）作填充值，tier=infer。
 *  商场分组键=客流档位（种子事实，缺事实表时回退 mall-footfall 信号行）；品牌分组键=门店量级带。
 *  同条件组没有任何真值参考时不填充（不凭空造数，保持缺数计零）；门店本身缺数的品牌无法定带，同样不填。
 *  填充值成色系数 0.5（SOURCE_TIER_DISCOUNT）。
 *  「真值入场自动覆盖」是结构性保证：填充只在缺行时生成，快照出现真值行后本函数不再产出该实体。 */
export function fillMissingRevenue(board: BoardInput): number {
  const isMall = board.board === "mall";
  const revenueKey = isMall ? "mall-revenue" : "brand-revenue";
  const anchorKey = isMall ? "mall-footfall" : "brand-stores";
  const revenueRows = board.signals.find((s) => s.key === revenueKey)?.rows ?? [];
  const signalAnchor = new Map((board.signals.find((s) => s.key === anchorKey)?.rows ?? []).map((r) => [r.modelSlug, r.score]));
  const anchorOf = (slug: string): number | undefined => board.facts?.[slug]?.footfallTier ?? signalAnchor.get(slug);
  const anchorValues = board.models.map(anchorOf).filter((v): v is number => v !== undefined);
  if (!anchorValues.length) return 0;
  const actuals = revenueRows.filter((r) => r.score > 0 && anchorOf(r.modelSlug) !== undefined);
  if (!actuals.length) return 0;
  const hasRevenue = new Set(revenueRows.map((r) => r.modelSlug));
  const groupKey = isMall ? (slug: string) => `tier-${Math.round(anchorOf(slug)!)}` : (slug: string) => `band-${quintileBand(anchorValues, anchorOf(slug)!)}`;
  const groupPool = new Map<string, number[]>();
  for (const r of actuals) {
    const key = groupKey(r.modelSlug);
    if (!groupPool.has(key)) groupPool.set(key, []);
    groupPool.get(key)!.push(r.score);
  }
  let filled = 0;
  for (const slug of board.models) {
    if (hasRevenue.has(slug)) continue;
    if (anchorOf(slug) === undefined) continue; // 无分组依据（品牌缺门店）：不填充
    const group = groupPool.get(groupKey(slug));
    if (!group?.length) continue; // 同条件组无真值参考：不填充
    revenueRows.push({ score: medianLog(group)!, modelSlug: slug, lowerBound: null, upperBound: null, configuration: "", tier: "infer" });
    filled++;
  }
  return filled;
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
      tier: valueTierOf(r.metadata),
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
      dims = dims.map((d) =>
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
    // v4.5（2026-10-02 命主令「没有数据的也展示」+shoumen M1 整改）：商场榜名录白名单入池=种子事实
    // 键集（lb-malls 种子 SSOT，当前 419 家全带档位）∪ 信号行实体——无指标行的种子商场落榜尾样本
    // 不足区（0 分），不再从榜面消失；lb_models 库池残留行（同名重复副本/已剔除商场）不上公开榜，
    // 其清理属数据修复、候命主确认。品牌榜维持信号行入池口径（ym57 榜尾追加已全量覆盖）。
    let facts: Record<string, MallFact> | undefined;
    if (b.key === "mall") {
      facts = loadMallFacts();
      for (const s of Object.keys(facts)) if (!models.includes(s)) models.push(s);
      models.sort();
    }
    const boardInput: BoardInput = {
      board: b.key,
      names: Object.fromEntries(models.map((m) => [m, names.get(m) ?? m])),
      models,
      registry,
      signals: units.map((u) => ({
        key: u,
        rows: [...unitRows.get(u)!.values()].filter((r) => models.includes(r.modelSlug)).sort((a, z) => (a.modelSlug < z.modelSlug ? -1 : 1)),
      })),
      mode,
      dims,
    };
    // rd8：商场种子事实（体量/类型/定位/客流档位）挂在商场榜输入上——体量复合与先验亲和的原料，
    // 同时供缺营收填充分组；facts 进指纹（改种子即触发重算）。品牌榜不需要事实表。
    if (b.key === "mall") boardInput.facts = facts;
    // rd8 条件填充（缺数不罚零）：营收缺数实体补同条件组中位数行（tier=infer）。
    fillMissingRevenue(boardInput);
    boards.push(boardInput);
  }

  return { at, snapshotIds: snapshots.map((s) => s.id), boards, evidence };
}

export function inputFingerprint(inputs: WeightedInputs): string {
  // rd8：facts（体量/定位/客流档位）参与计分，必须入指纹——否则种子补一条体量不会触发重算（rd7 判重短路同类坑）。
  return sha256(stableJson({ method: METHOD_VERSION, boards: inputs.boards.map((b) => ({ board: b.board, mode: b.mode, registry: b.registry, signals: b.signals, facts: b.facts })) }));
}

/** rd8 百分位名次归一（并列取平均名次）：0—100 均匀铺开——min-max 的「池底恒 0 + 极值绑架」在此消失；
 *  对数化在分位名下被单调变换吸收（排名不变）。rd12 起只服务商场体量分位（mallAdjustments.areaPct），
 *  营收/门店/商场营收已改分层锚点（TIER_ANCHORS）。 */
export function percentileRank(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const pctOf = new Map<number, number>();
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j++;
    // (小于它的个数 + 并列个数/2) / 池内个数 —— 并列同分同分位，池底不为 0。
    pctOf.set(sorted[i]!, ((i + (j - i + 1) / 2) / n) * 100);
    i = j + 1;
  }
  return values.map((v) => pctOf.get(v)!);
}

/** min-max 归一（提及类与层级类指标）：log1p 压缩可选，池底恒 0 是定义内行为（这类指标计数连续，无缺数问题）。
 *  rd12：营收/门店/商场营收走分层锚点（绝对口径），不再进本函数。 */
function normalise(values: number[], metric: string, logScale: boolean): number[] {
  if (metric === "mall-affinity") return values.map((x) => affinityBrandScore(x));
  if (TIER_ANCHORS[metric]) return values.map((x) => tierAnchoredScore(metric, x)!);
  const v = logScale ? values.map((x) => Math.log1p(Math.max(0, x))) : values;
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max === min) return v.map(() => (max > 0 ? 100 : 0));
  return v.map((x) => ((x - min) / (max - min)) * 100);
}

/** Dimension scores per entity: mention-gated metrics drop below MENTION_MIN; each metric normalises
 * (rd12：营收/门店/商场营收=分层锚点绝对分；其余=榜内池归一), then the dimension score is the mean of its live metrics. */
export function dimensionScores(board: BoardInput, dims: DimensionSpec[]): Map<string, Map<string, number>> {
  const perDim = new Map<string, Map<string, number>>();
  for (const d of dims) {
    const metricMaps = d.metrics
      .filter((u) => board.registry[u])
      .map((u) => {
        const rows = board.signals.find((s) => s.key === u)?.rows ?? [];
        const gated = MENTION_GATED_METRICS.has(u) ? rows.filter((r) => r.score >= MENTION_MIN) : rows;
        if (!gated.length) return null;
        const norm = normalise(gated.map((r) => r.score), u, d.logScale);
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

/** rd8 商场实体级调整原料（纯函数）：
 *  ①体量 log 分位分（areaPct）——仅在种子有体量的实体上计算（当前 24/419）；复合是否应用由 computeBoard
 *  的覆盖率闸（v4.4 FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE）决定，未达线时有体量实体同样回退档位全额；
 *  ②先验亲和分（prior）——mallType×positioning 分档，仅用于实测缺席的实体（垫底），实测在役实体不覆盖。 */
export function mallAdjustments(board: BoardInput): { areaPct: Map<string, number>; prior: Map<string, number> } {
  const areaPct = new Map<string, number>();
  const prior = new Map<string, number>();
  if (board.board !== "mall" || !board.facts) return { areaPct, prior };
  const withArea = board.models.filter((s) => (board.facts![s]?.area ?? 0) > 0);
  const pct = percentileRank(withArea.map((s) => board.facts![s]!.area!));
  withArea.forEach((s, i) => areaPct.set(s, pct[i]!));
  for (const s of board.models) {
    const p = affinityPrior(board.facts[s]?.mallType, board.facts[s]?.positioning);
    if (p != null) prior.set(s, p);
  }
  return { areaPct, prior };
}

/** 实测亲和覆盖（v4.8 起有行即实测——名录内商场零共现也出行 0 分，先验只兜底源整体缺席）。 */
export function measuredAffinitySlugs(board: BoardInput): Set<string> {
  const rows = board.signals.find((s) => s.key === "mall-affinity")?.rows ?? [];
  return new Set(rows.map((r) => r.modelSlug));
}

/** The board computation: weighted sum with the fixed total-weight denominator (v2 — missing
 * dimensions contribute zero, no per-entity re-normalisation), coverage, sample-sufficiency
 * flag and the mall footfall-only fallback. v3.1 adds the board-wide idle-dimension roll.
 * rd8/v4：实体级调整（体量复合+先验垫底）→ 空转判定 → 成色折价进分。 */
export function computeBoard(board: BoardInput, dims: DimensionSpec[]): BoardOutput {
  const weightedDims = dims.filter((d) => d.weight > 0);
  const perDim = dimensionScores(board, weightedDims);
  // rd8 实体级调整先于空转判定：体量与先验让客流/亲和两维在更多实体上有值（先验垫底后亲和维不再全榜空转）。
  const appliedPrior = new Set<string>();
  if (board.mode !== "footfall-only" && board.board === "mall") {
    const { areaPct, prior } = mallAdjustments(board);
    const measured = measuredAffinitySlugs(board);
    // v4.4 覆盖率闸：有体量商场占池比未达线时，有体量与无体量两子集在客流维不可比，复合整体不启用
    // （有体量者同样保持档位归一分）；ym61 补数使覆盖率达 FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE 后自动恢复。
    const areaCoverage = board.models.length ? areaPct.size / board.models.length : 0;
    const footfall = perDim.get("footfall");
    if (footfall && areaCoverage >= FOOTFALL_AREA_COMPOSITE_MIN_COVERAGE) {
      for (const [slug, v] of footfall) {
        const area = areaPct.get(slug);
        if (area !== undefined) footfall.set(slug, v * FOOTFALL_TIER_SHARE + area * (1 - FOOTFALL_TIER_SHARE));
      }
    }
    const affinity = perDim.get("affinity") ?? new Map<string, number>();
    for (const [slug, p] of prior) {
      if (measured.has(slug)) continue;
      affinity.set(slug, p);
      appliedPrior.add(slug);
    }
    if (affinity.size) perDim.set("affinity", affinity);
  }
  // rd7（v3.1 空转维度滚动）：全榜无任何实体得分的维度（提及门槛后为空=标注未覆盖期）滚出权重
  // 体系，totalWeight 随之缩小——等价于其权重按比例摊给其余在役维度。这是「维度级全榜统一缩放」：
  // 每个实体同等受益，不改变实体间相对比较；与 v2 的「实体级缺数计零」（缺数实体让位，改变实体间
  // 公平）性质不同——单实体缺数仍计 0 贡献不补位，本条款只对整个维度全榜无区分力时生效。
  const activeDims = board.mode === "footfall-only" ? weightedDims : weightedDims.filter((d) => (perDim.get(d.key)?.size ?? 0) > 0);
  const totalWeight = activeDims.reduce((a, d) => a + d.weight, 0);
  const candidates = [...new Set(activeDims.flatMap((d) => [...(perDim.get(d.key) ?? new Map<string, number>()).keys()]))];

  // rd8 成色折价：维度置信级先于计分确定（披露链与折价链同源）——实体级覆盖（值级成色/推断填充/先验垫底）
  // 优先于榜级档；折价系数 machine 1.0 / report 0.85 / seed 0.7 / infer 0.5。
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
  // rd7 值级成色 + rd8 推断填充/先验垫底：实体自带行级成色（SignalRow.tier，含填充行 infer）覆盖维度角标；
  // 先验垫底的实体在其亲和维度标 infer；其余实体读 board 级 tiers。
  const entityTiers: Record<string, Record<string, SourceTier>> = {};
  if (board.mode !== "footfall-only") {
    for (const d of activeDims) {
      for (const u of d.metrics) {
        const family = d.key;
        for (const r of board.signals.find((s) => s.key === u)?.rows ?? []) {
          if (!r.tier) continue;
          (entityTiers[r.modelSlug] ??= { ...tiers })[family] = r.tier;
        }
      }
    }
    for (const slug of appliedPrior) (entityTiers[slug] ??= { ...tiers }).affinity = "infer";
  }
  const tierFor = (slug: string, dim: string): SourceTier => entityTiers[slug]?.[dim] ?? tiers[dim] ?? "seed";

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
          // rd8：维度分×成色系数后进加权（置信级从「只展示」升级为「进分数」）；覆盖度按有数维度计，
          // 不因折价缩水——折价只调贡献大小，不改数据完整度。演示的维度分为原始 0—100 归一分（可复算）。
          sum += d.weight * v * SOURCE_TIER_DISCOUNT[tierFor(slug, d.key)];
          liveWeight += d.weight;
        }
      }
      // v2（命主 2026-09-30 指令「业绩与规模不交叉参考」）：统一以权重总和为分母，
      // 缺数维度计 0 贡献——单维种子实体不再因实体级重归一放大登顶；覆盖度单独披露。
      return { slug, score: sum / totalWeight, coverage: liveWeight / totalWeight, dimensions: dims_out };
    });
  }

  // v4.5 并列定序（命主 2026-10-01「同分业绩高者在前」令）：锚点封顶会让原始营收不同的实体同维度分
  // （20 亿与 30 亿都是 100 分），所以并列时回到营收概数真值比较（P1 整改：推断填充行不参与定序——
  // 填充值是条件组中位数概数，参与会「填充压真值」，与「不冒充实测」披露自洽）；真值同或双方均无
  // 业绩数据（null，含仅填充者）时退回 slug 字典序。null 排在有值者之后，不与数值相减（NaN 防护）。
  const revenueKey = board.board === "mall" ? "mall-revenue" : "brand-revenue";
  const revenueRaw = new Map(
    (board.signals.find((s) => s.key === revenueKey)?.rows ?? [])
      .filter((r) => r.tier !== "infer")
      .map((r) => [r.modelSlug, r.score]));
  const byRevenue = (a: number | null, b: number | null): number =>
    a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : b - a;
  scored.sort((a, b) =>
    b.score - a.score ||
    byRevenue(revenueRaw.get(a.slug) ?? null, revenueRaw.get(b.slug) ?? null) ||
    (a.slug < b.slug ? -1 : 1));
  const withRounded = scored.map((e) => ({ ...e, coverageRounded: Math.round(e.coverage * 100) / 100 }));
  const rankedFirst = withRounded.filter((e) => e.coverageRounded >= COVERAGE_MIN);
  const insufficient = withRounded.filter((e) => e.coverageRounded < COVERAGE_MIN);
  // 正式区名次连续；样本不足实体追加在榜尾（页面单列展示，不进正式名次）。
  // ym57（命主 2026-10-01「声量不足的也允许上榜，靠后排序」）：被提及门槛剔出声量维且无其他
  // 在役维的实体此前整榜除名——改为追加榜尾三段区（0 分 / 0 覆盖 / 样本不足），榜面即全量
  // 在册实体；门槛值与归一池不动，正式区与样本不足区名次零漂移。
  const scoredSlugs = new Set(candidates);
  const rest = board.models.filter((s) => !scoredSlugs.has(s));
  const ordered = [...rankedFirst, ...insufficient];
  const operatorCount = new Set(Object.values(board.registry).map((r) => r.operator)).size;
  const sourceCount = Object.keys(board.registry).length;
  const dimensionKeys = activeDims.map((d) => d.key);
  const entries: BoardEntry[] = [
    ...ordered.map((e, i) => {
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
    }),
    ...rest.map((slug, i) => ({
      slug,
      rank: ordered.length + i + 1,
      score: 0,
      coverage: 0,
      sourceCount,
      operatorCount,
      sampleInsufficient: true,
      dimensions: Object.fromEntries(dimensionKeys.map((k) => [k, null])),
    })),
  ];
  // T13：scoreBasis 只读映射已计算的 activeDims/totalWeight——披露物与计分物同一来源，不存在第二套权重口径。
  const scoreBasis = {
    dimensions: activeDims.map((d) => ({ key: d.key, name: d.name, weight: Math.round(d.weight * 1000) / 1000 })),
    totalWeight: Math.round(totalWeight * 1000) / 1000,
  };
  return { board: board.board, mode: board.mode, entries, tiers, entityTiers, scoreBasis };
}

export function computeBoards(inputs: WeightedInputs): BoardOutput[] {
  const out: BoardOutput[] = [];
  for (const b of inputs.boards) {
    const spec = BOARDS.find((x) => x.key === b.board)!;
    // rd4（shoumen P1-1 整改）：计分用 buildWeightedInputs 产出的有效维度集（机器源过滤+业绩滚客流
    // 后的权重）。此前滚动只落 registry/summary 展示层，计分仍用静态定义，公开承诺与实现不符。
    out.push(computeBoard(b, b.dims ?? spec.dimensions));
  }
  return out;
}
