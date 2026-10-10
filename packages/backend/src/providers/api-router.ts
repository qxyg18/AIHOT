// 统一接口路由（命主令 2026-10-05）：每个能力位一条按权重排序的供应商链——默认
// 免费模型池 > MIMO > GLM——断链或连续 5 分钟请求异常自动切到下一个，配额日（UTC 日，
// 即北京 08:00，OpenRouter 免费额度的重置点）自动回到第一个，持续循环。权重与开关存
// settings（后台「API 接口」页可改，60s 缓存即生效）；健康态也存 settings，api 与 worker
// 多进程同画面（沿用 mimo 熔断的存储范式）。未配置（无 settings 行）= 路由关闭，全站
// 逐字节保持旧路由（免费证书桥 + MIMO 白班窗）。
//
// 「天」的口径：UTC 日。OpenRouter 的 free-models-per-day 按 UTC 日重置（北京 08:00），
// 路由的日重置必须与配额日对齐——按北京 00:00 重置会让免费通道在 00:00-08:00 反复撞墙，
// 且 08:00 真重置时反而恢复不了。免费池的今日用量计数（receipt_attempts）同用 UTC 日界。
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { openRouterConfigured } from "../modelwatch/openrouter.ts";
import { ensureFreeRouting, freeRoutingSnapshot, OPENROUTER_FREE_KEY } from "../modelwatch/routing.ts";
import { capabilityForPurpose, resolveFreeModel } from "../modelwatch/capability-routing.ts";
import { mimoUsable } from "./mimo.ts";

export const API_ROUTER_KEY = "llm.api_router";
export const API_ROUTER_STATE_KEY = "llm.api_router_state";

export type ProviderKey = "free" | "mimo" | "glm";

export interface RouterConfig {
  enabled: boolean;
  /** 供应商权重：链按权重降序；0 = 不进链。 */
  weights: Record<ProviderKey, number>;
  /** 免费池 UTC 日发送上限（OpenRouter 无充值账户 50 次/天；充 $10 后为 1000）。 */
  freeDailyCap: number;
}

export const DEFAULT_FREE_DAILY_CAP = 50;
export const PROVIDER_LABELS: Record<ProviderKey, string> = { free: "免费模型", mimo: "MIMO", glm: "GLM" };
/** 各供应商对应的 MODELS 预设键（GLM=default，即部署自己的付费端点，受 llm.config 覆盖）。 */
export const PROVIDER_MODELS: Record<ProviderKey, string> = { free: OPENROUTER_FREE_KEY, mimo: "mimo-v2.6-flash", glm: "default" };
const PROVIDER_ORDER: ProviderKey[] = ["free", "mimo", "glm"];
/** 供应商 → 回执 service（今日用量统计口径）。 */
export const PROVIDER_SERVICES: Record<ProviderKey, string> = { free: "openrouter", mimo: "mimo", glm: "llm" };

/** 断链/异常连续多久算「连续异常」切换（命主口径 5 分钟）。 */
export const STREAK_DOWN_MS = 5 * 60_000;

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---- 配置（权重/开关/日上限）----

function sanitizeConfig(raw: unknown): RouterConfig {
  const v = (raw ?? {}) as { enabled?: unknown; weights?: Partial<Record<ProviderKey, unknown>>; freeDailyCap?: unknown };
  const weights = { ...DEFAULT_CONFIG_WEIGHTS };
  for (const p of PROVIDER_ORDER) {
    const n = Number(v.weights?.[p]);
    if (Number.isFinite(n) && n >= 0) weights[p] = Math.floor(n);
  }
  const cap = Number(v.freeDailyCap);
  return {
    enabled: v.enabled === true,
    weights,
    freeDailyCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_FREE_DAILY_CAP,
  };
}

const DEFAULT_CONFIG_WEIGHTS: Record<ProviderKey, number> = { free: 100, mimo: 50, glm: 10 };

let configCache: { at: number; value: RouterConfig } | null = null;

export async function routerConfig(): Promise<RouterConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.value;
  const rows = await sql<{ value: unknown; updated_at: Date; updated_by: string | null }[]>`
    SELECT value, updated_at, updated_by FROM settings WHERE key = ${API_ROUTER_KEY}`;
  const value = sanitizeConfig(rows[0]?.value);
  configCache = { at: Date.now(), value };
  return value;
}

export function invalidateApiRouterCache(): void {
  configCache = null;
  stateCache = null;
}

// ---- 健康态（当日粘性；UTC 日翻页自动重置回第一个供应商）----

export interface ProviderHealth {
  down: boolean;
  downAt: string | null;
  reason: string | null;
  /** 传输级连续异常的开始时刻（成功即清零；跨满 5 分钟仍在异常=切换）。 */
  streakStart: string | null;
  errorCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
}

export interface RouterState {
  day: string;
  providers: Record<ProviderKey, ProviderHealth>;
  /** 本配额日已耗尽的免费池成员（成员级 429），次日自动清空。 */
  exhaustedFree: string[];
}

const freshHealth = (): ProviderHealth => ({
  down: false, downAt: null, reason: null, streakStart: null,
  errorCount: 0, lastError: null, lastErrorAt: null, lastOkAt: null,
});

export function freshRouterState(day = utcDay()): RouterState {
  return { day, providers: { free: freshHealth(), mimo: freshHealth(), glm: freshHealth() }, exhaustedFree: [] };
}

function sanitizeState(raw: unknown): RouterState {
  const v = (raw ?? {}) as { day?: unknown; providers?: Partial<Record<ProviderKey, Partial<ProviderHealth>>>; exhaustedFree?: unknown };
  const state = freshRouterState(typeof v.day === "string" ? v.day : "");
  for (const p of PROVIDER_ORDER) {
    const h = v.providers?.[p];
    if (!h) continue;
    state.providers[p] = {
      down: h.down === true,
      downAt: typeof h.downAt === "string" ? h.downAt : null,
      reason: typeof h.reason === "string" ? h.reason : null,
      streakStart: typeof h.streakStart === "string" ? h.streakStart : null,
      errorCount: Number(h.errorCount) || 0,
      lastError: typeof h.lastError === "string" ? h.lastError : null,
      lastErrorAt: typeof h.lastErrorAt === "string" ? h.lastErrorAt : null,
      lastOkAt: typeof h.lastOkAt === "string" ? h.lastOkAt : null,
    };
  }
  state.exhaustedFree = Array.isArray(v.exhaustedFree) ? v.exhaustedFree.filter((m): m is string => typeof m === "string") : [];
  return state;
}

async function writeState(state: RouterState): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${API_ROUTER_STATE_KEY}, ${sql.json(state as never)}, 'system')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'system', updated_at = now()`;
  stateCache = { at: Date.now(), value: state };
}

let stateCache: { at: number; value: RouterState } | null = null;

/** 当前健康态；配额日翻页（UTC 日）时先重置再返回——「每天自动刷新回第一个」。 */
export async function routerState(): Promise<RouterState> {
  if (stateCache && Date.now() - stateCache.at < 5_000 && stateCache.value.day === utcDay()) return stateCache.value;
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${API_ROUTER_STATE_KEY}`;
  let state = sanitizeState(rows[0]?.value);
  const today = utcDay();
  if (state.day !== today) {
    state = freshRouterState(today);
    await writeState(state);
  }
  stateCache = { at: Date.now(), value: state };
  return state;
}

/** 后台手动重置（等价于新的一天：全部回到正常，免费池清零重派）。 */
export async function resetRouterState(): Promise<void> {
  await writeState(freshRouterState());
}

// ---- 免费池用量（统计「可免费使用次数」，按次数轮流派发）----

/** UTC 日内各免费模型的实发次数（receipt_attempts，origin=live）。 */
export async function freeUsageToday(): Promise<{ perModel: Map<string, number>; total: number }> {
  const rows = await sql<{ model: string | null; n: string }[]>`
    SELECT model, count(*) AS n FROM receipt_attempts
    WHERE service = 'openrouter' AND origin = 'live'
      AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    GROUP BY model`;
  const perModel = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    perModel.set(r.model ?? "-", n);
    total += n;
  }
  return { perModel, total };
}

/** 免费池派发序：未耗尽成员按今日已用次数升序（同数保持证书序——新验收在前），轮流摊开。 */
export async function freePoolOrder(models: string[]): Promise<string[]> {
  const state = await routerState();
  const { perModel } = await freeUsageToday();
  return models
    .filter((m) => !state.exhaustedFree.includes(m))
    .map((m, i) => ({ m, i, used: perModel.get(m) ?? 0 }))
    .sort((a, b) => a.used - b.used || a.i - b.i)
    .map((x) => x.m);
}

/**
 * chatJson 免费候选链（命主 2026-10-05 轮派口径）：ym196 钉选优先（钉选后监控替补/主力仍垫
 * 后——第一只撞死后 operationKey 姊妹闸需要下一个候选来停车）；否则能力证书成员按「今日
 * 已用次数最少先用」轮派（免费额度按次摊开），替补/主力垫后，最多 4 只控制时延。
 */
export async function freeCandidateModels(purpose: string, pinned?: string): Promise<string[]> {
  const snap = freeRoutingSnapshot();
  const capHit = capabilityForPurpose(purpose);
  const certified = capHit
    ? (snap.capabilityRoute[capHit.capability] ?? []).filter((r) => !capHit.vision || r.vision).map((r) => r.model)
    : [];
  const ordered = pinned ? [pinned] : await freePoolOrder(certified);
  const exhausted = (await routerState()).exhaustedFree;
  const extras = [snap.primary, snap.fallback].filter(
    (m): m is string => !!m && !certified.includes(m) && !exhausted.includes(m) && !ordered.includes(m),
  );
  return [...ordered, ...extras].slice(0, 4);
}

/**
 * 免费池全体成员（证书路由的并集 + 监控主力/替补），供后台展示与耗尽判定。
 * 只读当前缓存快照（ensureFreeRouting 是 async；调用链上链解析/候选构建前必已刷新过）。
 */
export function freePoolMembers(): string[] {
  const snap = freeRoutingSnapshot();
  const members = new Set<string>();
  for (const list of Object.values(snap.capabilityRoute)) for (const r of list) members.add(r.model);
  if (snap.primary) members.add(snap.primary);
  if (snap.fallback) members.add(snap.fallback);
  return [...members];
}

/** 成员级配额拒绝（某只免费模型 429 限流）：今日跳过该成员；全池耗尽则整个免费位当日切换。 */
export async function markFreeMemberExhausted(model: string, reason: string): Promise<void> {
  const state = await routerState();
  if (state.exhaustedFree.includes(model)) return;
  state.exhaustedFree = [...state.exhaustedFree, model];
  const remaining = freePoolMembers().filter((m) => !state.exhaustedFree.includes(m));
  if (remaining.length === 0) {
    state.providers.free = {
      ...freshHealth(),
      down: true, downAt: new Date().toISOString(), reason: `免费池今日全部耗尽：${reason.slice(0, 150)}`,
      errorCount: state.providers.free.errorCount, lastError: reason.slice(0, 200), lastErrorAt: new Date().toISOString(),
    };
  }
  await writeState(state);
}

// ---- 失败分类 ----

/** 免费位账户级配额拒绝（当日全池切换）：402 或带 free-models-per-day / credits 口径的 429。 */
export function isFreeAccountQuotaError(status: number | null, message: string): boolean {
  if (status === 402) return true;
  return status === 429 && /free-models-per-day|insufficient credits|add (?:10 )?credits|purchase more/i.test(message);
}

export type ReportOutcome =
  | { ok: true }
  | { ok: false; kind: "connect" | "quota" | "hard" | "streak"; status: number | null; message: string };

/**
 * 调用结果回报（chatJson 每次供应商级尝试后调用）：
 * - 成功：清连续异常计数（当日已切换的不自动回切——次日自动回第一个）。
 * - 断链 / 非重试 4xx（401/403 等配置类故障）/ 账户级配额：立即切换（当日粘性）。
 * - 429/5xx：连续异常满 5 分钟切换。
 * 仅在状态发生实际变化时落库（避免每次调用都写 settings）。
 */
export async function routerReport(provider: ProviderKey, outcome: ReportOutcome): Promise<void> {
  const cfg = await routerConfig();
  if (!cfg.enabled) return; // 路由关着就不记健康态——旧路由自己有熔断器
  const state = await routerState();
  const h = state.providers[provider];
  const now = new Date().toISOString();
  if (outcome.ok) {
    if (h.streakStart === null && h.lastOkAt) return; // 无变化不落库
    state.providers[provider] = { ...h, streakStart: null, lastOkAt: now };
    await writeState(state);
    return;
  }
  const message = outcome.message.slice(0, 200);
  const next: ProviderHealth = { ...h, errorCount: h.errorCount + 1, lastError: message, lastErrorAt: now };
  if (outcome.kind === "connect" || outcome.kind === "quota" || outcome.kind === "hard") {
    if (h.down && h.reason) { state.providers[provider] = next; await writeState(state); return; }
    next.down = true;
    next.downAt = now;
    next.reason = ({
      connect: `断链：${message}`,
      quota: `免费额度耗尽：${message}`,
      hard: `接口拒绝（HTTP ${outcome.status ?? "?"}）：${message}`,
    } as const)[outcome.kind].slice(0, 200);
    next.streakStart = null;
  } else {
    // streak：第一次异常记起点；跨满 5 分钟仍在异常=切换（当日粘性）
    if (h.down) { state.providers[provider] = next; await writeState(state); return; }
    if (!h.streakStart) next.streakStart = now;
    else if (Date.now() - Date.parse(h.streakStart) >= STREAK_DOWN_MS) {
      next.down = true;
      next.downAt = now;
      next.reason = `连续 5 分钟请求异常：${message}`;
      next.streakStart = null;
    }
  }
  state.providers[provider] = next;
  await writeState(state);
}

// ---- 链解析 ----

export interface ChainOptions {
  /** 能力位是否需要看图（vision 过滤免费池成员）。 */
  vision?: boolean;
  /** 复核位排除免费（与被复核同源=独立性破防，ym196 shoumen P2）。 */
  excludeFree?: boolean;
}

function weightedOrder(weights: Record<ProviderKey, number>): ProviderKey[] {
  return PROVIDER_ORDER.filter((p) => weights[p] > 0)
    .sort((a, b) => weights[b] - weights[a] || PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
}

/**
 * 某能力位的供应商链（权重降序，剔除当日已切换/未配置/无成员/超日上限的）。
 * 全部剔除时回落到已配置供应商的权重序（让真实调用去撞、把真实错误抛出来，而不是静默空转）。
 */
export async function apiRouteChain(capability: string, opts: ChainOptions = {}): Promise<string[]> {
  const cfg = await routerConfig();
  if (!cfg.enabled) return [];
  const state = await routerState();
  const routing = await ensureFreeRouting();
  const { total: freeToday } = await freeUsageToday();
  const freeHit = opts.excludeFree
    ? null
    : resolveFreeModel(routing.capabilityRoute[capability] ?? [], null, { vision: !!opts.vision, simpleEligible: false });
  const usable: Record<ProviderKey, boolean> = {
    free: !state.providers.free.down && freeToday < cfg.freeDailyCap && !!freeHit,
    mimo: !state.providers.mimo.down && (await mimoUsable()),
    glm: !state.providers.glm.down,
  };
  const configured: Record<ProviderKey, boolean> = {
    free: openRouterConfigured() && !!freeHit,
    mimo: !!credential("models", "XIAOMI_MIMO_API_KEY"),
    glm: true,
  };
  const order = weightedOrder(cfg.weights);
  const chain = order.filter((p) => usable[p] && configured[p]);
  return (chain.length > 0 ? chain : order.filter((p) => configured[p])).map((p) => PROVIDER_MODELS[p]);
}

// ---- purpose 反查与覆盖探针（防 llm.ts→models.ts 循环依赖，同 registerPurposeMap 范式）----

let overrideProbe: ((capability: string) => boolean) | null = null;

/** editorial/models.ts 加载时注册：显式指派（后台切换/环境变量）不走路由、不转移。 */
export function registerRouterOverrideProbe(probe: (capability: string) => boolean): void {
  overrideProbe = probe;
}

/**
 * chatJson 的实际执行链：purpose→能力位→（路由开 & 未显式指派 & 请求的是路由供应商预设）
 * 权重链；否则单模型（显式选择永远赢，含 ym196 钉选）。pinnedModel 钉死单模型（能力验收
 * 测的就是那一只模型）。
 */
export async function routeForPurpose(
  purpose: string,
  requestedModel: string,
  opts: { pinned?: boolean } = {},
): Promise<string[]> {
  const cfg = await routerConfig();
  if (!cfg.enabled || opts.pinned) return [requestedModel];
  const cap = capabilityForPurpose(purpose);
  if (!cap) return [requestedModel];
  if (overrideProbe?.(cap.capability)) return [requestedModel];
  if (!PROVIDER_ORDER.some((p) => PROVIDER_MODELS[p] === requestedModel)) return [requestedModel];
  const chain = await apiRouteChain(cap.capability, {
    vision: cap.vision,
    // 复核类能力位排除免费供应商链（ym196 oss / ym437 智谱：核与被核同源=独立性破防）。
    excludeFree: cap.capability === "ossDigestReview" || cap.capability === "zhipuDigestReview",
  });
  return chain.length > 0 ? chain : [requestedModel];
}

// ---- 后台展示 ----

export async function apiRouterLive(): Promise<{
  providers: Array<{ key: ProviderKey; label: string; modelKey: string; weight: number; configured: boolean; usable: boolean; todayCount: number } & ProviderHealth>;
  freePool: Array<{ model: string; todayCount: number; exhausted: boolean }>;
  todayFreeTotal: number;
  state: RouterState;
}> {
  const cfg = await routerConfig();
  const state = await routerState();
  const { perModel, total } = await freeUsageToday();
  const counts = await sql<{ service: string; n: string }[]>`
    SELECT service, count(*) AS n FROM receipt_attempts
    WHERE service IN ('openrouter', 'mimo', 'llm') AND origin = 'live'
      AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    GROUP BY service`;
  const countOf = (s: string) => Number(counts.find((c) => c.service === s)?.n) || 0;
  const usableFree = openRouterConfigured() && (freeRoutingSnapshot().primary != null || Object.keys(freeRoutingSnapshot().capabilityRoute).length > 0);
  const providers = weightedOrder({ ...DEFAULT_CONFIG_WEIGHTS, ...cfg.weights })
    .map((p) => {
      const configured = p === "free" ? openRouterConfigured() : p === "mimo" ? !!credential("models", "XIAOMI_MIMO_API_KEY") : true;
      const usable = p === "free" ? configured && usableFree && !state.providers.free.down && total < cfg.freeDailyCap
        : p === "mimo" ? configured && !state.providers.mimo.down && mimoUsable()
        : !state.providers.glm.down;
      return { key: p, label: PROVIDER_LABELS[p], modelKey: PROVIDER_MODELS[p], weight: cfg.weights[p], configured, usable: !!usable, todayCount: countOf(PROVIDER_SERVICES[p]), ...state.providers[p] };
    });
  const pool = freePoolMembers().map((m) => ({ model: m, todayCount: perModel.get(m) ?? 0, exhausted: state.exhaustedFree.includes(m) }));
  return { providers, freePool: pool, todayFreeTotal: total, state };
}
