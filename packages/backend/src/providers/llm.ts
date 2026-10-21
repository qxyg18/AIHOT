// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { llmOverrides } from "../admin/llmconfig.ts";
import { buildLlmRequest, isAnthropicEndpoint, replyText, usageOf } from "./llmEndpoint.ts";
import { sha256 } from "../lib/ids.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse, BudgetExceededError, ReceiptBusyError, ReceiptUnknownError } from "./receipts.ts";
import { isMimoBalanceError, openMimoCircuit } from "./mimo.ts";
import { isFreeAccountQuotaError, PROVIDER_MODELS, routeForPurpose, routerReport, type ProviderKey } from "./api-router.ts";
import { freeRoutingSnapshot, openOpenRouterCircuit, OPENROUTER_FREE_KEY } from "../modelwatch/routing.ts";
import { openZhipuCircuit, ZHIPU_FREE_KEY } from "./zhipu.ts";
import { callOpencode, isOpencodeChannelFailure, openOpencodeCircuit, opencodeConfigured, opencodeTransport, OPENCODE_FREE_KEY } from "./opencode.ts";
import { capabilityForPurpose } from "../modelwatch/capability-routing.ts";
import { sql } from "../db.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  // 免费模型信源监控（命主 2026-10-02）：实际模型 id 在调用时从监控路由快照解析（免费窗口
  // 会换模型，预设键不变）；候选取「主力 + 替补（上一任仍免费的模型）」。
  [OPENROUTER_FREE_KEY]: {
    key: OPENROUTER_FREE_KEY, service: "openrouter",
    get model() { const r = freeRoutingSnapshot(); return r.primary ?? r.simple ?? ""; },
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    jsonMode: true,
  },
  // 智谱免费通道（ym436 命主令 2026-10-08）：官方双证免费家族（GLM-4.7-Flash 200K 起步），
  // 走通用 paas/v4 端点；免费=按并发限流不按日次（与 OpenRouter 免费池 50 次/日互补）。
  // 实际模型 id 由证书路由钉选/快照解析（zhipu: 前缀成员去前缀发请求）；无证书时回退
  // ym438 免费池首位（settings zhipuwatch.pool；池为追加序，首位=最早入池者，回退取稳定
  // 老模型；池空兜底 glm-4.7-flash=ym436 落地态）。
  [ZHIPU_FREE_KEY]: {
    key: ZHIPU_FREE_KEY, service: "zhipu-free",
    get model() {
      const snap = freeRoutingSnapshot();
      const hit = Object.values(snap.capabilityRoute).flat().find((r) => r.channel === "zhipu");
      return hit ? hit.model.replace(/^zhipu:/, "") : (snap.zhipuPool[0] ?? "glm-4.7-flash");
    },
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  // opencode 免费档通道（ym467 命主拍板 A 承接）：宿主 opencode serve 中介，容器经
  // host.docker.internal 访问（Basic 鉴权，密码=OPENCODE_SERVER_PASSWORD）；出文零计费。
  // 实际模型 id 由证书路由钉选/快照解析（opencode: 前缀成员去前缀作 modelID）；无证书时
  // 回退 opencodewatch.pool 首位；池空=无回退，走「无可跑模型」分支（同 OpenRouter 口径）。
  // 线协议非 OpenAI（POST /session/{id}/message，parts 文本）——callOpencode 内归一到
  // choices[0].message.content 供下游单形消费；无 response_format，JSON 走提示词+extractJson
  // （与 Anthropic 面同口径）。
  [OPENCODE_FREE_KEY]: {
    key: OPENCODE_FREE_KEY, service: "opencode-free",
    get model() {
      const snap = freeRoutingSnapshot();
      const hit = Object.values(snap.capabilityRoute).flat().find((r) => r.channel === "opencode");
      return hit ? hit.model.replace(/^opencode:/, "") : (snap.opencodePool[0] ?? "");
    },
    baseUrlEnv: "OPENCODE_SERVE_URL", apiKeyEnv: "OPENCODE_SERVER_PASSWORD",
    jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** ym450：智谱免费面的 max_tokens 硬上限——glm-4-flash-250414 生产 400/1210「限制数值范围
 *  [1,16384]」；免费家族候选的思考余量（+4000）在此夹取（understand 位 16384+4000=20384
 *  越界即生产实证）。非智谱候选不受影响。 */
const ZHIPU_FREE_MAX_TOKENS = 16_384;

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** ym196：钉死免费预设的实际模型 id（能力验收测试对指定模型打分用）；ym436 起两个免费
   *  预设（OPENROUTER_FREE_KEY / ZHIPU_FREE_KEY）均生效，zhipu: 前缀自动去前缀。 */
  pinnedModel?: string;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

/** 供应商预设键 → 路由供应商位（非路由预设返回 null，不上报健康态）。 */
const providerOf = (key: string): ProviderKey | null =>
  key === PROVIDER_MODELS.free ? "free" : key === PROVIDER_MODELS.mimo ? "mimo" : key === PROVIDER_MODELS.glm ? "glm" : null;

/** 供应商级失败分类（ym350 切换判据）：断链/账户级配额/非重试 4xx 立即切；429/5xx 记连续
 *  异常（跨满 5 分钟才切，当日粘性）。 */
function rejectKind(error: ProviderRejectedError): "connect" | "quota" | "hard" | "streak" {
  if (error.status == null && error.retryable && error.message.startsWith("connect failed")) return "connect";
  if (isFreeAccountQuotaError(error.status, error.message) || isMimoBalanceError(error.status, error.message)) return "quota";
  if (error.status != null && error.status >= 400 && error.status < 500 && error.status !== 429 && !error.retryable) return "hard";
  return "streak";
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const first = MODELS[opts.model];
  if (!first) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  // ym350 统一接口路由：purpose 反查能力位→供应商权重链——路由关/无能力位/显式指派/钉选
  // 时链=单模型（与旧行为等价）；供应商级失败按判据切换下一供应商。ym249 双发护栏
  // （unknown/busy/budget 停车不转移）原样保留；垃圾输出（ModelOutputError）换供应商
  // 重答本次但不记接口异常。
  const chain = await routeForPurpose(opts.purpose, opts.model, { pinned: !!opts.pinnedModel });
  let lastError: unknown;
  for (const key of chain) {
    const spec = MODELS[key];
    if (!spec) continue;
    try {
      const r = await chatJsonWithSpec(opts, spec);
      const provider = providerOf(key);
      if (provider) await routerReport(provider, { ok: true });
      return r;
    } catch (error) {
      if (error instanceof ReceiptUnknownError || error instanceof ReceiptBusyError || error instanceof BudgetExceededError) throw error;
      lastError = error;
      if (error instanceof ProviderRejectedError) {
        const provider = providerOf(key);
        if (provider) await routerReport(provider, { ok: false, kind: rejectKind(error), status: error.status, message: error.message });
      }
    }
  }
  throw lastError;
}

/** One provider's attempt (ym350: the pre-routing chatJson body — one call per supplier in the
 *  chain; free presets still expand into their own cross-channel candidate list inside). */
async function chatJsonWithSpec<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec): Promise<ChatJsonResult<z.infer<S>>> {
  // The default endpoint additionally takes the admin override (settings `llm.config`), which wins
  // over env/credentials-file; named presets keep their own keys.
  const override = spec.key === "default" ? await llmOverrides() : null;
  const baseUrl = override?.baseUrl?.trim() || credential("models", spec.baseUrlEnv);
  const apiKey = override?.apiKey?.trim() || credential("models", spec.apiKeyEnv);
  const model = override?.model?.trim() || spec.model;
  // ym196：能力路由钉选/测试钉选的目标模型先算出来——免费预设的 getter 依赖快照（快照空≠
  // 不能调），有钉选目标即视为已配置。ym436/ym467：三个免费预设各按能力位钉选，且只认本通道的
  // 证书成员（zhipu: 智谱 paas/v4；opencode: 客户端中介免费档；其余=openrouter）；钉选目标带
  // 通道前缀时去前缀发请求（zhipu: / opencode: 两种前缀）。
  const freeChannel = spec.key === ZHIPU_FREE_KEY ? ("zhipu" as const) : spec.key === OPENCODE_FREE_KEY ? ("opencode" as const) : spec.key === OPENROUTER_FREE_KEY ? ("openrouter" as const) : null;
  const capHit = freeChannel ? capabilityForPurpose(opts.purpose) : null;
  const wantChannel = freeChannel ?? "openrouter";
  const pinned = capHit
    ? freeRoutingSnapshot().capabilityRoute[capHit.capability]?.find((r) => (!capHit.vision || r.vision) && (r.channel ?? "openrouter") === wantChannel)?.model
    : undefined;
  const stripChannelPrefix = (m: string) => m.replace(/^(zhipu|opencode):/, "");
  const target = stripChannelPrefix(opts.pinnedModel ?? pinned ?? model);

  const temperature = opts.temperature ?? 0.2;
  // Reasoning models burn output budget on thinking tokens (GLM 5.3 always reasons;
  // its Anthropic layer ignores thinking:disabled — ka4). Any spec with thinking
  // explicitly enabled gets the same headroom as the "-think" variants.
  const specExtra = (spec.extra ?? {}) as { thinking?: { type?: string }; enable_thinking?: boolean };
  const thinkingOn = specExtra.thinking?.type === "enabled" || specExtra.enable_thinking === true;
  // ym436：智谱免费家族 4.7-flash/z1-flash 是推理型，thinking:disabled 未必被端点尊重
  // （ka4 同型教训）——智谱通道的候选恒给思考余量（按候选所属通道算，跨通道兜底时同样
  // 成立），防结构化输出被 reasoning 吃光后截断。
  const baseMaxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") || thinkingOn ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  // ym450：带图请求（ContentPart[]）落到免费三通道时按纯文本降级——智谱 paas/v4 只收 text
  // part（生产 400/1210 content.type）、OpenRouter 免费端点无图像输入（404 image input）、
  // opencode 线协议只发文本；与 analyze 的「模型拒图后改发文本」同语义，但不再先浪费一发
  // 被拒请求。降级在回执 requestSummary 留痕（imageDropped）。钉选调用（认证/探针）保持
  // 请求形状原样——认证的 image variant 就是测目标模型在真实线上的图像接受面。
  const imageRequested = Array.isArray(opts.user);
  const textOnlyUser = imageRequested ? (opts.user as ContentPart[]).map((p) => (p.type === "text" ? p.text : "")).join("") : userText;

  // 候选链：免费模型「能力路由钉选 > 主力」+ 替补（切换免费模型时上一任留作替补，命主
  // 2026-10-02）；测试钉选（pinnedModel）优先级最高。其余模型单候选。各候选各记各的回执。
  // ym436：本通道成员垫后（智谱 1305 平台过载时换下一个智谱成员再试）。
  // ym441（命主 2026-10-08 免费优先令 + 免费内部多路由断链兜底）：免费预设候选链跨通道
  // 扩展——本通道成员之后垫另一免费通道的证书成员（zhipu↔openrouter），整链失败才把错
  // 抛给上层落付费；ym467 三通道化：垫链按固定序 [zhipu, openrouter, opencode] 取本通道
  // 之外的其余通道（智谱优先口径在垫链仍先行）；端点/凭据/服务名/熔断按候选所属通道解析。
  // 测试钉选（pinnedModel）是认证契约（证书必须反映被钉模型自身能力），钉选调用不跨通道、保持单通道链。
  const snap = freeRoutingSnapshot();
  type FreeCh = "zhipu" | "openrouter" | "opencode";
  const membersOf = (ch: FreeCh) =>
    [...new Set(Object.values(snap.capabilityRoute).flat().filter((r) => (r.channel ?? "openrouter") === ch).map((r) => stripChannelPrefix(r.model)))];
  const zhipuMembers = membersOf("zhipu");
  const orMembers = membersOf("openrouter");
  const ocMembers = membersOf("opencode");
  interface FreeCandidate { model: string; channel: FreeCh | null }
  const dedup = (models: string[]) => models.filter((m, i, a) => !!m && a.indexOf(m) === i);
  const chained = (own: FreeCh) =>
    opts.pinnedModel
      ? []
      : (["zhipu", "openrouter", "opencode"] as const)
          .filter((c) => c !== own)
          .flatMap((c) => (c === "zhipu" ? zhipuMembers : c === "openrouter" ? orMembers : ocMembers).map((m) => ({ model: m, channel: c })));
  const candidates: FreeCandidate[] =
    spec.key === OPENROUTER_FREE_KEY
      ? [
          ...dedup([target, snap.fallback ?? ""]).map((m) => ({ model: m, channel: "openrouter" as const })),
          ...chained("openrouter"),
        ]
      : spec.key === ZHIPU_FREE_KEY
        ? [
            ...dedup([target, ...zhipuMembers]).map((m) => ({ model: m, channel: "zhipu" as const })),
            ...chained("zhipu"),
          ]
        : spec.key === OPENCODE_FREE_KEY
          ? [
              ...dedup([target, ...ocMembers]).map((m) => ({ model: m, channel: "opencode" as const })),
              ...chained("opencode"),
            ]
          : [{ model, channel: null }];
  // 各候选按所属通道解析端点/凭据/服务名/extra（跨通道兜底时与发起预设不同）；非免费预设
  // 候选（channel=null）沿用预设解析结果（含 default 的 admin override）。opencode 面
  // apiKey 位承载 OPENCODE_SERVER_PASSWORD（Basic 鉴权密码，callOpencode 内组头）；无宿主
  // 凭据时该通道走直连公共网关（Magpie opencode-2-free 同款），因此不要求两条凭据都在。
  const credsOf = (c: FreeCandidate) =>
    c.channel === "zhipu"
      ? { baseUrl: credential("models", "ZHIPU_BASE_URL"), apiKey: credential("models", "ZHIPU_API_KEY") }
      : c.channel === "openrouter"
        ? { baseUrl: credential("models", "OPENROUTER_BASE_URL"), apiKey: credential("models", "OPENROUTER_API_KEY") }
        : c.channel === "opencode"
          ? { baseUrl: credential("models", "OPENCODE_SERVE_URL"), apiKey: credential("models", "OPENCODE_SERVER_PASSWORD") }
          : { baseUrl, apiKey };
  const serviceOf = (c: FreeCandidate) => (c.channel === "zhipu" ? "zhipu-free" : c.channel === "openrouter" ? "openrouter" : c.channel === "opencode" ? "opencode-free" : spec.service);
  const extraOf = (c: FreeCandidate): Record<string, unknown> | undefined =>
    c.channel === "zhipu" ? MODELS[ZHIPU_FREE_KEY]!.extra : c.channel === "openrouter" ? MODELS[OPENROUTER_FREE_KEY]!.extra : c.channel === "opencode" ? undefined : spec.extra;
  const runnable = candidates.filter((c) => {
    if (c.channel === "opencode") return !!c.model && opencodeConfigured();
    const creds = credsOf(c);
    return !!c.model && !!creds.baseUrl && !!creds.apiKey;
  });
  if (runnable.length === 0) {
    // 免费预设：本通道凭据缺失照旧报「未配置」；凭据在而链空=快照空/熔断（上层应已落付费）。
    const free = spec.key === OPENROUTER_FREE_KEY || spec.key === ZHIPU_FREE_KEY || spec.key === OPENCODE_FREE_KEY;
    if (!free || !(baseUrl && apiKey)) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);
    throw new Error(`Model ${opts.model} has no free model to run (modelwatch.routing empty or circuit open; this call should have fallen back to the regular routing)`);
  }

  let lastError: unknown;
  // ym436：while 游标形态——仅智谱候选的显式 429（并发限流，1305 平台过载即此类）同一
  // 候选原地补试至多 2 次（2s 退避）。1305 晚高峰实测高发（4 发 1 中），不补试会误伤能力
  // 验收（10 样本挂 2 个即跌破 9/10 合格线）；5xx 与 OpenRouter 面保持 ym249「可重试拒绝=
  // 换候选」语义。已判失败的 attempt 与换候选同机制再入同一 operationKey（ym249 只拦
  // unknown/busy/budget 三类）。
  let ci = 0;
  let retriesLeft = 2; // 每个智谱候选各带 2 次原地补试（换候选即重置）
  while (ci < runnable.length) {
    const candidate = runnable[ci]!;
    const creds = credsOf(candidate);
    const candService = serviceOf(candidate);
    const candMaxTokens = candidate.channel === "zhipu" ? Math.min(baseMaxTokens + 4000, ZHIPU_FREE_MAX_TOKENS) : baseMaxTokens;
    // ym450：免费候选无图像接受面（按候选所属面判）——带图请求降级为纯文本 + 回执留痕；
    // 钉选（认证/探针）与非免费候选保持请求形状原样。
    const degradeImage = imageRequested && !opts.pinnedModel && candidate.channel !== null;
    const candUser = degradeImage ? textOnlyUser : opts.user;
    const candExtra = extraOf(candidate);
    const freeOnly = candidate.channel !== null;
    // ym467：opencode 面不走 OpenAI/Anthropic 线（callOpencode 自建会话线：POST /session →
    // /message → DELETE）；ym249 policy（OpenRouter 服务端价格上限/数据政策）不适用于
    // 客户端中介面——免费依据=平台免费档经官方客户端实发，零计费由渠道本身保证
    // （costEvidence 记 free-tier-client）。
    const wire = candidate.channel === "opencode"
      ? null
      : buildLlmRequest({
          baseUrl: creds.baseUrl!,
          apiKey: creds.apiKey!,
          model: candidate.model,
          system: opts.system,
          user: candUser,
          temperature,
          maxTokens: candMaxTokens,
          jsonMode: spec.jsonMode && opts.json !== false,
          extra: candExtra,
          // 免费通道数据政策=allow（命主 2026-10-20 决定允许供应商训练/留存；deny 会挡住需训练同意的免费端点）。
          ...(freeOnly
            ? { policy: { serverMaxPrice: 0, requireParameters: true, dataPolicy: "allow" } }
            : {}),
        });
    try {
      const receipt = await paidRequest(
        {
          service: candService,
          model: candidate.model,
          purpose: opts.purpose,
          subject: opts.subject,
          identity: { model: candidate.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens: candMaxTokens, extra: (isAnthropicEndpoint(creds.baseUrl ?? "") ? null : candExtra) ?? null },
          requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens: candMaxTokens, ...(degradeImage ? { imageDropped: true } : {}) },
          attemptTag: opts.attemptTag,
          // ym249: free-only calls are one operation across candidate models — the operation key carries no
          // model, so an unknown first attempt blocks the fallback candidate inside paidRequest already.
          ...(freeOnly
            ? {
                operationKey: [spec.service, opts.purpose, opts.subject, opts.promptVersion, sha256(`${opts.system}\n${userText}`), opts.attemptTag ?? "0"].join(":"),
                reservedTokens: { input: Math.ceil((opts.system.length + userText.length) / 2), output: candMaxTokens },
                requireBudget: true,
              }
            : {}),
        },
        async () => {
          const started = Date.now();
          // ym467：opencode 候选经客户端中介出文（内部完成会话建/发/删三段），响应归一到
          // OpenAI 形（choices[0].message.content + usage）供下游 replyText/usageOf 单形消费。
          // ym20261020：无宿主凭据时 callOpencode 走直连公共网关（同一上游、同一模型 id），
          // 站点侧仍是普通非流式消费（SSE 在通道层折叠）。
          if (candidate.channel === "opencode") {
            const oc = await callOpencode({
              baseUrl: creds.baseUrl ?? "",
              password: creds.apiKey ?? "",
              model: candidate.model,
              system: opts.system,
              user: typeof candUser === "string" ? candUser : userText,
              maxTokens: candMaxTokens,
              temperature,
              sessionSeed: `${opts.purpose}:${opts.subject}`,
              timeoutMs: opts.timeoutMs ?? 120_000,
              transport: opencodeTransport(),
            });
            return {
              response: { ...oc.response, _latencyMs: Date.now() - started },
              requestId: oc.requestId,
              usage: oc.usage,
              cost: null,
              costEvidence: { basis: oc.transport === "direct" ? "free-tier-public" : "free-tier-client", transport: oc.transport, model: candidate.model, priced: false } as Record<string, unknown>,
            };
          }
          let res: Response;
          try {
            res = await fetch(wire!.url, {
              method: "POST",
              signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
              headers: wire!.headers,
              body: wire!.body,
            });
          } catch (error) {
            if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
            throw error;
          }
          const text = await res.text();
          if (!res.ok) {
            const retryable = res.status === 429 || res.status >= 500;
            throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
          }
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(text);
          } catch {
            json = { unparsable: text.slice(0, 20000) };
          }
          const usage = usageOf(json);
          return {
            response: { ...json, _latencyMs: Date.now() - started },
            requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
            usage,
            cost: null,
            ...(freeOnly ? { costEvidence: { basis: "provider-routing", serverMaxPrice: 0, model: candidate.model, priced: false } as Record<string, unknown> } : {}),
          };
        },
      );
      const response = receipt.response as Record<string, unknown>;
      const content = replyText(response);
      let parsed: z.infer<S>;
      try {
        parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
      } catch (error) {
        // Unusable output: record it and let a later attempt pay for a fresh answer.
        await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
        throw new ModelOutputError(`Model ${candidate.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`);
      }
      return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: usageOf(response) ?? null };
    } catch (error) {
      // ym249: unknown/busy/budget stop the candidate chain immediately — switching models on an
      // in-doubt or throttled operation is exactly the double-send the operation key guards against.
      if (error instanceof ReceiptUnknownError || error instanceof ReceiptBusyError || error instanceof BudgetExceededError) throw error;
      // ka3: a balance-type MIMO rejection opens the circuit, so the daytime shift stops calling it
      // for two hours and heavy work waits for the discounted window again.
      if (spec.service === "mimo" && error instanceof ProviderRejectedError && isMimoBalanceError(error.status, error.message)) {
        await openMimoCircuit(error.message);
      }
      // 免费通道余额/配额类拒绝开 30 分钟熔断（期内视同该通道无免费模型）：按候选所属通道
      // 判——跨通道兜底时熔断的必须是真正失败的那条通道（ym249 原为 openrouter 预设专属）。
      // OpenRouter 面把账户日次墙（free-models-per-day 429，账号级 50 次/日）也计为通道级
      // 失败（ym441：撞墙=该通道当日不可用，候选链转智谱，不反复打墙）。
      let burnedChannel: "openrouter" | "zhipu" | "opencode" | null = null;
      if (candidate.channel === "openrouter" && error instanceof ProviderRejectedError && (isMimoBalanceError(error.status, error.message) || isFreeAccountQuotaError(error.status, error.message))) {
        await openOpenRouterCircuit(error.message);
        burnedChannel = "openrouter";
      }
      // ym436：智谱免费通道同口径（1113/402 类=凭据或计费面变化；正常免费模型不触发，
      // 1305 过载走上面的原地补试不进熔断面）。
      if (candidate.channel === "zhipu" && error instanceof ProviderRejectedError && isMimoBalanceError(error.status, error.message)) {
        await openZhipuCircuit(error.message);
        burnedChannel = "zhipu";
      }
      // ym467：opencode 通道级失败开熔断——客户端不可达（status=null，独立熔断因）/鉴权面
      // （401/403）/API 形状漂移（404）/免费闸与账户面措辞（判据见 isOpencodeChannelFailure）；
      // 429（客户端排队）与 5xx 不进熔断面，交给候选链换下一个。
      if (candidate.channel === "opencode" && error instanceof ProviderRejectedError && isOpencodeChannelFailure(error.status, error.message)) {
        await openOpencodeCircuit(error.message);
        burnedChannel = "opencode";
      }
      // ym436：仅智谱候选 + 显式 429（并发限流/1305 过载）原地补试——5xx 与 OpenRouter 面保持
      // ym249 语义（可重试拒绝=换下一个候选，不原地重发，预算契约「每候选一发」不变）。
      // 销项 P3-4（shoumen）：余额类拒绝（1113/402 措辞）不补试——熔断已判停 30 分钟，
      // 原地重打是 doomed 调用，直接换下一候选把错抛上去。
      if (candidate.channel === "zhipu" && error instanceof ProviderRejectedError && error.status === 429 && retriesLeft > 0 && !isMimoBalanceError(error.status, error.message)) {
        retriesLeft--;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      lastError = error; // 还有替补就换替补再试；最后一个候选把错误抛给上层。
      ci++; // 该候选耗尽（或错误不可重试），换下一个
      // ym441：该通道已被余额/配额类判停——跳过同通道剩余候选，直接转另一免费通道
      // （「整通道失败不落付费」的完整路径：否则会把同通道成员逐个打死后才跨通道）。
      while (burnedChannel && ci < runnable.length && runnable[ci]!.channel === burnedChannel) ci++;
      retriesLeft = 2;
    }
  }
  throw lastError;
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
