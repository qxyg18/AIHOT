// 免费模型路由的共享快照（modelFor 与 openrouter-free 预设共用，两边永远一致）：
// settings 里的 modelwatch.routing 由监控扫描写入（primary/fallback/simple），这里加 60s
// 缓存与「key 未配置 / 熔断打开 → 视同无免费模型」两道闸。同步 snapshot() 给 ModelSpec 的
// getter 用（getter 不能 await），ensureFreeRouting() 给 modelFor 用——两者同源同缓存。
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { openRouterConfigured } from "./openrouter.ts";
import { zhipuUsable } from "../providers/zhipu.ts";
import { opencodeUsable } from "../providers/opencode.ts";
import { zhipuPoolModels } from "../zhipuwatch/pool.ts";
import { opencodePoolModels } from "../opencodewatch/pool.ts";
import { channelOfModel, type CapabilityRoute } from "./capability-routing.ts";

export const OPENROUTER_CIRCUIT_KEY = "llm.openrouter_circuit";
export const OPENROUTER_CIRCUIT_COOLDOWN_MS = 30 * 60_000;
/** MODELS 预设键：实际模型 id 由快照在调用时解析（免费模型会换，预设键不变）。 */
export const OPENROUTER_FREE_KEY = "openrouter-free";

export interface RoutingState {
  primary: string | null;
  fallback: string | null;
  simple: string | null;
  primaryVision: boolean;
  simpleVision: boolean;
  updatedAt: string | null;
}

export interface FreeRouting {
  /** 主力免费模型（全站未显式指派的能力都走它）；无则 null。 */
  primary: string | null;
  /** 简单档免费模型（只在无主力时接简单能力位）。 */
  simple: string | null;
  /** 切换免费模型时的替补（上一任主力，仍免费时保留）。 */
  fallback: string | null;
  primaryVision: boolean;
  simpleVision: boolean;
  /** ym196 能力级路由：能力位 → 合格免费模型有序清单（新验收在前，判卷 qualified 的）。 */
  capabilityRoute: Record<string, CapabilityRoute[]>;
  /** ym438：智谱免费池（settings zhipuwatch.pool；缺省=glm-4.7-flash）——ZHIPU_FREE_KEY 预设
   *  无证书成员时的回退模型源（预设 getter 是同步的，只能读快照）。 */
  zhipuPool: string[];
  /** ym467：opencode 免费池（settings opencodewatch.pool）——OPENCODE_FREE_KEY 预设无证书成员
   *  时的回退模型源（同 zhipuPool 口径；池空=无回退，预设报「无可跑模型」）。 */
  opencodePool: string[];
  /** ym249：路由证据的版本面（证书集最新版本与快照构建时刻；policy/config 由 admin DTO 另投影）。 */
  versions: { maxCertVersion: string | null; checkedAt: string };
}

interface StoredRouting extends RoutingState {}

let snapshot: FreeRouting = { primary: null, fallback: null, simple: null, primaryVision: false, simpleVision: false, capabilityRoute: {}, zhipuPool: [], opencodePool: [], versions: { maxCertVersion: null, checkedAt: "" } };
let cache: { at: number } | null = null;

function toFreeRouting(row: StoredRouting | null, capabilityRoute: Record<string, CapabilityRoute[]>, versions: FreeRouting["versions"], zhipuPool: string[], opencodePool: string[]): FreeRouting {
  const base = row
    ? {
        primary: row.primary ?? null,
        fallback: row.fallback ?? null,
        simple: row.simple ?? null,
        primaryVision: !!row.primaryVision,
        simpleVision: !!row.simpleVision,
      }
    : { primary: null, fallback: null, simple: null, primaryVision: false, simpleVision: false };
  return { ...base, capabilityRoute, zhipuPool, opencodePool, versions };
}

export function freeRoutingSnapshot(): FreeRouting {
  return snapshot;
}

async function circuitOpen(): Promise<boolean> {
  const rows = await sql<{ value: { openUntil?: string } | null }[]>`SELECT value FROM settings WHERE key = ${OPENROUTER_CIRCUIT_KEY}`;
  const until = rows[0]?.value?.openUntil ? Date.parse(rows[0].value.openUntil) : NaN;
  return Number.isFinite(until) && until > Date.now();
}

/** 熔断状态（后台页展示用）。 */
export async function openRouterCircuitState(): Promise<{ open: boolean; until: string | null; reason: string | null }> {
  const rows = await sql<{ value: { openUntil?: string; reason?: string } | null }[]>`SELECT value FROM settings WHERE key = ${OPENROUTER_CIRCUIT_KEY}`;
  const v = rows[0]?.value ?? null;
  const open = !!(v?.openUntil && Date.parse(v.openUntil) > Date.now());
  return { open, until: open ? v!.openUntil! : null, reason: v?.reason ?? null };
}

/** 刷新快照（60s 缓存；invalidateFreeRouting 后立即重读）。无 key 或熔断打开 → 对应通道为空
 *  （ym436：两个免费通道各自独立判可用——OpenRouter 熔断不拖死智谱通道，反之亦然；
 *  ym467：opencode 通道同口径独立判——客户端不可达/熔断只空本通道面）。 */
export async function ensureFreeRouting(): Promise<FreeRouting> {
  if (cache && Date.now() - cache.at < 60_000) return snapshot;
  const checkedAt = new Date().toISOString();
  const orReady = openRouterConfigured() && !(await circuitOpen());
  const zhipuReady = await zhipuUsable();
  const ocReady = await opencodeUsable();
  let next: FreeRouting = { primary: null, fallback: null, simple: null, primaryVision: false, simpleVision: false, capabilityRoute: {}, zhipuPool: [], opencodePool: [], versions: { maxCertVersion: null, checkedAt } };
  if (orReady || zhipuReady || ocReady) {
    // ym196：能力路由随快照同源加载（合格清单按验收时间倒序）。
    // ym249 过滤闸（AC4）：文本模态（provider_facts.supportsText——Lyria 这类纯音乐/图像
    // 模型不能凭零价进文本能力路由）、目录明确给出且不足的输出上限排除（NULL=目录未声明，
    // 交给逐能力认证把真实输出能力考出来）。
    // ym441（命主 2026-10-08 免费优先令）：上下文闸与智谱面同档降为 100K——原 1M 闸
    // （命主 2026-10-02 旧口径）把唯一持证免费模型 nemotron-3-super:free（256K，5 个能力位）
    // 挡在路由外，免费承接 0 次；上下文闸只做粗筛（免费新闻文本远小于 100K），真实能力
    // 由逐能力认证把关。回滚=本值改回 1000000 并重建容器。
    // ym436：openrouter 面显式排除 zhipu: 成员（双保险防误入）；智谱面独立取（同 100K 闸，
    // 免费家族 128K/200K 都是生产级文本模型）；ym467：opencode 面同形独立取（客户端目录
    // 200K 级），or/zhipu 两面各自排除 opencode: 成员。
    const [orQualified, zhipuQualified, ocQualified, rows, zhipuPool, opencodePool] = await Promise.all([
      orReady
        ? sql<{ capability: string; model_id: string; supports_vision: boolean; tested_at: Date; pass_count: number; cert_version: string }[]>`
            SELECT c.capability, c.model_id, m.supports_vision, c.tested_at, c.pass_count, m.cert_version
            FROM model_free_capabilities c JOIN model_watch_models m ON m.model_id = c.model_id
            WHERE c.verdict = 'qualified' AND m.status NOT IN ('ended', 'filtered')
              AND m.model_id NOT LIKE 'zhipu:%'
              AND m.model_id NOT LIKE 'opencode:%'
              AND coalesce(m.context_length, 0) >= 100000
              AND coalesce((m.provider_facts->>'supportsText')::boolean, true)
              AND (m.provider_facts->>'outputLimit' IS NULL OR coalesce((m.provider_facts->>'outputLimit')::int, 0) >= 256)
            ORDER BY c.tested_at DESC, c.pass_count DESC`
        : [],
      zhipuReady
        ? sql<{ capability: string; model_id: string; supports_vision: boolean; tested_at: Date; pass_count: number; cert_version: string }[]>`
            SELECT c.capability, c.model_id, m.supports_vision, c.tested_at, c.pass_count, m.cert_version
            FROM model_free_capabilities c JOIN model_watch_models m ON m.model_id = c.model_id
            WHERE c.verdict = 'qualified' AND m.status NOT IN ('ended', 'filtered')
              AND m.model_id LIKE 'zhipu:%'
              AND coalesce(m.context_length, 0) >= 100000
            ORDER BY c.tested_at DESC, c.pass_count DESC`
        : [],
      ocReady
        ? sql<{ capability: string; model_id: string; supports_vision: boolean; tested_at: Date; pass_count: number; cert_version: string }[]>`
            SELECT c.capability, c.model_id, m.supports_vision, c.tested_at, c.pass_count, m.cert_version
            FROM model_free_capabilities c JOIN model_watch_models m ON m.model_id = c.model_id
            WHERE c.verdict = 'qualified' AND m.status NOT IN ('ended', 'filtered')
              AND m.model_id LIKE 'opencode:%'
              AND coalesce(m.context_length, 0) >= 100000
            ORDER BY c.tested_at DESC, c.pass_count DESC`
        : [],
      orReady ? sql<{ value: StoredRouting | null }[]>`SELECT value FROM settings WHERE key = 'modelwatch.routing'` : [],
      zhipuReady ? zhipuPoolModels() : [],
      ocReady ? opencodePoolModels() : [],
    ]);
    // ym436 合流（命主口径：智谱免费优先）：智谱成员排前，openrouter 成员随后各自按验收
    // 时间倒序——resolveFreeModel 取首命中即先智谱后 OpenRouter；ym467：opencode 成员垫尾
    // （第三路，前两路证书成员用尽后才轮到；免费内部多路由兜底的追加序）。
    const capabilityRoute = mergeCapabilityRoutes(zhipuQualified, orQualified, ocQualified);
    let maxCertVersion: string | null = null;
    for (const r of [...zhipuQualified, ...orQualified, ...ocQualified]) {
      if (r.cert_version && (!maxCertVersion || r.cert_version > maxCertVersion)) maxCertVersion = r.cert_version;
    }
    next = toFreeRouting(orReady ? rows[0]?.value ?? null : null, capabilityRoute, { maxCertVersion, checkedAt }, zhipuPool, opencodePool);
  }
  snapshot = next;
  cache = { at: Date.now() };
  return snapshot;
}

/** ym436：合流两通道证书（纯函数，便于测试）：智谱成员排前（命主口径「智谱免费优先」），
 *  openrouter 成员随后按入参序（验收时间倒序）；ym467：opencode 成员第三段垫尾（第三路，
 *  前两路用尽才轮到——「免费内部多路由兜底」的追加序；默认空数组，两参调用行为不变）。
 *  按「能力×模型」去重（同一模型可在多个能力位持证；三通道模型 id 前缀不同理论不重叠，
 *  防御性按对去重）。 */
export interface QualifiedRow {
  capability: string;
  model_id: string;
  supports_vision: boolean;
  tested_at: Date | string;
  pass_count: number;
  cert_version: string | null;
}

export function mergeCapabilityRoutes(zhipu: QualifiedRow[], openrouter: QualifiedRow[], opencode: QualifiedRow[] = []): Record<string, CapabilityRoute[]> {
  const merged: Record<string, CapabilityRoute[]> = {};
  const seen = new Set<string>();
  for (const r of [...zhipu, ...openrouter, ...opencode]) {
    const key = `${r.capability}|${r.model_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (merged[r.capability] ??= []).push({
      model: r.model_id,
      vision: !!r.supports_vision,
      testedAt: (r.tested_at instanceof Date ? r.tested_at : new Date(r.tested_at)).toISOString(),
      passCount: r.pass_count,
      channel: channelOfModel(r.model_id),
    });
  }
  return merged;
}

/** ym436：任一免费通道可承接（worker 班次守卫用）：智谱=通道可用且有 zhipu 证书成员；
 *  OpenRouter=配置+熔断闭+池内有成员（主力/替补/任一非智谱证书）；ym467 opencode=通道
 *  可用（客户端凭据在+熔断闭）且有 opencode 证书成员。保守口径：无成员=不可承接。 */
export async function freeChannelUsable(): Promise<boolean> {
  const snap = await ensureFreeRouting();
  const hasZhipu = Object.values(snap.capabilityRoute).some((list) => list.some((r) => r.channel === "zhipu"));
  if (hasZhipu && (await zhipuUsable())) return true;
  const hasOc = Object.values(snap.capabilityRoute).some((list) => list.some((r) => r.channel === "opencode"));
  if (hasOc && (await opencodeUsable())) return true;
  const hasOr = !!snap.primary || !!snap.fallback || Object.values(snap.capabilityRoute).some((list) => list.some((r) => (r.channel ?? "openrouter") === "openrouter"));
  return hasOr && openRouterConfigured() && !(await circuitOpen());
}

export function invalidateFreeRouting(): void {
  cache = null;
}

/** 余额类失败开熔断（mimo 同款口径）：30 分钟内视同无免费模型，全站回落常规路由。 */
export async function openOpenRouterCircuit(reason: string): Promise<void> {
  const value = { openUntil: new Date(Date.now() + OPENROUTER_CIRCUIT_COOLDOWN_MS).toISOString(), reason: reason.slice(0, 200) };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${OPENROUTER_CIRCUIT_KEY}, ${sql.json(value as never)}, 'system')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  invalidateFreeRouting();
}
