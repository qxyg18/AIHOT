// First-party leaderboard DTOs (/api/site/leaderboard*). Not a public API.
import type { LeaderboardBoardKey } from "./taxonomy.ts";

/** HIGH 较充分 · MEDIUM 持续积累 · LOW 证据敏感. */
export type LbConfidence = "HIGH" | "MEDIUM" | "LOW";
export type LbSourceStatus = "ranked" | "cross_reference" | "observing" | "reference_only" | "awaiting";

export const LB_SOURCE_STATUS_LABELS: Record<LbSourceStatus, string> = {
  ranked: "参与排名",
  cross_reference: "交叉参考",
  observing: "观察中",
  reference_only: "仅供参考",
  awaiting: "等待成绩",
};

export const LB_CONFIDENCE_LABELS: Record<LbConfidence, string> = {
  HIGH: "较充分",
  MEDIUM: "持续积累",
  LOW: "证据敏感",
};

/** rd4 数据置信级：machine=机器源 > report=研报提取 > seed=人工种子（榜单行/详情页角标）。 */
export type LbSourceTier = "machine" | "report" | "seed";
export const LB_SOURCE_TIER_LABELS: Record<LbSourceTier, string> = {
  machine: "机器源",
  report: "研报提取",
  seed: "人工种子",
};

/** 维度 key → 角标短名（正本=算法 DimensionSpec.name，此处仅供榜单行置信级角标拼装）。 */
export const LB_DIMENSION_LABELS: Record<string, string> = {
  footfall: "客流",
  affinity: "业态亲和",
  revenue: "业绩",
  firststore: "首店快闪",
  media: "声量",
  volume: "声量",
  stores: "规模",
  expansion: "扩张",
};

export interface LbBrand {
  /** Site-relative logo path, or null when only a monogram is available. */
  src: string | null;
  monogram: string;
  /** Raster marks get a light backing plate in dark mode. */
  raster: boolean;
}

export interface LbPrice {
  currency: "CNY" | "USD";
  /** Per million tokens in RMB (converted at the run's rate when the list price is USD). */
  inputCny: number | null;
  outputCny: number | null;
  cachedCny: number | null;
  /** List price in `currency`. */
  input: number | null;
  output: number | null;
  cached: number | null;
  officialUrl: string | null;
  verifiedOn: string | null;
}

export interface LbFx {
  rate: number;
  asOf: string;
  sourceName: string;
}

export interface LbRunInfo {
  id: string;
  methodologyVersion: string;
  generatedAt: string;
  fx: LbFx | null;
}

export interface LbStability {
  from: number;
  to: number;
  fixedFrom: number;
  fixedTo: number;
  scenarios: number;
  sensitive: boolean;
  incomplete: number;
  unavailable: number;
}

export interface LbModelRef {
  slug: string;
  name: string;
  provider: string | null;
  releasedAt: string | null;
  brand: LbBrand;
  /** 行业档案（人工种子概数，公开口径待核实）：品牌=品类/上市/年业绩/门店，商业体=面积/开业/年业绩。 */
  profile: LbProfile | null;
}

export interface LbProfile {
  /** 品牌主营品类 */
  category: string | null;
  /** 上市信息（交易所/代码/年份，文本） */
  listed: string | null;
  /** 年业绩预估（亿元人民币） */
  revenueYi: number | null;
  /** 年业绩口径（财报口径/媒体概数；kb6 命主裁定：预估营收允许上榜，页面带置信标记） */
  revenueBasis: string | null;
  /** 门店规模预估（家） */
  stores: number | null;
  /** 价格带定位（大众/中端/中高端/高端；a20 公开常识概数，仅品牌） */
  priceBand: string | null;
  /** 目标年龄段（如 0-3岁/0-12岁；a20 公开常识概数，仅品牌） */
  ageRange: string | null;
  /** 总部城市（a20 公开常识概数，仅品牌） */
  hq: string | null;
  /** 品牌创立年份（a20 公开常识概数，仅品牌） */
  founded: number | null;
  /** 子品牌矩阵（文本，null=无/不确定；a20 公开常识概数，仅品牌） */
  subBrands: string | null;
  /** 渠道结构概数（加盟为主/直营为主/直营+加盟/电商为主；a20 定性口径，仅品牌） */
  channelMix: string | null;
  /** 商业体面积（万㎡） */
  areaWanSqm: number | null;
  /** 商业体开业年份 */
  openedAt: string | null;
  /** 一句话档案简介（≤50 字，zw14 档案库生成通道）；null=未生成，展示层用档案字段拼兜底句。 */
  intro: string | null;
  /** 商业体类型（购物中心/百货/奥特莱斯/商业街区；a18 公开常识概数） */
  mallType: string | null;
  /** 商业体定位档次（高端/中高端/中端/中低端/低端；a18 公开常识概数） */
  positioning: string | null;
  /** 商业体所属集团（连锁产品线归属，null=独立/未判；a18 公开常识概数） */
  groupCompany: string | null;
  /** 商业体省级行政区（由 city 机械映射；a18） */
  province: string | null;
}

export interface LbBoardTab {
  key: LeaderboardBoardKey;
  name: string;
  href: string;
}

export interface LbBoardMeta {
  key: LeaderboardBoardKey;
  name: string;
  title: string;
  description: string;
  howToRead: string;
  sourceCount: number;
  operatorCount: number;
  modelCount: number;
}

export interface LbBoardEntry {
  rank: number;
  score: number;
  model: LbModelRef;
  sourceCount: number;
  coverage: number;
  confidence: LbConfidence;
  stability: LbStability | null;
  price: LbPrice | null;
  /** weighted v1：有效维度权重占比过低（<0.3），展示在「样本不足」区，不进正式名次。 */
  sampleInsufficient: boolean;
  /** weighted v1：该实体的各维度归一分（透明表）；键=维度 key。 */
  dimensions: Record<string, number | null> | null;
  /** weighted v1：榜模式（"weighted" | "footfall-only"），null=非 weighted 运行的历史数据。 */
  mode: string | null;
  /** rd4：维度 key → 数据置信级（machine/report/seed），null=rd4 之前的历史 run。 */
  dimensionTiers: Record<string, string> | null;
}

export interface LbBoardResponse {
  run: LbRunInfo;
  board: LbBoardMeta;
  tabs: LbBoardTab[];
  entries: LbBoardEntry[];
}

export type LbScoreFormat = "percent" | "fraction" | "number";

export interface LbEvidenceItem {
  sourceKey: string;
  sourceName: string;
  /** The evaluator's mark. */
  brand: LbBrand | null;
  officialUrl: string | null;
  usage: string;
  display: string;
  /** e.g. "两项均分" for LiveBench pairs. */
  displayNote: string | null;
  sourceRank: number | null;
  sourceModelName: string | null;
  configurationLabel: string | null;
  selectionReason: string | null;
  upstreamAt: string | null;
  verifiedAt: string | null;
  measuredAt: string | null;
  carriedForward: boolean;
  components: Array<{ label: string; display: string }>;
  componentsNote: string | null;
  /** rd4：该指标数据的置信级（machine/report/seed），null=历史 run 未落。 */
  tier: LbSourceTier | null;
}

export interface LbEvidenceGroup {
  key: string;
  name: string;
  items: LbEvidenceItem[];
}

export interface LbCategoryResult {
  key: LeaderboardBoardKey;
  name: string;
  rank: number | null;
  score: number | null;
  sourceCount: number;
  onBoard: boolean;
}

export interface LbComparisonRow {
  sourceKey: string;
  sourceName: string;
  officialUrl: string | null;
  mine: string;
  theirs: string;
  weight: number;
}

export interface LbComparison {
  model: LbModelRef;
  rank: number;
  net: number;
  sharedWeight: number;
  sharedCount: number;
  hasPage: boolean;
  rows: LbComparisonRow[];
}

export interface LbModelDetail {
  run: LbRunInfo;
  model: LbModelRef & { contextWindowTokens: number | null };
  price: LbPrice | null;
  overall: { rank: number | null; score: number | null; onBoard: boolean; confidence: LbConfidence | null; stability: LbStability | null };
  categories: LbCategoryResult[];
  metricCount: number;
  evidence: LbEvidenceGroup[];
  unmeasured: Array<{ key: string; name: string }>;
  /** rd4：商场实体维度档案——名次/维度分/维度置信级，null=非商场榜实体或历史 run 未落维度明细。 */
  mallBoard: {
    rank: number;
    score: number | null;
    coverage: number | null;
    mode: string | null;
    dimensions: Record<string, number | null> | null;
    dimensionTiers: Record<string, string> | null;
    unmeasuredDimensions: Array<{ key: string; name: string }>;
  } | null;
  comparisons: LbComparison[];
}

export interface LbSourceSummary {
  key: string;
  name: string;
  operator: string;
  description: string;
  status: LbSourceStatus;
  brand: LbBrand | null;
  budget: number | null;
}

export interface LbSourceGroup {
  key: string;
  name: string;
  blurb: string;
  sources: LbSourceSummary[];
}

export interface LbSourcesResponse {
  run: LbRunInfo;
  rankedCount: number;
  totalCount: number;
  groups: LbSourceGroup[];
}

export interface LbSourceRow {
  sourceRank: number | null;
  sourceModelName: string;
  provider: string | null;
  display: string;
  configurationLabel: string | null;
  modelSlug: string | null;
}

export interface LbSourceDetail {
  run: LbRunInfo;
  source: LbSourceSummary & {
    fullName: string;
    area: string | null;
    group: { key: string; name: string };
    officialUrl: string | null;
    what: string;
    usage: string;
    limits: string;
    license: string;
    attribution: string;
  };
  upstreamAt: string | null;
  syncedAt: string | null;
  collected: boolean;
  /** Only sources whose results are public on the site carry rows. */
  rows: LbSourceRow[];
  /** Rows are agent systems (one per configuration), not one representative per model. */
  systemRows: boolean;
  rowsNote: string | null;
}
