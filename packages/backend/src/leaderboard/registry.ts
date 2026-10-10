// Reader-facing leaderboard vocabulary: evaluation sources, board copy, score formats and brand marks.
// Scoring weights and eligibility never come from here; they come from the computation run.
import type { LeaderboardBoardKey, LeaderboardSubBoardKey } from "@aihot/contracts/taxonomy";
import { LEADERBOARD_SUB_BOARD_KEYS, isLeaderboardSubBoardKey, leaderboardSubBoardPath } from "@aihot/contracts/taxonomy";
import type { LbBrand, LbProfile, LbScoreFormat, LbSourceStatus } from "@aihot/contracts/leaderboard";
import registryData from "./source-registry.json" with { type: "json" };
import { SITE } from "@aihot/industry/site";

export interface RegistrySource {
  key: string;
  status: LbSourceStatus;
  name: string;
  fullName?: string;
  operator: string;
  area?: string;
  description: string;
  logo: string | null;
  officialUrl: string | null;
  what: string;
  usage: string;
  limits: string;
  license: string;
  attribution?: string;
  components?: { note: string; label: string };
  /** Reference sources that keep every system row instead of one representative per model. */
  allRows?: boolean;
}

export interface RegistryGroup {
  key: string;
  name: string;
  blurb: string;
  sources: RegistrySource[];
}

export const SOURCE_GROUPS = registryData.groups as RegistryGroup[];

const byKey = new Map<string, { source: RegistrySource; group: RegistryGroup }>();
for (const group of SOURCE_GROUPS) for (const source of group.sources) byKey.set(source.key, { source, group });

export function registrySource(key: string) {
  return byKey.get(key) ?? null;
}

/** Signal units carry a metric suffix for multi-metric sources ("artificial-analysis:intelligence"). */
export function sourceKeyOfUnit(unit: string): string {
  return unit.split(":")[0]!;
}

export interface BoardCopy {
  key: LeaderboardBoardKey;
  name: string;
  title: string;
  description: string;
  howToRead: string;
}

export const BOARD_COPY: Record<LeaderboardBoardKey, BoardCopy> = {
  brand: {
    key: "brand",
    name: "童装品牌榜",
    title: `${SITE.name} 童装品牌榜`,
    description: "按业绩、规模、媒体声量三个维度，追踪童装品牌的月度综合表现。",
    howToRead: "权重=业绩 50 / 规模 30 / 媒体声量 20（命主 2026-10-01 定稿；扩张维度已取消），各维度独立计权（实体缺数维度计 0 贡献，分母固定为在役权重总和，不交叉补位）并带覆盖度标签；缺营收的品牌按同门店量级带取中位数先填一层「推断填充」值（不罚零、不冒充实测，真值入场自动覆盖）；维度分按数据成色折价后进加权：机器源 ×1.0、研报提取 ×0.85、人工种子 ×0.7、推断填充 ×0.5，成绩上限随成色如实下压；全榜无任何实体得分的维度自动滚出权重体系，其权重按比例摊给其余在役维度（维度级统一缩放，不改变实体间相对比较）；营收与门店按定稿断点分层锚点计分（营收 3/5/10/20 亿→25/50/75/100 分、20 亿及以上封顶；门店 200/600 家→25/50 分、1000 家及以上满值；绝对口径，与同榜其他实体无关）；声量为全文级实体标注统计（90 天窗口）；窗口提及不足 3 篇的维度不计分；覆盖度过低的品牌标「样本不足」；声量低于门槛且无其他在役数据的品牌也保留在榜，列示于榜尾样本不足区（0 分，不计入正式名次）；总分并列的实体按业绩概数真值高者在前（v4.5，锚点封顶后维度分相同而营收真值有别时据此定序；推断填充值不参与定序，仅一方有业绩数据时有数据者在前；业绩真值同或双方均无业绩数据时按名录名排序）。",
  },
  mall: {
    key: "mall",
    name: "全国商业体榜",
    title: `${SITE.name} 全国商业体榜`,
    description: "按业绩、客流规模、媒体声量、童装业态亲和四个维度，追踪全国商业体。",
    howToRead: "权重=业绩 50 / 客流 30 / 媒体声量 10 / 童装业态亲和 10（命主 2026-10-02 定稿；首店快闪维已取消，事件词采集面保留但不再进维度分），各维度独立计权（实体缺数维度计 0 贡献，分母固定为权重总和）；客流维=人工客流档位归一分×0.6 + 体量（万㎡）分位分×0.4 的复合分（复合在体量数据覆盖过半后才启用，未达线时全维度按档位归一分计），无体量数据的商业体回退档位全额；缺营收的商业体按同客流档中位数先填一层「推断填充」值（真值入场自动覆盖）；童装业态亲和=90 天窗口内与该商场同文共现的童装品牌数×10 分封顶 100（命主 2026-10-03 定稿：每有一个榜内品牌+10 分、10 个品牌及以上满分；绝对口径与同榜其他实体无关），亲和缺实测行时由「商场类型×定位」先验分档兜底（推断填充档折价 0.5）；维度分按数据成色折价后进加权：机器源 ×1.0、研报提取 ×0.85、人工种子 ×0.7、推断填充 ×0.5，成绩上限随成色如实下压；营收按命主 2026-10-03 定稿六档连续插值计分（10/20/50/150/200/250 亿→20/40/60/80/90/100 分、250 亿及以上满分，档内线性涨至档顶；绝对口径，与同榜其他实体无关），并按来源分两档角标：联商年度值=研报提取档、项目长图估算=人工档；全榜无任何实体得分的维度自动滚出权重体系，其权重按比例摊给其余在役维度（维度级统一缩放，不改变实体间相对比较）；声量为全文级实体标注统计（90 天窗口）；每个维度按数据来源标注置信级（机器源＞研报提取＞人工种子＞推断填充），榜单行与详情页有角标；客流正源接入前由人工种子层级以种子档参排。业绩维度整体缺数时滚给客流；名录内暂无任何指标数据的商业体也保留在榜（榜尾样本不足区，0 分，不计入正式名次）；总分并列的实体按营收概数真值高者在前（v4.5；推断填充值不参与定序，仅一方有营收数据时有数据者在前；营收真值同或双方均无营收数据时按名录名排序）。",
  },
};

// 榜单实体展示与详情页可见上限（zw13 展示策略）：品牌榜最多 80 名，商业体榜全量可见（防膨胀上限 1000）。
export const BOARD_ENTRY_LIMITS: Record<string, number> = { brand: 80, mall: 1000 };
export function boardEntryLimit(key: string): number {
  return BOARD_ENTRY_LIMITS[key] ?? 80;
}
// 来源页单源快照的配置行上限，与榜实体展示无关，沿用旧 30 档。
export const SNAPSHOT_ROWS_LIMIT = 30;

// rd9 子榜（分层视图）：总榜分数与计分算法不动，按人工种子档案字段把总榜切层，层内按总榜
// 分数重排名次（1..N，overallRank 保留总榜名次）。词表=种子实际用值（商场定位=高端/中高端/
// 中端/中低端，无「大众」档）。商场分层口径由命主 2026-10-01 看板两轮拍板：17:45 d-rd9-mall-
// layer-caliber 乙案（家庭主流=中端+中高端）+ 17:51 d-rd9-mall-lowband-scope 乙案（中低端另立
// 第三层「大众平替榜」）；三层合计=总榜实体数。
export interface BoardSubView {
  key: LeaderboardSubBoardKey;
  board: LeaderboardBoardKey;
  /** 选择器短标签。 */
  short: string;
  name: string;
  title: string;
  description: string;
  note: string;
  /** 命中规则：档案字段 + 命中值集合。 */
  field: "priceBand" | "positioning";
  values: string[];
}

const BRAND_BAND_NOTE =
  "子榜口径：按人工种子档案的价格带（公开常识概数，待核实）分层（档案缺价格带的实体暂不落带）；带内按总榜分数重排名次，共识指数与总榜完全一致，仅名次为带内序。";
const MALL_LAYER_NOTE =
  "子榜口径：按人工种子档案的定位档次（公开常识概数，待核实）分层；层内按总榜分数重排名次，共识指数与总榜完全一致，仅名次为层内序。";

export const BOARD_SUBVIEWS: Record<LeaderboardSubBoardKey, BoardSubView> = {
  "brand-mass": {
    key: "brand-mass",
    board: "brand",
    short: "大众",
    name: "大众价格带榜",
    title: `${SITE.name} 大众价格带童装品牌榜`,
    description: "大众价格带的童装品牌，按总榜口径的带内排名。",
    note: BRAND_BAND_NOTE,
    field: "priceBand",
    values: ["大众"],
  },
  "brand-mid": {
    key: "brand-mid",
    board: "brand",
    short: "中端",
    name: "中端价格带榜",
    title: `${SITE.name} 中端价格带童装品牌榜`,
    description: "中端价格带的童装品牌，按总榜口径的带内排名。",
    note: BRAND_BAND_NOTE,
    field: "priceBand",
    values: ["中端"],
  },
  "brand-uppermid": {
    key: "brand-uppermid",
    board: "brand",
    short: "中高端",
    name: "中高端价格带榜",
    title: `${SITE.name} 中高端价格带童装品牌榜`,
    description: "中高端价格带的童装品牌，按总榜口径的带内排名。",
    note: BRAND_BAND_NOTE,
    field: "priceBand",
    values: ["中高端"],
  },
  "brand-premium": {
    key: "brand-premium",
    board: "brand",
    short: "高端",
    name: "高端价格带榜",
    title: `${SITE.name} 高端价格带童装品牌榜`,
    description: "高端价格带的童装品牌，按总榜口径的带内排名。",
    note: BRAND_BAND_NOTE,
    field: "priceBand",
    values: ["高端"],
  },
  "mall-premium": {
    key: "mall-premium",
    board: "mall",
    short: "高端旗舰",
    name: "高端旗舰榜",
    title: `${SITE.name} 高端旗舰商业体榜`,
    description: "定位高端的商业体，按总榜口径的层内排名。",
    note: `${MALL_LAYER_NOTE}高端旗舰榜=定位「高端」的商业体。`,
    field: "positioning",
    values: ["高端"],
  },
  "mall-mainstream": {
    key: "mall-mainstream",
    board: "mall",
    short: "家庭主流",
    name: "家庭主流榜",
    title: `${SITE.name} 家庭主流商业体榜`,
    description: "面向家庭客群的主力商业体（中端/中高端定位），按总榜口径的层内排名。",
    note: `${MALL_LAYER_NOTE}家庭主流榜=定位中端与中高端的商业体。`,
    field: "positioning",
    values: ["中高端", "中端"],
  },
  "mall-value": {
    key: "mall-value",
    board: "mall",
    short: "大众平替",
    name: "大众平替榜",
    title: `${SITE.name} 大众平替商业体榜`,
    description: "面向大众客群的高性价比商业体（中低端定位），按总榜口径的层内排名。",
    note: `${MALL_LAYER_NOTE}大众平替榜=定位中低端的商业体。`,
    field: "positioning",
    values: ["中低端"],
  },
};

/** 未纳入任何子榜的档案值（显式声明，防静默掉层）。命主 2026-10-01 两轮看板裁决后
 * （17:45 d-rd9-mall-layer-caliber 乙案 + 17:51 d-rd9-mall-lowband-scope 乙案「另立大众平替榜」），
 * 商场三层已覆盖全部有档实体，此表当前为空；机制保留防未来词表漂移静默掉层。 */
export const BOARD_SUBVIEW_EXCLUDED: Record<LeaderboardBoardKey, string[]> = {
  brand: [],
  mall: [],
};

export function subViewsOfBoard(board: LeaderboardBoardKey): BoardSubView[] {
  return LEADERBOARD_SUB_BOARD_KEYS.map((key) => BOARD_SUBVIEWS[key]).filter((s) => s.board === board);
}

export function subViewByKey(key: string): BoardSubView | null {
  return isLeaderboardSubBoardKey(key) ? BOARD_SUBVIEWS[key] : null;
}

export function subViewHref(key: LeaderboardSubBoardKey): string {
  return leaderboardSubBoardPath(key);
}

/** 档案字段取值（子榜命中判定用）；档案缺失=null，不落任何层。 */
export function profileFieldValue(profile: LbProfile | null | undefined, field: BoardSubView["field"]): string | null {
  if (!profile) return null;
  const value = field === "priceBand" ? profile.priceBand : profile.positioning;
  return value ?? null;
}

/** 子榜取数（纯函数）：命中值集合过滤 → 保持总榜序 → 带内重排名 1..N，overallRank 保留总榜名次。 */
export function bandBoardEntries<T extends { rank: number }>(
  entries: readonly T[],
  valueOf: (entry: T) => string | null,
  values: readonly string[],
): Array<{ entry: T; rank: number; overallRank: number }> {
  return entries
    .filter((entry) => {
      const value = valueOf(entry);
      return value !== null && values.includes(value);
    })
    .sort((a, b) => a.rank - b.rank)
    .map((entry, i) => ({ entry, rank: i + 1, overallRank: entry.rank }));
}

// How each source publishes its numbers. 两榜指标全部为计数/金额/层级/指数，展示为整数；v15 时代
// 的百分比/分数格式集合随评测源退役清空（保留机制供未来源复用）。
const PERCENT_SOURCES = new Set<string>([]);
const PLAIN_SOURCES = new Set<string>([
  "brand-volume", "brand-hotsearch", "brand-social", "brand-revenue", "brand-stores",
  "mall-footfall", "mall-affinity", "mall-firststore", "mall-media", "mall-revenue", "winshang-mall",
]);

export function scoreFormat(sourceKey: string, sample?: number | null): LbScoreFormat {
  if (PERCENT_SOURCES.has(sourceKey)) return "percent";
  if (PLAIN_SOURCES.has(sourceKey)) return "number";
  return sample != null && Math.abs(sample) <= 1 ? "fraction" : "number";
}

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatScore(value: number | null | undefined, format: LbScoreFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (format === "fraction") return `${(value * 100).toFixed(1)}%`;
  if (format === "percent") return `${value.toFixed(1)}%`;
  return grouping.format(value);
}

// Model-family marks win over company marks: a Qwen mark identifies Qwen, not Alibaba.
const FAMILY_MARKS: Array<[RegExp, string]> = [
  [/^claude/, "anthropic.svg"],
  [/^(gemini|gemma)/, "google.svg"],
  [/^(qwen|qwq)/, "qianwen.svg"],
  [/^kimi/, "moonshot.svg"],
  [/^grok/, "xai.svg"],
  [/^deepseek/, "deepseek.svg"],
  [/^(hy-|hunyuan)/, "tencent.svg"],
  [/^(seed|doubao)/, "bytedance.svg"],
  [/^(glm|chatglm)/, "z-ai.svg"],
];

const PROVIDER_MARKS: Record<string, string> = {
  openai: "openai.svg",
  meta: "meta.svg",
  minimax: "minimax.svg",
  mistral: "mistral.svg",
  nvidia: "nvidia.svg",
  "z-ai": "z-ai.svg",
};

export function modelBrand(slug: string, providerSlug: string | null, provider: string | null, name: string): LbBrand {
  const family = FAMILY_MARKS.find(([re]) => re.test(slug))?.[1];
  const file = family ?? (providerSlug ? PROVIDER_MARKS[providerSlug] : undefined);
  const label = (provider && provider !== "其他" ? provider : name).replace(/[^\p{L}\p{N}]/gu, "");
  return { src: file ? `/model-providers/${file}` : null, monogram: label.slice(0, 1).toUpperCase() || "?", raster: false };
}

// eqbench.svg and livebench.png carry raster artwork; they get a plate in dark mode.
const RASTER_SOURCE_MARKS = new Set(["eqbench.svg", "livebench.png", "sierra.png", "agents-last-exam.svg", "llm2014.svg"]);

export function sourceBrand(source: RegistrySource): LbBrand {
  return {
    src: source.logo ? `/leaderboard-sources/${source.logo}` : null,
    monogram: source.operator.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?",
    raster: source.logo ? RASTER_SOURCE_MARKS.has(source.logo) : false,
  };
}
