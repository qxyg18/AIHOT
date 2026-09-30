// Reader-facing leaderboard vocabulary: evaluation sources, board copy, score formats and brand marks.
// Scoring weights and eligibility never come from here; they come from the computation run.
import type { LeaderboardBoardKey } from "@aihot/contracts/taxonomy";
import type { LbBrand, LbScoreFormat, LbSourceStatus } from "@aihot/contracts/leaderboard";
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
    description: "按声量、业绩、规模、扩张四个维度，追踪童装品牌的月度综合表现。",
    howToRead: "权重=媒体声量 20 / 业绩 40 / 规模 30 / 扩张 10，各维度独立计权（缺数维度计 0 贡献，分母固定为权重总和，不交叉补位）并带覆盖度标签；窗口提及不足 3 条的维度不计分；覆盖度过低的品牌标「样本不足」。",
  },
  mall: {
    key: "mall",
    name: "全国商业体榜",
    title: `${SITE.name} 全国商业体榜`,
    description: "按客流规模、童装业态亲和、业绩、首店快闪动能、媒体声量五个维度，追踪全国商业体。",
    howToRead: "权重=客流 35 / 童装业态亲和 20 / 业绩 15 / 首店快闪 15 / 媒体声量 15；业绩缺数时滚给客流。客流数据源降级期为「客流单源直榜」（人工种子层级，见排名方法页冷启动说明）。",
  },
};

// 榜单实体展示与详情页可见上限（zw13 展示策略）：品牌榜最多 80 名，商业体榜全量可见（防膨胀上限 1000）。
export const BOARD_ENTRY_LIMITS: Record<string, number> = { brand: 80, mall: 1000 };
export function boardEntryLimit(key: string): number {
  return BOARD_ENTRY_LIMITS[key] ?? 80;
}
// 来源页单源快照的配置行上限，与榜实体展示无关，沿用旧 30 档。
export const SNAPSHOT_ROWS_LIMIT = 30;

// How each source publishes its numbers. 两榜指标全部为计数/金额/层级/指数，展示为整数；v15 时代
// 的百分比/分数格式集合随评测源退役清空（保留机制供未来源复用）。
const PERCENT_SOURCES = new Set<string>([]);
const PLAIN_SOURCES = new Set<string>([
  "brand-volume", "brand-expansion", "brand-hotsearch", "brand-social", "brand-revenue", "brand-stores",
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
