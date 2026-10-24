// T14/ym247：item 与 item-original 共用的 loader 纯组装 helper（服务端专用模块）。
// 修复前 item-original 只返回 {item}，复用 ItemPage 在 entities.filter 取 undefined → SSR 500。
// 必须放在 *.server.ts：路由文件里自定义导出不会像 loader 一样被 React Router 剥离
// server 代码，从路由模块再导出本函数会把 api.server 拖进客户端包（build 失败）。
import type { SiteInsightsResponse, SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404 } from "./api.server.ts";

/** The loader shape ItemPage renders from; item and item-original must return exactly this. */
export interface ItemRailData {
  item: SiteItemDetail;
  insights: SiteInsightsResponse["insights"];
  entities: Array<{ type: "brand" | "mall" | "mall-chain" | "channel"; slug: string; name: string }>;
}

/**
 * Pure assembly shared by the item and item-original loaders: fetch the statistics-only
 * insights and the entity tags, both failing soft to empty. Every consumer of ItemPage
 * goes through here so `entities` can never be undefined in the render tree.
 */
export async function loadItemRailData(item: SiteItemDetail, signal: AbortSignal): Promise<ItemRailData> {
  // ka2: research/market/statistics reports carry their extracted viewpoints; a miss (not extracted yet) renders nothing.
  // ym40: 原 research/market/statistics 已并入 statistics（宏观与数据）。
  const insights = item.category === "statistics"
    ? await loadOr404<SiteInsightsResponse>(`/api/site/insights/article/${encodeURIComponent(item.id)}`, { signal }).catch(() => ({ insights: [] }))
    : { insights: [] };
  // zx18: deterministic entity tags (brands, malls, chains, channels) for the rail cards.
  const entityRes = await loadOr404<{ entities: ItemRailData["entities"] }>(
    `/api/site/articles/${encodeURIComponent(item.id)}/entities`, { signal },
  ).catch(() => ({ entities: [] as ItemRailData["entities"] }));
  return { item, insights: insights.insights, entities: entityRes.entities };
}
