// Admin "API 接口配置": the deployment's default model endpoint (base URL, API key, model name)
// configured from the admin UI instead of the credentials file. Values here win over the
// environment / models.env, which stays as the fallback — clearing a field returns to it.
// The test button makes one minimal live call with the effective values and reports the provider's
// own error text (a 1113 "余额不足" answers directly on the page), bypassing receipts: it is a
// connectivity probe, not a business call, and must stay out of the cost statistics.
import { sql } from "../db.ts";
import { config, credential } from "../config.ts";
import { audit } from "./auth.ts";
import { buildLlmRequest, replyText } from "../providers/llmEndpoint.ts";

const SETTINGS_KEY = "llm.config";

export interface LlmOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface EffectiveLlm {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  /** Where each effective value came from, for the admin page. */
  sources: { baseUrl: "admin" | "file"; apiKey: "admin" | "file"; model: "admin" | "file" };
}

let cache: { at: number; value: LlmOverride } | null = null;

/** The admin override, cached for a minute like the model switches. */
export async function llmOverrides(): Promise<LlmOverride> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const rows = await sql<{ value: LlmOverride | null }[]>`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`;
  const value = rows[0]?.value ?? {};
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateLlmConfigCache(): void {
  cache = null;
}

/** What the default model actually runs on right now: admin override first, then env/file. */
export async function effectiveLlm(): Promise<EffectiveLlm> {
  const o = await llmOverrides();
  // Same fallback everywhere as the live calls in llm.ts: environment first, credentials file second.
  const fileKey = credential("models", "LLM_API_KEY");
  const fileBase = credential("models", "LLM_BASE_URL");
  const fileModel = credential("models", "LLM_MODEL") ?? "";
  const baseUrl = o.baseUrl?.trim() || null;
  const apiKey = o.apiKey?.trim() || null;
  const model = o.model?.trim() || "";
  return {
    baseUrl: baseUrl ?? fileBase,
    apiKey: apiKey ?? fileKey,
    model: model || fileModel,
    sources: {
      baseUrl: baseUrl ? "admin" : "file",
      apiKey: apiKey ? "admin" : "file",
      model: model ? "admin" : "file",
    },
  };
}

const maskKey = (key: string | null): string | null =>
  key ? (key.length <= 8 ? `${key.slice(0, 2)}****` : `${key.slice(0, 4)}****${key.slice(-4)}`) : null;

export async function llmConfigOverview() {
  const effective = await effectiveLlm();
  const rows = await sql<{ value: LlmOverride | null; updated_by: string | null; updated_at: string }[]>`
    SELECT value, updated_by, updated_at FROM settings WHERE key = ${SETTINGS_KEY}`;
  const stored = rows[0];
  return {
    effective: {
      baseUrl: effective.baseUrl,
      apiKey: maskKey(effective.apiKey),
      model: effective.model,
      sources: effective.sources,
    },
    configured: {
      baseUrl: stored?.value?.baseUrl ?? null,
      // A stored key is never echoed whole, not even to the admin page.
      apiKey: stored?.value?.apiKey ? maskKey(stored.value.apiKey) : null,
      model: stored?.value?.model ?? null,
      updatedBy: stored?.updated_by ?? null,
      updatedAt: stored?.updated_at ?? null,
    },
  };
}

/** Save the given override fields. The page promises "empty = leave this field as it is", so a
 *  partial submit merges into what is stored; only the explicit clear signal from the "清除后台配置"
 *  button deletes the whole entry and returns everything to the credentials file. */
export async function setLlmConfig(input: { clear?: boolean; baseUrl?: string | null; apiKey?: string | null; model?: string | null }, actor: string) {
  const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const existingRows = await sql<{ value: LlmOverride | null }[]>`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`;
  const existing = existingRows[0]?.value ?? {};
  const next: LlmOverride = input.clear ? {} : { ...existing };
  if (clean(input.baseUrl)) next.baseUrl = clean(input.baseUrl)!;
  if (clean(input.apiKey)) next.apiKey = clean(input.apiKey)!;
  if (clean(input.model)) next.model = clean(input.model)!;

  const before = await llmConfigOverview();
  const entries = Object.entries(next);
  if (entries.length === 0) {
    await sql`DELETE FROM settings WHERE key = ${SETTINGS_KEY}`;
  } else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${SETTINGS_KEY}, ${sql.json(next as never)}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateLlmConfigCache();
  const after = await llmConfigOverview();
  await audit(actor, "settings.llm_config", `settings:${SETTINGS_KEY}`, null, before.configured, after.configured);
  return after;
}

export interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  model: string;
  baseUrl: string;
  reply: string | null;
  error: string | null;
  ms: number;
}

/** One minimal live chat call with the effective values; the provider's error text is passed through. */
export async function testLlmConnection(): Promise<TestResult> {
  const effective = await effectiveLlm();
  const started = Date.now();
  if (!effective.baseUrl || !effective.apiKey || !effective.model) {
    return { ok: false, httpStatus: null, model: effective.model || "(未配置)", baseUrl: effective.baseUrl ?? "(未配置)",
             reply: null, error: "接口地址、API Key、模型名三项都非空才能测试（当前有用环境文件值兜底）", ms: 0 };
  }
  try {
    const wire = buildLlmRequest({ baseUrl: effective.baseUrl, apiKey: effective.apiKey, model: effective.model,
      user: "请只回复两个字：成功", temperature: 0.2, maxTokens: 256, jsonMode: false });
    const res = await fetch(wire.url, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: wire.headers,
      body: wire.body,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, model: effective.model, baseUrl: effective.baseUrl,
               reply: null, error: text.slice(0, 400), ms };
    }
    const json = JSON.parse(text) as Record<string, unknown>;
    return { ok: true, httpStatus: res.status, model: effective.model, baseUrl: effective.baseUrl,
             reply: replyText(json).trim().slice(0, 100) || null, error: null, ms };
  } catch (error) {
    return { ok: false, httpStatus: null, model: effective.model, baseUrl: effective.baseUrl,
             reply: null, error: String(error).slice(0, 400), ms: Date.now() - started };
  }
}
