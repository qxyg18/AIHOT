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

/** rd4 数据置信级：machine=机器源 > report=研报提取 > seed=人工种子（榜单行/详情页角标）。
 *  rd8 增 infer=推断填充（缺数条件填充值，成色折价最低档 0.5），披露链与折价链同源。 */
export type LbSourceTier = "machine" | "report" | "seed" | "infer";
export const LB_SOURCE_TIER_LABELS: Record<LbSourceTier, string> = {
  machine: "机器源",
  report: "研报提取",
  seed: "人工种子",
  infer: "推断填充",
};

/** ym132-④：文章信号（entity_signal_drafts approved）的类型与短名——实体页/榜详情页「文章信号」小节。 */
export type LbSignalKind = "openings" | "revenue" | "stores";
export const LB_SIGNAL_KIND_LABELS: Record<LbSignalKind, string> = {
  openings: "新开店数",
  revenue: "业绩数字",
  stores: "门店数",
};

/** ym132-④：一条已审核的文章信号（人工审核位通过后才进入展示面）。 */
export interface LbEntitySignal {
  id: string;
  kind: LbSignalKind;
  value: number;
  unit: string;
  caliber: string | null;
  quote: string;
  articleId: string;
  articleTitle: string | null;
  /** 审核通过时刻（ISO）。 */
  at: string;
}

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

/**
 * rd14：详情页维度得分面板的展示顺序（=各榜 DimensionSpec 权重定稿序，业绩置首）。
 * jsonb 维度分天然按键重排（规模/声量/业绩），面板按此表排序对齐列表页口径；
 * order 未覆盖的历史维度键（如 expansion、v4.6 起的 firststore）尾追渲染，防丢数据。
 */
export const LB_DIMENSION_ORDER: Record<string, readonly string[]> = {
  brand: ["revenue", "stores", "volume"],
  mall: ["revenue", "footfall", "media", "affinity"],
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

/** T01/ym239：本轮 run 的每榜计分依据（有效维度/分母/说明）。历史 run 未落元数据时整体为 null，如实标"历史未知"，不猜本轮。 */
export interface LbRunBoardBasis {
  key: LeaderboardBoardKey;
  /** 本轮实际参与计分的维度 key（按权重定稿序）；null=历史 run 未落元数据。 */
  effectiveDimensions: string[] | null;
  /** 计分分母=本轮有效维度权重之和（与 run registry 权重同源，由实际 activeDims/totalWeight 生成）；null=历史未知。 */
  denominator: number | null;
  /** 计分口径说明（覆盖不足/缺数成色等，由实际计分元数据生成）；null=历史未知。 */
  scoreBasis: string | null;
}

export interface LbRunInfo {
  id: string;
  methodologyVersion: string;
  generatedAt: string;
  fx: LbFx | null;
  /** T01/ym239：每榜本轮有效维度/分母证据（规则页/来源页披露同源）；缺省或 null=历史 run 未落。 */
  boards?: LbRunBoardBasis[] | null;
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
  /** 英文名主名（ym166 落库批：种子 name_en 读时映射；null=未获页面证据，宁缺勿编） */
  nameEn: string | null;
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

/** rd9 子榜：总榜按分层口径切出的带内视图入口（带选择器渲染 + 计数角标）。 */
export interface LbSubBoard {
  key: string;
  name: string;
  /** 选择器短标签（如「中端」「家庭主流」）。 */
  short: string;
  href: string;
  /** 该层实体数（与总榜同展示上限口径）。 */
  count: number;
  /** 命中规则：人工种子档案字段的命中值集合。 */
  values: string[];
  note: string;
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
  /** v4.5：本轮在役维度权重（由 run registry 聚合，键=维度 key、值=0-1）；页面权重条与算法同源。 */
  weights?: Record<string, number>;
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
  /** rd9 子榜：该实体在总榜的名次；总榜视图=null，子榜行=总榜序（名次为带内重排后）。 */
  overallRank: number | null;
  /** v4.5：商业体客流档位原始值（人工种子 1-10 档，10 为最高；机器源接入后仍披露种子档）；品牌榜恒 null。 */
  footfallTier: number | null;
  /** ym132-①：该实体近 90 天站内报道数（与详情页相关报道同窗同闸）；0=无角标。 */
  articleCount: number;
}

export interface LbBoardResponse {
  run: LbRunInfo;
  board: LbBoardMeta;
  tabs: LbBoardTab[];
  entries: LbBoardEntry[];
  /** rd9：当前榜单的分层子榜入口（总榜页与子榜页同列，带选择器渲染）；空数组=该榜无子榜。 */
  subBoards: LbSubBoard[];
  /** rd9：当前视图=子榜时的分层口径；null=总榜视图。 */
  subView: { key: string; name: string; values: string[]; note: string } | null;
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
  /** T01/ym239：本详情当前所属榜（mall=商业体榜，brand=品牌榜）；可选，缺省/null=历史数据未标，不臆断。 */
  currentBoard?: LeaderboardBoardKey | null;
  model: LbModelRef & { contextWindowTokens: number | null };
  price: LbPrice | null;
  overall: { rank: number | null; score: number | null; onBoard: boolean; confidence: LbConfidence | null; stability: LbStability | null };
  categories: LbCategoryResult[];
  metricCount: number;
  evidence: LbEvidenceGroup[];
  unmeasured: Array<{ key: string; name: string }>;
  /** rd4：商场实体维度档案——名次/维度分/维度置信级，null=非商场榜实体或历史 run 未落维度明细。 */
  mallBoard: LbDimensionBoard | null;
  /** rd14：品牌实体维度档案——名次/维度分/维度置信级（业绩/规模/声量三维），null=非品牌榜实体或历史 run 未落维度明细。 */
  brandBoard: LbDimensionBoard | null;
  /** ym82：榜条目直达文章——该实体近 90 天关联文章（article_entities 标注，前 8 篇），空=无标注。 */
  relatedArticles: LbRelatedArticle[];
  /** ym82：该实体关联文章总数（含未列出的）。 */
  relatedArticleCount: number;
  /** ym132-④：已审核文章信号（新到旧）；空=该实体暂无 approved 信号，展示层整块不渲染。 */
  entitySignals: LbEntitySignal[];
  /** v4.5：商业体详情页「已开店童装品牌」——高德入驻图谱试点快照按种子商场名回连的边（needsReview=false）；null=非商场实体。 */
  tenancyBrands: LbTenancyBrand[] | null;
  /** ym152：实体档案页存在性（brand=brand_profiles ready 行；mall=种子商场名录命中，与 entityProfile 同 gate）——详情页入口链接据此渲染，false 不渲染防 404。 */
  entityProfileReady: boolean;
  comparisons: LbComparison[];
}

/** v4.5：入驻图谱披露行（confidence=高德邻近信号强度：strong=150m 坐标邻近，weak=400m）；linked=品牌在品牌榜展示面。 */
export interface LbTenancyBrand {
  slug: string;
  name: string;
  confidence: "strong" | "weak";
  linked: boolean;
}

/** ym82：榜详情页相关报道行（article_entities JOIN articles 的截取）。 */
export interface LbRelatedArticle {
  id: string;
  title: string;
  publishedAt: string | null;
}

/** rd14：实体维度得分面板载荷（品牌三维/商场五维同型，装配=read.ts loadModel 直取榜单行 component_scores+detail）。 */
export interface LbDimensionBoard {
  rank: number;
  score: number | null;
  coverage: number | null;
  mode: string | null;
  dimensions: Record<string, number | null> | null;
  dimensionTiers: Record<string, string> | null;
  unmeasuredDimensions: Array<{ key: string; name: string }>;
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
