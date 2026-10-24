// 能力级免费路由（ym196 命主令）：model_free_capabilities 表（分能力 10 次测试+付费判卷的
// 验收结论）的读写与路由判定。qualified 的（模型×能力）组合优先于 legacy 主力/简单档被
// 路由；两者皆无才回落付费（断链过渡档）。vision 位只路由 vision 模型。表空=行为不变
// （冷启动零扰动，legacy 桥继续顶）。
import { sql } from "../db.ts";

export type CapabilityVerdict = "qualified" | "rejected";

export interface CapabilityRouteRow {
  model_id: string;
  capability: string;
  verdict: CapabilityVerdict;
  pass_count: number;
  verdict_payload: Record<string, unknown>;
  receipt_id: number | null;
  tested_at: Date;
}

/** 模型对的路由视图（纯数据，判定的输入）。 */
export interface CapabilityRoute {
  model: string;
  vision: boolean;
  testedAt: string;
  passCount: number;
  /** ym436：成员所属免费通道——zhipu:=智谱 paas/v4 免费家族（GLM-4.7-Flash 等），缺省=openrouter。
   *  ym467：opencode:=opencode 免费档（经宿主 opencode serve 中介）。
   *  调用层按它选预设（ZHIPU_FREE_KEY / OPENROUTER_FREE_KEY / OPENCODE_FREE_KEY），端点不同不混链。 */
  channel?: "openrouter" | "zhipu" | "opencode";
}

/** ym436/ym467：model_id 前缀即通道（zhipu: 前缀=智谱免费通道成员；opencode: 前缀=opencode 免费档）。 */
export function channelOfModel(modelId: string): "openrouter" | "zhipu" | "opencode" {
  return modelId.startsWith("zhipu:") ? "zhipu" : modelId.startsWith("opencode:") ? "opencode" : "openrouter";
}

export async function listCapabilityRoutes(): Promise<CapabilityRouteRow[]> {
  return sql<CapabilityRouteRow[]>`SELECT * FROM model_free_capabilities ORDER BY capability, tested_at DESC`;
}

/** 某能力的合格模型清单（新验收在前；vision 过滤交给调用方/纯函数）。 */
export async function qualifiedModelsFor(capability: string): Promise<CapabilityRoute[]> {
  const rows = await sql<{ model_id: string; supports_vision: boolean; tested_at: Date; pass_count: number }[]>`
    SELECT c.model_id, m.supports_vision, c.tested_at, c.pass_count
    FROM model_free_capabilities c
    JOIN model_watch_models m ON m.model_id = c.model_id
    WHERE c.capability = ${capability} AND c.verdict = 'qualified' AND m.status NOT IN ('ended', 'filtered')
    ORDER BY c.tested_at DESC, c.pass_count DESC`;
  return rows.map((r) => ({ model: r.model_id, vision: !!r.supports_vision, testedAt: r.tested_at.toISOString(), passCount: r.pass_count }));
}

/** 某模型某能力的当前验收行（无则 null）。 */
export async function getCapabilityRoute(modelId: string, capability: string): Promise<CapabilityRouteRow | null> {
  const rows = await sql<CapabilityRouteRow[]>`SELECT * FROM model_free_capabilities WHERE model_id = ${modelId} AND capability = ${capability}`;
  return rows[0] ?? null;
}

export async function saveCapabilityRoute(row: {
  modelId: string;
  capability: string;
  verdict: CapabilityVerdict;
  passCount: number;
  payload: Record<string, unknown>;
  receiptId: number | null;
}): Promise<void> {
  await sql`
    INSERT INTO model_free_capabilities (model_id, capability, verdict, pass_count, verdict_payload, receipt_id)
    VALUES (${row.modelId}, ${row.capability}, ${row.verdict}, ${row.passCount}, ${sql.json(row.payload as never)}, ${row.receiptId})
    ON CONFLICT (model_id, capability) DO UPDATE SET
      verdict = EXCLUDED.verdict, pass_count = EXCLUDED.pass_count,
      verdict_payload = EXCLUDED.verdict_payload, receipt_id = EXCLUDED.receipt_id, tested_at = now()`;
}

// ---- 路由判定（纯函数，便于测试） ----

export interface LegacyRoutingLike {
  primary: string | null;
  simple: string | null;
  primaryVision: boolean;
  simpleVision: boolean;
}

/** 能力级路由判定：qualified 路由表优先（vision 匹配），无命中回 legacy（主力/简单档），
 *  再无命中 null=走付费（断链过渡档）。返回具体免费模型 id（调用层用 OPENROUTER_FREE_KEY
 *  预设+该 id 发请求）。 */
export function resolveFreeModel(
  routes: CapabilityRoute[],
  legacy: LegacyRoutingLike | null,
  capability: { vision: boolean; simpleEligible: boolean },
): { model: string; source: "capability" | "legacy" } | null {
  const hit = routes.find((r) => !capability.vision || r.vision);
  if (hit) return { model: hit.model, source: "capability" };
  if (legacy) {
    if (legacy.primary && (!capability.vision || legacy.primaryVision)) return { model: legacy.primary, source: "legacy" };
    if (!legacy.primary && legacy.simple && capability.simpleEligible && (!capability.vision || legacy.simpleVision)) {
      return { model: legacy.simple, source: "legacy" };
    }
  }
  return null;
}

/** purpose → 能力位反查（CAPABILITIES 的 purposes 都唯一归属一个能力位）。
 *  映射由 editorial/models.ts 启动时注册（防 llm.ts→models.ts 循环依赖；未注册=无能力
 *  路由，回落 legacy 快照行为）。 */
let purposeRegistry: Record<string, { purposes: string[]; vision?: boolean }> | null = null;

export function registerPurposeMap(map: Record<string, { purposes: string[]; vision?: boolean }>): void {
  purposeRegistry = map;
}

export function registeredPurposeMap(): Record<string, { purposes: string[]; vision?: boolean }> | null {
  return purposeRegistry;
}

export function capabilityForPurpose(purpose: string): { capability: string; vision: boolean } | null {
  if (!purposeRegistry) return null;
  for (const [cap, c] of Object.entries(purposeRegistry)) {
    if (c.purposes.includes(purpose)) return { capability: cap, vision: !!c.vision };
  }
  return null;
}
