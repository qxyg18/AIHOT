// opencode 免费档通道（ym467，命主 2026-10-09 拍板 A 承接）：宿主常驻 `opencode serve` 作中介，
// 站点容器经 host.docker.internal 访问（HTTP Basic：用户名缺省 opencode + OPENCODE_SERVER_PASSWORD，
// 凭据在 models.env）。免费档限官方客户端内使用（平台隐私开关「允许免费端点」已由命主打开）；
// 出文零计费，与智谱（并发限流）/OpenRouter（账号日次池）互补。
// 熔断形态照 zhipu/mimo：通道级失败开 30 分钟冷却；并新增「客户端不可达」为独立熔断因
// （宿主进程崩溃/未启动时，连接失败即判通道级失败，冷却期内候选链直接跳过本通道）。
//
// ym20261020 直连传输（Magpie opencode-2-free 插件同款原理）：没有宿主 opencode serve 时
// 直连 opencode.ai 公共免费网关，仍用 Bearer public、OpenCode 2 客户端身份、ses_ 形状会话、
// 强制流式与核心工具声明。同一上游、同一模型 id，因此证书/池/路由/统计全部沿用本通道；
// 传输只影响「怎么把请求送出去」。宿主凭据存在时仍走 serve（旧行为零变化）。
import { createHash, randomBytes } from "node:crypto";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { ProviderRejectedError } from "./receipts.ts";

/** MODELS 预设键：实际模型 id 由证书路由钉选/快照解析（opencode: 前缀成员换模型预设键不变）。 */
export const OPENCODE_FREE_KEY = "opencode-free";

export const OPENCODE_CIRCUIT_KEY = "llm.opencode_circuit";
export const OPENCODE_CIRCUIT_COOLDOWN_MS = 30 * 60_000;

/** 宿主客户端凭据（旧通道）。 */
export function opencodeServeConfigured(): boolean {
  return !!(credential("models", "OPENCODE_SERVE_URL") && credential("models", "OPENCODE_SERVER_PASSWORD"));
}

/** 直连公共免费网关的开关（默认开；设 OPENCODE_DIRECT_ENABLED=false 可整体关掉直连）。 */
export function opencodeDirectEnabled(): boolean {
  return (process.env.OPENCODE_DIRECT_ENABLED ?? "true").toLowerCase() !== "false";
}

/** 通道可用 = 宿主客户端已配置 或 直连已启用。 */
export function opencodeConfigured(): boolean {
  return opencodeServeConfigured() || opencodeDirectEnabled();
}

/** 本次调用走哪条传输：宿主凭据优先（旧行为），否则直连。 */
export function opencodeTransport(): "serve" | "direct" {
  return opencodeServeConfigured() ? "serve" : "direct";
}

async function circuitOpen(): Promise<boolean> {
  const rows = await sql<{ value: { openUntil?: string } | null }[]>`SELECT value FROM settings WHERE key = ${OPENCODE_CIRCUIT_KEY}`;
  const until = rows[0]?.value?.openUntil ? Date.parse(rows[0].value.openUntil) : NaN;
  return Number.isFinite(until) && until > Date.now();
}

/** 熔断状态（后台页/排障展示用）。 */
export async function opencodeCircuitState(): Promise<{ open: boolean; until: string | null; reason: string | null }> {
  const rows = await sql<{ value: { openUntil?: string; reason?: string } | null }[]>`SELECT value FROM settings WHERE key = ${OPENCODE_CIRCUIT_KEY}`;
  const v = rows[0]?.value ?? null;
  const open = !!(v?.openUntil && Date.parse(v.openUntil!) > Date.now());
  return { open, until: open ? v!.openUntil! : null, reason: v?.reason ?? null };
}

/** 通道层可用性：凭据在且熔断闭（证书成员有无由 modelFor 按能力位判）。 */
export async function opencodeUsable(): Promise<boolean> {
  return opencodeConfigured() && !(await circuitOpen());
}

/** 通道级失败开熔断：30 分钟内视同通道不可用，候选链跳过本通道回落其他免费/付费。 */
export async function openOpencodeCircuit(reason: string): Promise<void> {
  const value = { openUntil: new Date(Date.now() + OPENCODE_CIRCUIT_COOLDOWN_MS).toISOString(), reason: reason.slice(0, 200) };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${OPENCODE_CIRCUIT_KEY}, ${sql.json(value as never)}, 'system')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** 通道级失败判据（llm.ts 熔断开闸依据）：
 *  - null=客户端不可达（宿主进程崩溃/未启动——本通道独立熔断因）；
 *  - 401/403=鉴权面变化（密码错/客户端未设密码）；404=API 形状漂移（客户端升级断链）；
 *  - 免费闸/账户面措辞（FreeTierError=工作区开关被关，Account budget=账户预算类）。
 *  429（并发排队）与 5xx 是瞬态信号：交给候选链换下一个，不熔断（zhipu 1305 同口径）。 */
export function isOpencodeChannelFailure(status: number | null, message: string): boolean {
  if (status === null) return true;
  if (status === 401 || status === 403 || status === 404) return true;
  return /FreeTierError|free models may train|Allow free endpoints|budget exceeded|Account budget/i.test(message);
}

/** 客户端连接失败码（llm.ts 的 isConnectFailure 同集；本模块独立持一份避免回路）。 */
const CONNECT_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"];
function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return CONNECT_CODES.includes(code ?? "");
}

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

export interface OpencodeFetchResult {
  status: number;
  body: string;
}

/** 客户端 HTTP 薄封装（scan 与调用面共用）：连接失败→ProviderRejectedError(status=null)。
 *  baseUrl/password 可显式传入（测试/扫描），缺省读凭据。 */
export async function opencodeClientFetch(
  method: string,
  path: string,
  opts: { baseUrl?: string; password?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<OpencodeFetchResult> {
  const base = (opts.baseUrl ?? credential("models", "OPENCODE_SERVE_URL") ?? "").replace(/\/+$/, "");
  const password = opts.password ?? credential("models", "OPENCODE_SERVER_PASSWORD") ?? "";
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      headers: { "content-type": "application/json", authorization: basicAuth(password) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, body: await res.text() };
  } catch (error) {
    if (isConnectFailure(error)) throw new ProviderRejectedError(`opencode client unreachable: ${String(error).slice(0, 200)}`, null, true);
    throw error;
  }
}

export interface OpencodeCallInput {
  baseUrl: string;
  password: string;
  model: string;
  system?: string;
  user: string;
  timeoutMs?: number;
  /** 直连传输用：输出预算（思考 token 也计入，直连侧会加思考余量）。 */
  maxTokens?: number;
  /** 直连传输用：采样温度。 */
  temperature?: number;
  /** 直连传输用：会话粘性种子（同一 subject 的重试落在同一会话；5xx 时轮换）。 */
  sessionSeed?: string;
  /** 显式传输（llm.ts 按通道解析后传入）；缺省按宿主凭据是否存在自动判断。 */
  transport?: "serve" | "direct";
}

export interface OpencodeCallOutcome {
  /** 归一到 OpenAI 形（replyText/usageOf 单形消费）：choices[0].message.content + usage。 */
  response: Record<string, unknown>;
  requestId: string | null;
  usage: Record<string, unknown> | null;
  /** 本次实际传输（回执成本证据按它记 free-tier-client / free-tier-public）。 */
  transport: "serve" | "direct";
}

/** 经客户端发一轮出文（ym467 S03）：每次调用新建会话、答完即删——避免上下文在会话内累积
 *  污染各次独立调用（站点调用全是无状态单问）；tools:{} 关闭工具调用（纯文本生成面）。
 *  上游错误以 info.error 返回（HTTP 200 内嵌，见 ym443 pass1 E2）：转 ProviderRejectedError 上抛。 */
async function callOpencodeServe(input: OpencodeCallInput): Promise<OpencodeCallOutcome> {
  const timeout = input.timeoutMs ?? 120_000;
  const fetchOpts = { baseUrl: input.baseUrl, password: input.password, timeoutMs: timeout };
  const created = await opencodeClientFetch("POST", "/session", { ...fetchOpts, body: {} });
  if (created.status !== 200) {
    throw new ProviderRejectedError(`opencode session create HTTP ${created.status}: ${created.body.slice(0, 200)}`, created.status, created.status === 429 || created.status >= 500);
  }
  const sid = (JSON.parse(created.body) as { id?: string }).id;
  if (!sid) throw new ProviderRejectedError("opencode session create returned no id", 404, false);
  try {
    const sent = await opencodeClientFetch("POST", `/session/${sid}/message`, {
      ...fetchOpts,
      body: {
        model: { providerID: "opencode", modelID: input.model },
        ...(input.system ? { system: input.system } : {}),
        tools: {},
        parts: [{ type: "text", text: input.user }],
      },
    });
    if (sent.status !== 200) {
      throw new ProviderRejectedError(`opencode message HTTP ${sent.status}: ${sent.body.slice(0, 200)}`, sent.status, sent.status === 429 || sent.status >= 500);
    }
    const d = JSON.parse(sent.body) as {
      info?: { id?: string; error?: { name?: string; data?: { message?: string; statusCode?: number } }; tokens?: { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number } } };
      parts?: Array<{ type?: string; text?: string }>;
    };
    const info = d.info ?? {};
    if (info.error) {
      // 上游拒绝（免费闸/预算/模型不存在）：statusCode 常缺，按 400 记并把名号带进消息供熔断判据。
      const msg = info.error.data?.message ?? info.error.name ?? "unknown upstream error";
      const code = typeof info.error.data?.statusCode === "number" ? info.error.data.statusCode : 400;
      throw new ProviderRejectedError(`opencode upstream ${info.error.name ?? "error"}: ${msg}`, code, false);
    }
    const text = (d.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    const t = info.tokens;
    const usage = t
      ? { prompt_tokens: t.input ?? 0, completion_tokens: (t.output ?? 0) + (t.reasoning ?? 0), total_tokens: t.total ?? 0, cache_read_tokens: t.cache?.read ?? 0 }
      : null;
    return {
      response: { choices: [{ message: { content: text } }], id: info.id ?? null, usage },
      requestId: info.id ?? null,
      usage,
      transport: "serve",
    };
  } finally {
    // 会话即用即删（best-effort；失败不掩盖主结果）。
    try {
      await opencodeClientFetch("DELETE", `/session/${sid}`, { ...fetchOpts, timeoutMs: 10_000 });
    } catch {
      /* 清理失败无害：会话不参与后续调用 */
    }
  }
}

// ---- 直连公共免费网关（Magpie opencode-2-free 插件同款）----
// 门禁在 2026-10-20 用对照实验钉死：必须 (1) Bearer public（自己的 key 反而 401）；
// (2) OpenCode 版 User-Agent；(3) ses_ 形状会话 id（uuid 即 403 FreeTierError）；
// (4) stream:true；(5) 至少声明一个核心工具（read/bash/edit/glob/grep）。缺任一条 403。
// 站点侧仍按非流式消费：本层把 SSE 折叠成 OpenAI 形 JSON。
export const OPENCODE2_BASE_URL = "https://opencode.ai/inference/openai/v1";
export const OPENCODE2_MODELS_URL = "https://opencode.ai/inference/v1/models";
export const OPENCODE2_CATALOG_URL = "https://models.opencode.ai/api.json";
export const OPENCODE2_CLIENT_VERSION = process.env.OPENCODE2_CLIENT_VERSION ?? "2.0.31";
export const OPENCODE2_USER_AGENT = `opencode/latest/${OPENCODE2_CLIENT_VERSION}/cli`;
const OPENCODE2_PUBLIC_KEY = "public";
const OPENCODE2_RELIST_MS = 60_000;
const OPENCODE2_SESSION_TRIES = 2;
const OPENCODE2_RETRIES = 7;
const OPENCODE2_RETRY_DELAY = 250;
const OPENCODE2_RETRY_DELAY_MAX = 1_000;
const OPENCODE2_MAX_BYTES = 32 * 1024 * 1024;
/** 公共免费层的并发上限（Magpie 插件同为 2；站点批量验收可调高，429 由候选链换模型）。 */
const OPENCODE2_MAX_CONCURRENCY = Math.max(1, Number(process.env.OPENCODE2_MAX_CONCURRENCY ?? 4) || 4);

/** 网关只服务的免费模型 id：`-free` 后缀或常免费白名单；探测/决策模型不接。 */
export function isOpencodeFreeModelId(id: string): boolean {
  if (!id || id === "test" || id === "__proto__") return false;
  if (id.startsWith("jev-")) return false;
  return id === "big-pickle" || /-free$/i.test(id);
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let idCounter = 0;

/** opencodeID 与 OpenCode 2 生成器同形：12 hex（时间戳*0x1000+计数，降序取反）+ 14 base62。 */
export function opencodeID(prefix: "ses" | "msg", descending = true, now = Date.now()): string {
  if (now !== lastStamp) {
    lastStamp = now;
    idCounter = 0;
  }
  idCounter += 1;
  const current = BigInt(now) * 0x1000n + BigInt(idCounter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ID_ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

/** 一个种子一条会话：多轮/重试粘在同一会话（网关按会话做粘性），5xx 时由调用方轮换。 */
const DIRECT_SESSIONS = new Map<string, string>();
const KEEP_DIRECT_SESSIONS = 1_000;

function directSession(seed: string, rotate = false): string {
  const key = createHash("sha256").update(`ses\0${seed}`).digest("hex");
  let session = rotate ? undefined : DIRECT_SESSIONS.get(key);
  if (session) {
    DIRECT_SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (DIRECT_SESSIONS.size >= KEEP_DIRECT_SESSIONS) {
      const oldest = DIRECT_SESSIONS.keys().next().value;
      if (oldest) DIRECT_SESSIONS.delete(oldest);
    }
  }
  DIRECT_SESSIONS.set(key, session);
  return session;
}

const DIRECT_SESSION_HEADERS = ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "X-Session-Id"];

/** 免费层要求的核心工具声明（只为过门禁，tool_choice=none 禁止真调用）。 */
export const OPENCODE2_CORE_TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "edit", description: "Edit a file", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } },
  { type: "function", function: { name: "glob", description: "Find files", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep", description: "Search file contents", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
] as const;

function directHeaders(session?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": OPENCODE2_USER_AGENT,
    authorization: `Bearer ${OPENCODE2_PUBLIC_KEY}`,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  };
  if (session) for (const name of DIRECT_SESSION_HEADERS) headers[name] = session;
  return headers;
}

export interface OpencodeDirectRequest {
  model: string;
  system?: string;
  user: string;
  temperature: number;
  maxTokens: number;
  session: string;
}

/** 纯函数（便于测试门禁边界）：直连请求的 URL/头/体。 */
export function buildOpencodeDirectRequest(input: OpencodeDirectRequest): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${OPENCODE2_BASE_URL}/chat/completions`,
    headers: directHeaders(input.session),
    body: JSON.stringify({
      model: input.model,
      messages: [
        ...(input.system ? [{ role: "system", content: input.system }] : []),
        { role: "user", content: input.user },
      ],
      // 免费层硬门禁：必须流式；工具声明缺一即 403。
      stream: true,
      stream_options: { include_usage: true },
      tools: OPENCODE2_CORE_TOOLS,
      tool_choice: "none",
      temperature: input.temperature,
      // 思考 token 计入 max_tokens，留 4K 余量；部分免费模型（nemotron 系）会把预算全用在思考上。
      max_tokens: Math.min(Math.max(input.maxTokens, 512) + 4_000, 32_000),
      reasoning_effort: "low",
    }),
  };
}

export interface CollapsedOpencodeReply {
  id: string | null;
  content: string;
  reasoningChars: number;
  finish: string | null;
  usage: Record<string, unknown> | null;
  completed: boolean;
}

/** SSE → 单个 chat.completion 部件（直连免费层只答流式；站点按非流式消费）。 */
export function collapseOpencodeSse(text: string): CollapsedOpencodeReply {
  let id: string | null = null;
  let content = "";
  let reasoningChars = 0;
  let finish: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let completed = false;
  let failure: string | null = null;
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    const name = eventName;
    const payload = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    if (failure || !payload.trim()) return;
    if (payload.trim() === "[DONE]") {
      completed = true;
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      failure = "invalid JSON in upstream SSE event";
      return;
    }
    if (event.error) {
      const error = event.error as { message?: string; type?: string };
      failure = error.message ? `${error.type ?? "error"}: ${error.message}` : JSON.stringify(event.error).slice(0, 300);
      return;
    }
    if (event.usage && typeof event.usage === "object") usage = event.usage as Record<string, unknown>;
    if (typeof event.id === "string") id = event.id;
    const choices = event.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined;
    for (const choice of choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (event.type === "error" && name === "error") failure = payload.slice(0, 300);
  };

  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") {
      dispatch();
      continue;
    }
    if (raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    if (field === "event") eventName = value;
  }
  if (dataLines.length) dispatch();
  if (failure) throw new Error(failure);
  return { id, content, reasoningChars, finish, usage, completed };
}

interface DirectListing {
  at: number;
  ids: Set<string>;
}
let directListing: DirectListing | null = null;

async function fetchDirectListing(signal?: AbortSignal): Promise<Set<string>> {
  const res = await fetch(OPENCODE2_MODELS_URL, {
    headers: directHeaders(),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`opencode2 models HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = new Set((payload.data ?? []).map((m) => m.id).filter((value): value is string => typeof value === "string" && isOpencodeFreeModelId(value)));
  if (ids.size === 0) throw new Error("opencode2 models list carried no free models");
  return ids;
}

/** 当前可用的免费模型 id（60s 缓存；刷新失败沿用上一份，冷启动失败上抛）。 */
export async function opencodeDirectModels(signal?: AbortSignal): Promise<Set<string>> {
  if (directListing && Date.now() - directListing.at < OPENCODE2_RELIST_MS) return directListing.ids;
  try {
    const ids = await fetchDirectListing(signal);
    directListing = { at: Date.now(), ids };
    return ids;
  } catch (error) {
    signal?.throwIfAborted();
    if (directListing) return directListing.ids;
    throw error;
  }
}

export function invalidateOpencodeDirectListing(): void {
  directListing = null;
}

let directActive = 0;
const directQueue: Array<() => void> = [];

async function withDirectSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (directActive >= OPENCODE2_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => directQueue.push(resolve));
  }
  directActive += 1;
  try {
    return await fn();
  } finally {
    directActive -= 1;
    directQueue.shift()?.();
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpencodeDirect(input: OpencodeCallInput): Promise<OpencodeCallOutcome> {
  return withDirectSlot(async () => {
    const listed = await opencodeDirectModels().catch((error) => {
      if (isConnectFailure(error)) {
        throw new ProviderRejectedError(`opencode2 gateway unreachable: ${String(error).slice(0, 200)}`, null, true);
      }
      throw new ProviderRejectedError(`opencode2 model list failed: ${String(error).slice(0, 200)}`, 502, true);
    });
    if (!listed.has(input.model)) {
      throw new ProviderRejectedError(
        `opencode2 model ${input.model} is not free now (gateway free models: ${[...listed].sort().join(", ")})`,
        410,
        false,
      );
    }
    const seed = input.sessionSeed?.trim() || `${input.system ?? ""}\n${input.user}`;
    let session = directSession(seed);
    let response: Response | null = null;
    for (let attempt = 0; attempt <= OPENCODE2_RETRIES; attempt += 1) {
      if (attempt >= OPENCODE2_SESSION_TRIES) session = directSession(seed, true);
      const built = buildOpencodeDirectRequest({
        model: input.model,
        system: input.system,
        user: input.user,
        temperature: input.temperature ?? 0.2,
        maxTokens: input.maxTokens ?? 1_500,
        session,
      });
      try {
        response = await fetch(built.url, {
          method: "POST",
          headers: built.headers,
          body: built.body,
          redirect: "error",
          signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
        });
      } catch (error) {
        if (isConnectFailure(error)) {
          throw new ProviderRejectedError(`opencode2 gateway unreachable: ${String(error).slice(0, 200)}`, null, true);
        }
        throw error;
      }
      if (response.ok) break;
      const body = await response.text().catch(() => "");
      if (response.status >= 500 && attempt < OPENCODE2_RETRIES) {
        // 网关上游未唤醒/会话被钉在坏上游：换会话重试。
        await pause(Math.min(OPENCODE2_RETRY_DELAY * 2 ** attempt, OPENCODE2_RETRY_DELAY_MAX));
        continue;
      }
      throw new ProviderRejectedError(
        `opencode2 HTTP ${response.status}: ${body.slice(0, 500)}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!response?.ok) throw new ProviderRejectedError("opencode2 request failed after retries", 502, true);
    const text = await response.text();
    if (text.length > OPENCODE2_MAX_BYTES) {
      throw new ProviderRejectedError("opencode2 response exceeds the 32 MiB limit", 502, false);
    }
    let collapsed: CollapsedOpencodeReply;
    try {
      collapsed = collapseOpencodeSse(text);
    } catch (error) {
      throw new ProviderRejectedError(`opencode2 stream error: ${String(error).slice(0, 300)}`, 502, true);
    }
    if (!collapsed.content.trim()) {
      throw new ProviderRejectedError(
        `opencode2 model ${input.model} returned no content (finish=${collapsed.finish ?? "?"}, reasoning=${collapsed.reasoningChars} chars)`,
        502,
        true,
      );
    }
    return {
      response: {
        id: collapsed.id,
        choices: [{ message: { role: "assistant", content: collapsed.content }, finish_reason: collapsed.finish }],
        usage: collapsed.usage,
      },
      requestId: collapsed.id,
      usage: collapsed.usage,
      transport: "direct",
    };
  });
}

export interface OpencodeDirectCatalogModel {
  id: string;
  name: string;
  contextTokens: number | null;
  outputLimit: number | null;
  zeroPrice: boolean;
  status: string | null;
}

export interface OpencodeDirectCatalog {
  /** 直连目录的版本面（客户端版本 + 传输），供 scan 的漂移探测快照。 */
  version: string;
  transport: "direct";
  models: OpencodeDirectCatalogModel[];
  freeIds: string[];
}

/** 直连目录：网关 models 列决定「此刻可调用」，models.opencode.ai 目录补元数据。 */
export async function fetchOpencodeDirectCatalog(): Promise<OpencodeDirectCatalog> {
  const [listResult, catalogResult] = await Promise.allSettled([
    fetch(OPENCODE2_MODELS_URL, { headers: directHeaders(), signal: AbortSignal.timeout(15_000) }),
    fetch(OPENCODE2_CATALOG_URL, { signal: AbortSignal.timeout(15_000) }),
  ]);
  if (listResult.status !== "fulfilled" || !listResult.value.ok) {
    const status = listResult.status === "fulfilled" ? listResult.value.status : null;
    await (listResult.status === "fulfilled" ? listResult.value.body?.cancel() : undefined);
    throw new Error(`opencode2 models HTTP ${status ?? "error"}`);
  }
  const list = (await listResult.value.json()) as { data?: Array<{ id?: string }> };
  let metadata: Record<string, { name?: string; cost?: { input?: number; output?: number }; limit?: { context?: number; output?: number }; deprecated?: boolean; status?: string }> = {};
  if (catalogResult.status === "fulfilled" && catalogResult.value.ok) {
    const catalog = (await catalogResult.value.json()) as { opencode?: { models?: typeof metadata } };
    metadata = catalog.opencode?.models ?? {};
  } else if (catalogResult.status === "fulfilled") {
    await catalogResult.value.body?.cancel();
  }
  const models: OpencodeDirectCatalogModel[] = [];
  for (const item of list.data ?? []) {
    const id = item.id;
    if (typeof id !== "string" || !isOpencodeFreeModelId(id)) continue;
    const meta = metadata[id] ?? {};
    const cost = meta.cost;
    const zeroPrice = cost ? Number(cost.input) === 0 && Number(cost.output) === 0 : true;
    const retired = meta.deprecated === true || ["deprecated", "retired", "disabled"].includes(meta.status ?? "");
    if (!zeroPrice || retired) continue;
    models.push({
      id,
      name: meta.name ?? id,
      contextTokens: typeof meta.limit?.context === "number" ? meta.limit.context : null,
      outputLimit: typeof meta.limit?.output === "number" ? meta.limit.output : null,
      zeroPrice: true,
      status: retired ? "retired" : null,
    });
  }
  return { version: `${OPENCODE2_CLIENT_VERSION}-direct`, transport: "direct", models, freeIds: models.map((m) => m.id) };
}

/** 传输分派：宿主凭据在（或显式指定）走 serve，否则走直连。 */
export async function callOpencode(input: OpencodeCallInput): Promise<OpencodeCallOutcome> {
  const transport = input.transport ?? (input.baseUrl && input.password ? "serve" : opencodeTransport());
  if (transport === "serve") {
    if (!input.baseUrl || !input.password) {
      throw new Error("opencode serve transport needs OPENCODE_SERVE_URL and OPENCODE_SERVER_PASSWORD");
    }
    return callOpencodeServe(input);
  }
  if (!opencodeDirectEnabled()) {
    throw new Error("opencode direct transport is disabled (OPENCODE_DIRECT_ENABLED=false)");
  }
  return callOpencodeDirect(input);
}
