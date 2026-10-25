// OpenRouter 免费模型信源（2026-10-02 命主令）。/api/v1/models 是公开端点：pricing 的
// prompt/completion 都为 "0" 即当前免费。id 带 ":free" 后缀是常年免费档（每日限流，只陈列），
// 其余零价模型是限时免费窗口——「白嫖流量到免费到期」盯的就是它们。免费窗口没有结构化的
// 截止字段：描述里偶尔写 "free until …"（可缺省、可能滞后），真到期以价格翻正为准，所以
// 每轮都持续更新。Key 只从凭据文件/环境读（models.env，本站明文保存，命主口径）。
import { credential } from "../config.ts";
import { buildLlmRequest, replyText } from "../providers/llmEndpoint.ts";
import { paidRequest } from "../providers/receipts.ts";
import { sha256 } from "../lib/ids.ts";

/** 探针收据按自然日换键：同一模型每天最多一次真实调用（d-ym575-probe-receipt-replay 拍板 opt-fresh）。 */
const PROBE_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

export function openRouterBaseUrl(): string {
  return credential("models", "OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1";
}

export function openRouterConfigured(): boolean {
  return !!credential("models", "OPENROUTER_API_KEY");
}

export interface OrModel {
  id: string;
  name: string;
  vendor: string;
  tier: "promo" | "free_tier";
  contextLength: number;
  supportsVision: boolean;
  supportsJson: boolean;
  /** ym249: the model accepts text input (a music/image-only model is not an article worker). */
  supportsText: boolean;
  /** ym249: provider-declared completion cap (null = the catalog did not say). */
  outputLimit: number | null;
  promptPrice: string;
  completionPrice: string;
  /** 描述里写明的免费截止（YYYY-MM-DD），没有则 null。 */
  freeUntilHint: string | null;
}

export interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; modality?: string; output_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: { prompt?: string; completion?: string };
}

function priceNumber(v: string | undefined): number {
  const n = parseFloat(v ?? "nan");
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 免费判定：输入输出都为零价（字符串数值，"0"/"0.0" 均算，"0.000001" 不算）。
 *  ym249 口径补充：OpenRouter 以 "-1" 表示「按请求计价」——非零，与缺字段（NaN）一样不判免费；
 *  两栏都必须是有限数值的零，才算目录完整价格下的免费。 */
export function isFreePricing(raw: RawModel): boolean {
  const p = priceNumber(raw.pricing?.prompt);
  const c = priceNumber(raw.pricing?.completion);
  return p === 0 && c === 0;
}

export function tierOfOpenRouter(id: string): "promo" | "free_tier" {
  return id.endsWith(":free") ? "free_tier" : "promo";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 从描述里解析免费截止：支持 ISO（2026-10-10）、英文月份（October 10th, 2026 / Oct 10）、
 *  中文（免费至10月10日/2026年10月10日）。缺年份按「今年，已过则明年」补。解析不出返 null。
 *  双实现注意：宿主侧 agent-hub scripts/hub_board/openrouter_watch.py 有 Python 镜像版，
 *  改动须同步对端，防两端口径分叉。 */
export function parseFreeUntil(description: string | undefined): string | null {
  const text = description ?? "";
  let m = /free until\s+(\d{4})-(\d{2})-(\d{2})/i.exec(text) || /[免费白嫖]至\s*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(text);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = new RegExp(`free until\\s+([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (m) {
    const idx = MONTHS.findIndex((x) => x.startsWith(m![1]!.toLowerCase().slice(0, 3)));
    if (idx >= 0) {
      const now = new Date();
      let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
      if (!m[3] && new Date(Date.UTC(year, idx, Number(m[2]))) < now) year += 1;
      return isoDate(year, idx + 1, Number(m[2]));
    }
  }
  m = /[免费白嫖][至到]\s*(\d{1,2})月(\d{1,2})日/.exec(text);
  if (m) {
    const now = new Date();
    let year = now.getUTCFullYear();
    if (new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]))) < now) year += 1;
    return isoDate(year, Number(m[1]), Number(m[2]));
  }
  return null;
}

export function toOrModel(raw: RawModel): OrModel {
  const modalities = raw.architecture?.input_modalities ?? [];
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    vendor: raw.id.includes("/") ? raw.id.split("/")[0]! : "",
    tier: tierOfOpenRouter(raw.id),
    contextLength: raw.context_length ?? 0,
    supportsVision: modalities.includes("image") || /image/.test(raw.architecture?.modality ?? ""),
    supportsText: modalities.length === 0 || modalities.includes("text") || /text/.test(raw.architecture?.modality ?? ""),
    outputLimit: raw.top_provider?.max_completion_tokens ?? null,
    supportsJson: (raw.supported_parameters ?? []).includes("response_format"),
    promptPrice: raw.pricing?.prompt ?? "",
    completionPrice: raw.pricing?.completion ?? "",
    freeUntilHint: parseFreeUntil(raw.description),
  };
}

/** ym249: an empty or missing catalog is a broken/stale directory, not "everything stopped being free" —
 *  throwing lets the scan skip the end-verdict pass instead of retiring every watched model. */
export class CatalogEmptyError extends Error {}

/** 当前在免费窗口内的全部模型（公开端点，无 key 也能拉）。 */
export async function listOpenRouterModels(fetcher: typeof fetch = fetch): Promise<OrModel[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = credential("models", "OPENROUTER_API_KEY");
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetcher(`${openRouterBaseUrl()}/models`, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { data?: RawModel[] };
  if (!Array.isArray(json.data) || json.data.length === 0) throw new CatalogEmptyError(`OpenRouter /models returned ${json.data ? "an empty" : "no"} catalog`);
  return json.data.filter((r) => r.id && isFreePricing(r)).map(toOrModel);
}

// ---- 质量探针 ----
// ym249 口径修订：探测调用与业务调用同受回执/预算约束（卡面「受同一回执预算约束的零费策略」）——
// 每次探测都落 receipts/receipt_attempts（service=openrouter），budgets 缺行即拒绝（POST=0）；
// 发送时同样强制 server 零价 policy。两项任务对应站内两类负载：结构化 JSON 输出与中文短摘要。

export interface ProbeTaskResult {
  ok: boolean;
  ms: number;
  error: string | null;
  sample: string | null;
}

export interface ProbeResult {
  at: string;
  json: ProbeTaskResult;
  summary: ProbeTaskResult;
}

async function oneCall(model: string, system: string, user: string, fetcher: typeof fetch): Promise<{ text: string; ms: number }> {
  const wire = buildLlmRequest({
    baseUrl: openRouterBaseUrl(),
    apiKey: credential("models", "OPENROUTER_API_KEY") ?? "",
    model,
    system,
    user,
    temperature: 0.2,
    maxTokens: 400,
    jsonMode: false,
    // 探针与业务同口径：allow（命主 2026-10-20 决定），否则需训练同意的免费模型探针恒 404。
    policy: { serverMaxPrice: 0, requireParameters: true, dataPolicy: "allow" },
  });
  const started = Date.now();
  const receipt = await paidRequest(
    {
      service: "openrouter",
      model,
      purpose: "modelwatch.probe",
      subject: `probe:${model}`,
      // 日期入键：同一模型每天真实调用一次，其余重复轮次才走回放（否则首轮通过后永远回放）。
      attemptTag: `day-${PROBE_DAY.format(new Date())}`,
      identity: { probe: "connectivity", system: sha256(system), user: sha256(user), maxTokens: 400 },
      requestSummary: { probe: true, maxTokens: 400 },
      requireBudget: true,
      reservedTokens: { input: Math.ceil((system.length + user.length) / 2), output: 400 },
    },
    async () => {
      const res = await fetcher(wire.url, { method: "POST", headers: wire.headers, body: wire.body, signal: AbortSignal.timeout(45_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { response: JSON.parse(text) as Record<string, unknown>, cost: null, costEvidence: { basis: "provider-routing", serverMaxPrice: 0, model, probe: true } };
    },
  );
  return { text: replyText(receipt.response as Record<string, unknown>), ms: Date.now() - started };
}

const JSON_TASK_USER =
  '把下面这句话整理成一个 JSON 对象输出（不要多余文字）：字段 title 是事件标题（字符串），字段 brand 是品牌名（字符串）。句子：巴拉巴拉童装十月在杭州龙湖天街开出全国第 100 家门店。';
const SUMMARY_TASK_USER = "用一句通顺的中文概括：入冬以来儿童羽绒服在北方多城热销，多家童装品牌反馈补货周期从一周拉长到三周。";

/** 质量探针：JSON 结构化任务 + 中文摘要任务各一次。 */
export async function probeOpenRouterModel(model: string, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const at = new Date().toISOString();
  const wrap = async (task: () => Promise<{ text: string; ms: number }>, check: (t: string) => boolean): Promise<ProbeTaskResult> => {
    try {
      const { text, ms } = await task();
      const ok = check(text.trim());
      return { ok, ms, error: ok ? null : "回复不合格式", sample: text.trim().slice(0, 120) };
    } catch (error) {
      return { ok: false, ms: 0, error: String(error).slice(0, 200), sample: null };
    }
  };
  const json = await wrap(
    () => oneCall(model, "你是 JSON 输出器，只输出 JSON 对象本身。", JSON_TASK_USER, fetcher),
    (t) => {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start === -1 || end <= start) return false;
      try {
        const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
        return typeof obj.title === "string" && typeof obj.brand === "string";
      } catch {
        return false;
      }
    },
  );
  const summary = await wrap(
    () => oneCall(model, "你是中文编辑，用一句通顺的中文回答。", SUMMARY_TASK_USER, fetcher),
    (t) => /[\u4e00-\u9fa5]/.test(t) && t.length >= 8,
  );
  return { at, json, summary };
}

export type AutoVerdict = "good" | "simple" | "unusable";

/** 探针 → 自动判定：两项都过=good；只有摘要过关（结构化不稳）=simple；全不过=unusable。 */
export function verdictOfProbe(p: ProbeResult): AutoVerdict {
  if (p.json.ok && p.summary.ok) return "good";
  if (p.summary.ok || p.json.ok) return "simple";
  return "unusable";
}
