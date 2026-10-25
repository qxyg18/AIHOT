// Provider-routed day plan (ym431, owner directive 2026-10-08 "近期智谱套餐没额度，除了23:00~9:00
// 这个期间，全部切换成MIMO+免费模型跑。下周二恢复智谱套餐的18:00后运行"): the zw20 quiet window
// is retired — the site updates around the clock — and instead the model provider is routed by
// time of day. Shared by the schedule gates and the model router. All Beijing wall-clock (fixed
// UTC+8 offset, no DST). Before OFFPEAK_EFFECTIVE_FROM every window check is bypassed.
//
// ym438（雷达智谱动态联动 S03）：套餐窗 settings 化——两层规则取或：
//   ①代码常量层（缺省态=ym436 落地态）：PLAN_WINDOW_FROM（2026-10-13 18:00）起每日 18:00-09:00；
//   ②settings 层（键 zhipu.plan_window）：{mode,from,to,daily} 表示公告解析出的免费/套餐窗口
//     （如夜间畅用 2026-09-03~10-07 每日 23:00-09:00）。窗口停止=日期范围外自动失效（摘窗），
//     新公告自动改写（挂窗）；键可清=回落常量层（回滚路径）。mode=manual 时自动解析不覆写。
// 读取缓存 60s（stale-while-revalidate，跨进程最迟一分钟后生效），写入方（zhipuwatch 扫描）
// 落库后本进程立即可见。求值在常量层同步可用（冷启动无 settings 即回落常量），不阻塞热路径。
import { sql } from "../db.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

export const OFFPEAK_EFFECTIVE_FROM = Date.UTC(2026, 9, 7, 16, 0); // = 2026-10-08 00:00 Asia/Shanghai
// ka3 early go (owner directive 2026-09-30 "mimo顶上"): the model router switches to MIMO during
// the daytime window as soon as its key is configured. The timestamp is already in the past, so
// routing is live now.
export const MIMO_EARLY_FROM = Date.UTC(2026, 8, 30, 6, 0); // = 2026-09-30 14:00 Asia/Shanghai (month is 0-based)
// ym431: from next Tuesday 18:00 the plan window starts at 18:00 ("恢复智谱套餐的18:00后运行") —
// the same self-executing effective-date pattern as OFFPEAK_EFFECTIVE_FROM.
export const PLAN_WINDOW_FROM = Date.UTC(2026, 9, 13, 10, 0); // = 2026-10-13 18:00 Asia/Shanghai

export const bjClock = (now = Date.now()) => {
  const date = beijingDate(now);
  const [hour, minute] = beijingTime(now).split(":").map(Number);
  return { weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), minutes: hour! * 60 + minute! };
};

/** 北京日期 YYYY-MM-DD（窗口规则的日期比较用字符串序，ISO 日期天然可比）。 */
export const bjDate = (now = Date.now()) => beijingDate(now);

// ---- ym438 settings 层：套餐/免费窗口规则 ----

export const PLAN_WINDOW_KEY = "zhipu.plan_window";
const PLAN_WINDOW_TTL_MS = 60_000;

export interface PlanWindowRule {
  mode: "auto" | "manual";
  /** 生效起日（含）北京日期 YYYY-MM-DD；null=无日期面（层内不生效）。 */
  from: string | null;
  /** 生效止日（含）。 */
  to: string | null;
  /** 每日时段 HH:MM；start>end 表示跨天（23:00-09:00=当晚至次日早）。 */
  daily: { start: string; end: string } | null;
  note?: string;
  updatedAt: string;
}

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 宽松归一 + 校验：形状不合法整块作废（回落常量层），绝不据此求值。 */
function normalizeRule(value: unknown): PlanWindowRule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const mode = v.mode === "manual" ? "manual" : v.mode === "auto" ? "auto" : null;
  if (!mode) return null;
  const from = typeof v.from === "string" && DATE_RE.test(v.from) ? v.from : null;
  const to = typeof v.to === "string" && DATE_RE.test(v.to) ? v.to : null;
  const dailyRaw = v.daily as { start?: unknown; end?: unknown } | null | undefined;
  const daily = dailyRaw && typeof dailyRaw.start === "string" && typeof dailyRaw.end === "string" &&
      HHMM_RE.test(dailyRaw.start) && HHMM_RE.test(dailyRaw.end)
    ? { start: dailyRaw.start.padStart(5, "0"), end: dailyRaw.end.padStart(5, "0") }
    : null;
  return { mode, from, to, daily, note: typeof v.note === "string" ? v.note : undefined, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "" };
}

const hhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
};

let planWindowCache: { at: number; rule: PlanWindowRule | null } | null = null;
let planWindowLoading: Promise<void> | null = null;

export function planWindowSnapshot(): PlanWindowRule | null {
  return planWindowCache?.rule ?? null;
}

/** 读 settings 并刷新缓存（测试/写入方显式调用；热路径走 ensureFresh 的 SWR）。 */
export async function refreshPlanWindow(): Promise<PlanWindowRule | null> {
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${PLAN_WINDOW_KEY}`;
  const rule = normalizeRule(rows[0]?.value ?? null);
  planWindowCache = { at: Date.now(), rule };
  return rule;
}

export function invalidatePlanWindow(): void {
  planWindowCache = null;
}

function ensurePlanWindowFresh(): void {
  if (planWindowCache && Date.now() - planWindowCache.at < PLAN_WINDOW_TTL_MS) return;
  if (planWindowLoading) return;
  planWindowLoading = refreshPlanWindow()
    .then(() => {})
    .catch(() => {}) // DB 暂不可达：保持现值（冷启动=常量层），下轮再试
    .finally(() => { planWindowLoading = null; });
}

/** 原始规则读取（写入方的等值判断/后台展示用，不走缓存）。 */
export async function getPlanWindowRule(): Promise<PlanWindowRule | null> {
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${PLAN_WINDOW_KEY}`;
  return normalizeRule(rows[0]?.value ?? null);
}

/** 写入规则并同步本进程缓存（zhipuwatch 扫描解析公告后调用；每次落 updated_at）。 */
export async function savePlanWindowRule(rule: PlanWindowRule, actor = "system: zhipu-watch"): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${PLAN_WINDOW_KEY}, ${sql.json(rule as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  planWindowCache = { at: Date.now(), rule };
}

/** settings 层求值：北京日期在 [from,to]（含）且当日时刻在 daily 内（start>end=跨天）。
 *  规则缺日期面/时段即层内不生效（=摘窗态），绝不半程猜测。 */
export function planWindowRuleActive(rule: PlanWindowRule | null, now = Date.now()): boolean {
  if (!rule?.from || !rule?.to || !rule.daily) return false;
  const day = bjDate(now);
  if (day < rule.from || day > rule.to) return false;
  const start = hhmm(rule.daily.start);
  const end = hhmm(rule.daily.end);
  if (start === null || end === null) return false;
  const { minutes } = bjClock(now);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Zhipu plan window: from PLAN_WINDOW_FROM (2026-10-13 18:00) daily 18:00-09:00 (ym431), OR the
 *  settings-layer window (ym438; e.g. a parsed night free-window notice). The interim 23:00-09:00
 *  night window is retired by ym436 (owner directive 2026-10-08: the official night free-window
 *  activity 2026-09-03~10-07 expired with no extension, so night plan priority stops) — until the
 *  Tuesday switch every hour is free/MIMO. */
export const planActive = (now = Date.now()) => {
  ensurePlanWindowFresh();
  if (now >= PLAN_WINDOW_FROM) {
    const { minutes } = bjClock(now);
    if (minutes >= 18 * 60 || minutes < 9 * 60) return true;
  }
  return planWindowRuleActive(planWindowCache?.rule ?? null, now);
};

/** Free models + MIMO pay-as-you-go window (ym431): the plan window's complement. */
export const mimoShiftActive = (now = Date.now()) => !planActive(now);

/** Off-peak plan is live (from the effective date on). */
export const offpeakPlanLive = (now = Date.now()) => now >= OFFPEAK_EFFECTIVE_FROM;

/** MIMO daytime routing is live early (2026-09-30, "mimo顶上"); routing still requires the key. */
export const mimoEarlyLive = (now = Date.now()) => now >= MIMO_EARLY_FROM;
