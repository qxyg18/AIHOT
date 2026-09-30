// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { llmOverrides } from "../admin/llmconfig.ts";
import { buildLlmRequest, isAnthropicEndpoint, replyText, usageOf } from "./llmEndpoint.ts";
import { sha256 } from "../lib/ids.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";
import { isMimoBalanceError, openMimoCircuit } from "./mimo.ts";
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
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

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

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  // The default endpoint additionally takes the admin override (settings `llm.config`), which wins
  // over env/credentials-file; named presets keep their own keys.
  const override = spec.key === "default" ? await llmOverrides() : null;
  const baseUrl = override?.baseUrl?.trim() || credential("models", spec.baseUrlEnv);
  const apiKey = override?.apiKey?.trim() || credential("models", spec.apiKeyEnv);
  const model = override?.model?.trim() || spec.model;
  if (!baseUrl || !apiKey || !model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const temperature = opts.temperature ?? 0.2;
  // Reasoning models burn output budget on thinking tokens (GLM 5.3 always reasons;
  // its Anthropic layer ignores thinking:disabled — ka4). Any spec with thinking
  // explicitly enabled gets the same headroom as the "-think" variants.
  const specExtra = (spec.extra ?? {}) as { thinking?: { type?: string }; enable_thinking?: boolean };
  const thinkingOn = specExtra.thinking?.type === "enabled" || specExtra.enable_thinking === true;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") || thinkingOn ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const wire = buildLlmRequest({
    baseUrl,
    apiKey,
    model,
    system: opts.system,
    user: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText,
    temperature,
    maxTokens,
    jsonMode: spec.jsonMode && opts.json !== false,
    extra: spec.extra,
  });

  let receipt: Awaited<ReturnType<typeof paidRequest>>;
  try {
    receipt = await paidRequest(
      {
        service: spec.service,
        model,
        purpose: opts.purpose,
        subject: opts.subject,
        identity: { model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: (isAnthropicEndpoint(baseUrl) ? null : spec.extra) ?? null },
        requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
        attemptTag: opts.attemptTag,
      },
      async () => {
        const started = Date.now();
        let res: Response;
        try {
          res = await fetch(wire.url, {
            method: "POST",
            headers: wire.headers,
            body: wire.body,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
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
        };
      },
    );
  } catch (error) {
    // ka3: a balance-type MIMO rejection opens the circuit, so the daytime shift stops calling it
    // for two hours and heavy work waits for the discounted window again.
    if (spec.service === "mimo" && error instanceof ProviderRejectedError && isMimoBalanceError(error.status, error.message)) {
      await openMimoCircuit(error.message);
    }
    throw error;
  }

  const response = receipt.response as Record<string, unknown>;
  const content = replyText(response);
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: usageOf(response) ?? null };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
