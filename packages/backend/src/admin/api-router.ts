// Admin "API 接口" 子页：统一接口路由（命主令 2026-10-05）的权重/开关/免费日上限与实时
// 状态。写路径带审计；改完即失效缓存（下一次调用生效，最长 60s 设置缓存同款节奏）。
import { sql } from "../db.ts";
import { audit } from "./auth.ts";
import {
  API_ROUTER_KEY, API_ROUTER_STATE_KEY, apiRouterLive, invalidateApiRouterCache,
  resetRouterState, routerConfig, type ProviderKey, type RouterConfig,
} from "../providers/api-router.ts";

export async function apiRouterOverview() {
  const rows = await sql<{ updated_at: Date; updated_by: string | null }[]>`
    SELECT updated_at, updated_by FROM settings WHERE key = ${API_ROUTER_KEY}`;
  const cfg = await routerConfig();
  const live = await apiRouterLive();
  return {
    config: { ...cfg, updatedAt: rows[0]?.updated_at ?? null, updatedBy: rows[0]?.updated_by ?? null },
    ...live,
  };
}

/** 部分提交合并进现值（同 llm.config 的「留空=不改」口径）；权重 0=该接口不进链。 */
export async function setApiRouterConfig(
  input: { enabled?: boolean; weights?: Partial<Record<ProviderKey, number>>; freeDailyCap?: number | null },
  actor: string,
) {
  const current = await routerConfig();
  const next: RouterConfig = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    weights: { ...current.weights },
    freeDailyCap: typeof input.freeDailyCap === "number" && input.freeDailyCap > 0 ? Math.floor(input.freeDailyCap) : current.freeDailyCap,
  };
  for (const p of ["free", "mimo", "glm"] as ProviderKey[]) {
    const n = input.weights?.[p];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) next.weights[p] = Math.floor(n);
  }
  const before = await apiRouterOverview();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${API_ROUTER_KEY}, ${sql.json(next as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  invalidateApiRouterCache();
  const after = await apiRouterOverview();
  await audit(actor, "settings.api_router", `settings:${API_ROUTER_KEY}`, null, before.config, after.config);
  return after;
}

/** 手动重置今日健康态（等价「新的一天」：切走的接口全部恢复，免费池清零重派）。 */
export async function resetApiRouterState(actor: string) {
  const before = await apiRouterOverview();
  await resetRouterState();
  await audit(actor, "settings.api_router_reset", `settings:${API_ROUTER_STATE_KEY}`, null, before.state, null);
  invalidateApiRouterCache();
  return apiRouterOverview();
}
