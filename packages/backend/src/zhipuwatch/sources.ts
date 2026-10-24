// 智谱关注信源面（ym437 卡面 2026-10-08 实拉核证）：docs.bigmodel.cn 服务端渲染支持 .md 后缀
// 直取；bigmodel.cn 门户是 SPA 空壳不可抓、无 RSS。定点页 5 个 + sitemap lastmod 差分
// （新页/改版公告的发现面）。
import {
  parseNewReleases, parsePageVersion, parsePricingFreeRows, parsePromotion, type ParsedItem,
} from "./parse.ts";

export type ZhipuKind = "model_release" | "plan_promo" | "free_window" | "pricing_change" | "community" | "other";

export interface ZhipuSource {
  key: string;
  label: string;
  url: string;
  kind: ZhipuKind;
  parser: (md: string) => ParsedItem[];
  /** 首轮基线出刊上限：老页不追全历史，只把最新的读出来；其余只记水位不出刊。 */
  baselineCap: number;
}

export const ZHIPU_SOURCES: ZhipuSource[] = [
  {
    key: "new-releases", label: "模型与产品发布记录", kind: "model_release", baselineCap: 12,
    url: "https://docs.bigmodel.cn/cn/update/new-releases.md", parser: parseNewReleases,
  },
  {
    key: "promotion", label: "上新活动", kind: "plan_promo", baselineCap: 12,
    url: "https://docs.bigmodel.cn/cn/update/promotion.md", parser: parsePromotion,
  },
  {
    key: "free-night-event", label: "夜间畅用活动公告（免费窗口）", kind: "free_window", baselineCap: 1,
    url: "https://docs.bigmodel.cn/cn/coding-plan/notice/event-glm-5.3-flash.md", parser: parsePageVersion,
  },
  {
    key: "plan-usage-revision", label: "套餐改版与老用户权益说明", kind: "plan_promo", baselineCap: 1,
    url: "https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision.md", parser: parsePageVersion,
  },
  {
    key: "pricing", label: "API 定价（免费模型标注行）", kind: "pricing_change", baselineCap: 12,
    url: "https://docs.bigmodel.cn/cn/guide/start/pricing.md", parser: parsePricingFreeRows,
  },
];

export const ZHIPU_SITEMAP_URL = "https://docs.bigmodel.cn/sitemap.xml";

/** sitemap 只看公告/套餐相关路径：API 参考页的批量刷新不是智谱动态。 */
export const WATCHED_PATH_PREFIXES = ["/cn/update/", "/cn/coding-plan/"];

/** sitemap 差分每轮出刊上限（批量改版时按 lastmod 新的先出，其余下轮）。 */
export const SITEMAP_PER_RUN_CAP = 5;

/** 定点页每轮增量出刊上限（同上，超出部分水位不推进、下轮继续）。 */
export const INCREMENTAL_CAP = 12;

const FETCH_TIMEOUT_MS = 20_000;

/** 文档站文本拉取（.md 直取 / sitemap.xml 通用）。 */
export async function docsFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "aihot-zhipuwatch/1.0 (+private admin module)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}
