// 智谱免费通道（ym436 命主令 2026-10-08）：GLM-4.7-Flash 等官方免费家族走通用 paas/v4
// 端点，凭据=ZHIPU_BASE_URL/ZHIPU_API_KEY（models.env）。免费=按并发限流不按日次，与
// OpenRouter 免费池（账号级 50 次/日）互补。熔断形态照 mimo：余额/配额类拒绝开 30 分钟
// 冷却（免费模型正常不触发；1113/402 类=凭据面变化时兜底），到点半开，下一次真实调用
// 即探针。注意 1305（平台过载）不在熔断面——它是瞬态重试信号，交给候选链换下一个。
import { sql } from "../db.ts";
import { credential } from "../config.ts";

/** MODELS 预设键：实际模型 id 由证书路由钉选/快照解析（zhipu: 前缀成员换模型预设键不变）。 */
export const ZHIPU_FREE_KEY = "zhipu-free";

export const ZHIPU_CIRCUIT_KEY = "llm.zhipu_circuit";
export const ZHIPU_CIRCUIT_COOLDOWN_MS = 30 * 60_000;

export function zhipuConfigured(): boolean {
  return !!(credential("models", "ZHIPU_API_KEY") && credential("models", "ZHIPU_BASE_URL"));
}

async function circuitOpen(): Promise<boolean> {
  const rows = await sql<{ value: { openUntil?: string } | null }[]>`SELECT value FROM settings WHERE key = ${ZHIPU_CIRCUIT_KEY}`;
  const until = rows[0]?.value?.openUntil ? Date.parse(rows[0].value.openUntil) : NaN;
  return Number.isFinite(until) && until > Date.now();
}

/** 熔断状态（后台页展示用）。 */
export async function zhipuCircuitState(): Promise<{ open: boolean; until: string | null; reason: string | null }> {
  const rows = await sql<{ value: { openUntil?: string; reason?: string } | null }[]>`SELECT value FROM settings WHERE key = ${ZHIPU_CIRCUIT_KEY}`;
  const v = rows[0]?.value ?? null;
  const open = !!(v?.openUntil && Date.parse(v.openUntil!) > Date.now());
  return { open, until: open ? v!.openUntil! : null, reason: v?.reason ?? null };
}

/** 通道层可用性：凭据在且熔断闭（证书成员有无由 modelFor 按能力位判）。 */
export async function zhipuUsable(): Promise<boolean> {
  return zhipuConfigured() && !(await circuitOpen());
}

/** 余额/配额类失败开熔断：30 分钟内视同通道不可用，候选链/班次守卫回落其他通道。 */
export async function openZhipuCircuit(reason: string): Promise<void> {
  const value = { openUntil: new Date(Date.now() + ZHIPU_CIRCUIT_COOLDOWN_MS).toISOString(), reason: reason.slice(0, 200) };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${ZHIPU_CIRCUIT_KEY}, ${sql.json(value as never)}, 'system')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}
