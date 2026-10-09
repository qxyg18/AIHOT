// opencode 免费档通道（ym467，命主 2026-10-09 拍板 A 承接）：宿主常驻 `opencode serve` 作中介，
// 站点容器经 host.docker.internal 访问（HTTP Basic：用户名缺省 opencode + OPENCODE_SERVER_PASSWORD，
// 凭据在 models.env）。免费档限官方客户端内使用（平台隐私开关「允许免费端点」已由命主打开）；
// 出文零计费，与智谱（并发限流）/OpenRouter（账号日次池）互补。
// 熔断形态照 zhipu/mimo：通道级失败开 30 分钟冷却；并新增「客户端不可达」为独立熔断因
// （宿主进程崩溃/未启动时，连接失败即判通道级失败，冷却期内候选链直接跳过本通道）。
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { ProviderRejectedError } from "./receipts.ts";

/** MODELS 预设键：实际模型 id 由证书路由钉选/快照解析（opencode: 前缀成员换模型预设键不变）。 */
export const OPENCODE_FREE_KEY = "opencode-free";

export const OPENCODE_CIRCUIT_KEY = "llm.opencode_circuit";
export const OPENCODE_CIRCUIT_COOLDOWN_MS = 30 * 60_000;

export function opencodeConfigured(): boolean {
  return !!(credential("models", "OPENCODE_SERVE_URL") && credential("models", "OPENCODE_SERVER_PASSWORD"));
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
}

export interface OpencodeCallOutcome {
  /** 归一到 OpenAI 形（replyText/usageOf 单形消费）：choices[0].message.content + usage。 */
  response: Record<string, unknown>;
  requestId: string | null;
  usage: Record<string, unknown> | null;
}

/** 经客户端发一轮出文（ym467 S03）：每次调用新建会话、答完即删——避免上下文在会话内累积
 *  污染各次独立调用（站点调用全是无状态单问）；tools:{} 关闭工具调用（纯文本生成面）。
 *  上游错误以 info.error 返回（HTTP 200 内嵌，见 ym443 pass1 E2）：转 ProviderRejectedError 上抛。 */
export async function callOpencode(input: OpencodeCallInput): Promise<OpencodeCallOutcome> {
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
