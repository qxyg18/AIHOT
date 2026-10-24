// 智谱信号分类与窗口公告解析（ym438 S01/S03，纯函数）：扫描出刊的每条 zhipu_updates 行按
// kind/URL/正文分出一类路由信号——定价免费行=免费池候选；公告页=套餐/免费窗口规则；发布记录
// =模型发布（免费提示）。口径与 ym437 同宗：「失败即停不猜测」——窗口日期解析不出（多窗口/
// 无年份/无完整区间/无每日时段）一律拒写候人工，绝不落猜测结论；解析纯函数零 DB，便于判别测试。
import { mdPlain } from "./parse.ts";

export interface ParsedWindow {
  /** 生效起日（含）北京日期 YYYY-MM-DD。 */
  from: string;
  /** 生效止日（含）。 */
  to: string;
  /** 每日时段 HH:MM；start>end 表示跨天（如 23:00-09:00）。 */
  daily: { start: string; end: string };
}

export type WindowParse =
  | { status: "parsed"; window: ParsedWindow; evidence: string[] }
  | { status: "refused"; reason: string }
  | { status: "not-window" };

export type RoutingSignal =
  | { kind: "free_pool_candidate"; model: string; context: string | null; contextTokens: number | null; eligible: boolean; reason: string | null }
  | { kind: "window_rule"; parse: WindowParse }
  | { kind: "model_release"; freeHint: boolean }
  | { kind: "none" };

/** 自动接入的上下文门槛 = 路由闸（modelwatch/routing.ts 100K，ym436/ym441 口径）：低于闸的
 *  模型即使持证也不会被路由，自动接入它们只会白耗验收调用，故同闸。 */
export const MIN_ONBOARD_CONTEXT = 100_000;

/** 非文本对话家族（图像/视频生成、实时音视频、OCR、TTS、向量）不进免费文本验收队列。 */
const NON_CHAT_PATTERN = /cogview|cogvideo|realtime|\bocr\b|image|tts|embedding/i;

/** 定价行的窗口关键词（认窗不认「限时优惠」类模糊词，防误把促销页当窗口公告）。 */
const WINDOW_WORDS = /活动时间|畅用|免费窗口|免费时段/;

const pad2 = (s: string) => s.padStart(2, "0");
const num = (s: string) => String(Number(s));

/** 「200K」/「1M」/「128K」→ token 数；无数字（—、输入长度 [0, 32K) 取首个数字）解析不出返回 null。 */
export function contextTokensOf(context: string | null): number | null {
  if (!context) return null;
  const m = /(\d+(?:\.\d+)?)\s*([KkMm])/.exec(context);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(n * (m[2]!.toLowerCase() === "m" ? 1_000_000 : 1000));
}

/** 免费池入选口径（S02「智谱更新免费模型即自动接入」的可判面）：GLM-Flash 免费家族 + 文本对话
 *  名 + 上下文 ≥ 路由闸。不合口径不是错误，只留痕待人工（routing_action=pool_skipped）。 */
export function onboardEligible(model: string, contextTokens: number | null): { eligible: boolean; reason: string | null } {
  if (NON_CHAT_PATTERN.test(model)) return { eligible: false, reason: "非文本对话家族（图像/视频/实时/OCR/TTS/向量名）" };
  if (!/^glm-/i.test(model) || !/flash/i.test(model)) return { eligible: false, reason: "不在 GLM-Flash 免费家族命名面" };
  if (contextTokens === null) return { eligible: false, reason: "定价页未给可解析上下文，候人工" };
  if (contextTokens < MIN_ONBOARD_CONTEXT) return { eligible: false, reason: `上下文 ${contextTokens} 低于路由闸 ${MIN_ONBOARD_CONTEXT}` };
  return { eligible: true, reason: null };
}

/** 定价免费行的 payload.text 形态（parse.ts 落库形状）：`定价表行：| 模型 | 上下文 | 免费 | 免费 | … |`。 */
export function extractPricingRow(text: string): { model: string; context: string | null } | null {
  const body = text.replace(/^定价表行：/, "").trim();
  const raw = body.split("\n")[0]!.trim();
  if (!raw.startsWith("|")) return null;
  const cells = raw.split("|").map((c) => c.trim());
  if (cells.length < 6) return null;
  const model = cells[1] ?? "";
  if (!model || /^[-\s:]*$/.test(model)) return null;
  const context = cells[2] && cells[2] !== "" ? cells[2] : null;
  return { model, context };
}

// ---- 窗口公告解析 ----

/** 全年份区间「2026年9月3日至2026年10月7日」（空格已塌缩）。 */
const YEAR_RANGE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:至|到|~|—)(\d{4})年(\d{1,2})月(\d{1,2})日/g;
/** 无年份区间「9月3日至10月7日」（只做一致性核对，不单独作数——无年份即拒）。 */
const YEARLESS_RANGE_RE = /(\d{1,2})月(\d{1,2})日(?:至|到|~|—)(\d{1,2})月(\d{1,2})日/g;

/** 每日时段收集：HH:MM 形与「N 点」形，同一时段多次出现（正文+表格）只算一条。 */
function collectDailyHours(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:每日|每晚)(\d{1,2}):(\d{2})(?:至|到)(?:次日)?(\d{1,2}):(\d{2})/g)) {
    out.add(`${pad2(m[1]!)}:${m[2]}-${pad2(m[3]!)}:${m[4]}`);
  }
  for (const m of text.matchAll(/(?:每日|每晚)(\d{1,2})点(?:至|到)(?:次日)?(\d{1,2})点/g)) {
    out.add(`${pad2(m[1]!)}:00-${pad2(m[2]!)}:00`);
  }
  return out;
}

const monthDay = (mo: string, d: string) => `${num(mo)}月${num(d)}日`;

/** 窗口公告解析（S03 口径）：
 *  - 有全年份区间且仅一个 → 采信；无年份区间须与之一致（正文复述常见），不一致=多窗口歧义即拒；
 *  - 只有无年份区间 → 拒（无年份，人工确认年份口径）；
 *  - 页面有窗口关键词却无任何区间 → 拒（活动时间缺失）；
 *  - 每日时段缺失或多值 → 拒；
 *  - 无窗口关键词且无区间 → not-window（普通公告，不入窗口面）。 */
export function parseWindowNotice(raw: string): WindowParse {
  const text = raw.replace(/\s+/g, "");
  const yearFull = [...text.matchAll(YEAR_RANGE_RE)];
  const yearLess = [...text.matchAll(YEARLESS_RANGE_RE)];
  if (yearFull.length === 0 && yearLess.length === 0) {
    return WINDOW_WORDS.test(text)
      ? { status: "refused", reason: "公告带窗口关键词但没有可解析的起止日期区间（含无年份形），候人工确认" }
      : { status: "not-window" };
  }
  const distinct = new Set(yearFull.map((m) => `${m[1]}-${pad2(m[2]!)}-${pad2(m[3]!)}~${m[4]}-${pad2(m[5]!)}-${pad2(m[6]!)}`));
  if (distinct.size > 1) {
    return { status: "refused", reason: `页面有 ${distinct.size} 个活动日期区间（${[...distinct].join(" / ")}），多窗口歧义候人工` };
  }
  if (distinct.size === 0) {
    return { status: "refused", reason: `日期区间缺年份（${[...new Set(yearLess.map((m) => `${monthDay(m[1]!, m[2]!)}~${monthDay(m[3]!, m[4]!)}`))].join(" / ")}），候人工确认年份口径` };
  }
  const [range] = [...distinct];
  const [from, to] = range!.split("~") as [string, string];
  // 无年份区间须与全年份区间一致（正文「9 月 3 日至 10 月 7 日」复述同段活动）；不一致=歧义。
  const expect = `${monthDay(from.slice(5, 7), from.slice(8, 10))}~${monthDay(to.slice(5, 7), to.slice(8, 10))}`;
  for (const r of new Set(yearLess.map((m) => `${monthDay(m[1]!, m[2]!)}~${monthDay(m[3]!, m[4]!)}`))) {
    if (r !== expect) {
      return { status: "refused", reason: `页面另有与主区间不一致的日期（${r} vs ${expect}，如延期/历史说明），候人工确认生效口径` };
    }
  }
  const hours = collectDailyHours(text);
  if (hours.size === 0) return { status: "refused", reason: "窗口公告没有可解析的每日时段（如「每日 23:00 至次日 09:00」），候人工确认" };
  if (hours.size > 1) return { status: "refused", reason: `页面有多个每日时段（${[...hours].join(" / ")}），候人工确认` };
  const [start, end] = [...hours][0]!.split("-") as [string, string];
  return { status: "parsed", window: { from, to, daily: { start, end } }, evidence: [range, `${start}-${end}`] };
}

/** 行级信号分类（routing_action 的动作依据）。 */
export function classifyItem(row: { kind: string; url: string; title: string; text: string }): RoutingSignal {
  const text = row.text ?? "";
  if (row.kind === "pricing_change") {
    const parsed = extractPricingRow(text);
    const model = parsed?.model ?? (/^([^：]+)：/.exec(row.title)?.[1] ?? "");
    if (!model) return { kind: "none" };
    const context = parsed?.context ?? null;
    const contextTokens = contextTokensOf(context);
    const { eligible, reason } = onboardEligible(model, contextTokens);
    return { kind: "free_pool_candidate", model, context, contextTokens, eligible, reason };
  }
  // 免费窗口公告（定点页 kind=free_window）；sitemap 发现的 /notice/ 公告同样入窗口面。
  if (row.kind === "free_window" || (row.kind === "plan_promo" && /\/notice\//.test(row.url))) {
    return { kind: "window_rule", parse: parseWindowNotice(mdPlain(text)) };
  }
  if (row.kind === "model_release") {
    return { kind: "model_release", freeHint: /免费|free/i.test(`${row.title} ${text}`) };
  }
  return { kind: "none" };
}
