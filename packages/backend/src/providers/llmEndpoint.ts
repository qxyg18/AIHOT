// One request shape, two wire protocols. A base URL ending in `/anthropic` speaks the Anthropic
// Messages API (the endpoint Zhipu's GLM coding plans live on); every other base URL keeps the
// OpenAI-compatible `/chat/completions` the code was built on. Callers build one
// LlmEndpointRequest and get url/headers/body; replies come back through replyText()/usageOf()
// normalised to the OpenAI field names the rest of the code (receipts, statistics) reads.
export interface LlmEndpointRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  system?: string;
  user: string | Array<Record<string, unknown>>;
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  /** OpenAI-style extra request fields (thinking switches…); only sent on the OpenAI protocol. */
  extra?: Record<string, unknown>;
  /**
   * ym249 free-only policy: applied AFTER `extra`, so its constraints cannot be overridden by it.
   * Server-side provider routing caps the price at zero; paid add-ons (tools/plugins/fallbacks)
   * are rejected outright. Absent on every legacy call — behaviour there is byte-identical.
   */
  policy?: LlmPolicy;
}

export interface LlmPolicy {
  /** OpenRouter provider routing `max_price`（wire 形状是对象 `{prompt, completion}`——见 providerOf；
   *  值 0 = 该方向零计费，双 0 = 该请求必须零计费）。 */
  serverMaxPrice?: number;
  /** Only route to providers that support the model's declared parameters. */
  requireParameters?: boolean;
  /** e.g. "deny": no training/retention on the provider side, when the provider offers it.
   *  wire 键名=data_collection（OpenRouter 官方口径 "allow"|"deny"；旧键 data_policy 会 400
   *  「Unrecognized key」——ym441 生产实证）。 */
  dataPolicy?: string;
}

/** Keys a free-only request must not carry at all: every one of them can add per-request charges. */
const POLICY_FORBIDDEN_EXTRAS = ["tools", "tool_choice", "plugins", "plugin", "fallbacks", "logit_bias"];

/** Keys that define the request identity; a policy call lets `extra` shape the work, not swap it. */
const REQUEST_IDENTITY_KEYS = ["model", "messages", "response_format", "provider"];

export function isAnthropicEndpoint(baseUrl: string): boolean {
  return /\/anthropic\/?$/.test(baseUrl.trim());
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The Messages API request keeps plain text; multimodal parts degrade to their text portions. */
function userTextOf(user: LlmEndpointRequest["user"]): string {
  if (typeof user === "string") return user;
  return user.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
}

export class PolicyViolationError extends Error {}

export function buildLlmRequest(req: LlmEndpointRequest): BuiltRequest {
  const base = req.baseUrl.replace(/\/+$/, "");
  if (isAnthropicEndpoint(req.baseUrl)) {
    // The Anthropic Messages API has no provider-routing object to hang a price cap on.
    if (req.policy) throw new PolicyViolationError("free-only policy is only defined for OpenAI-compatible endpoints");
    return {
      url: `${base}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": req.apiKey,
        "authorization": `Bearer ${req.apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        // The Messages API takes the system prompt as a top-level field, not a message.
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: userTextOf(req.user) }],
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        // No response_format here; extractJson()'s brace parsing keeps JSON answers honest.
      }),
    };
  }
  // ym249: the policy is enforced after `extra` is merged in — the free-only constraints win.
  const extra = { ...(req.extra ?? {}) };
  if (req.policy) {
    for (const key of POLICY_FORBIDDEN_EXTRAS) {
      if (key in extra) throw new PolicyViolationError(`free-only requests must not carry "${key}" (paid add-on)`);
    }
    for (const key of REQUEST_IDENTITY_KEYS) {
      if (key in extra && key !== "provider") throw new PolicyViolationError(`free-only requests must not override "${key}" via extra`);
    }
    if ("provider" in extra && typeof extra.provider === "object" && extra.provider !== null && !Array.isArray(extra.provider)) {
      // Merge, policy keys last so a caller-provided provider.max_price cannot raise the cap.
      extra.provider = { ...(extra.provider as Record<string, unknown>), ...providerOf(req.policy) };
    } else if ("provider" in extra) {
      throw new PolicyViolationError('free-only "provider" extra must be an object when present');
    } else {
      extra.provider = providerOf(req.policy);
    }
  }
  return {
    url: `${base}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.user },
      ],
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...extra,
    }),
  };
}

function providerOf(policy: LlmPolicy): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  // ym441：max_price 的 wire 形状是对象（OpenRouter 官方口径 {prompt, completion, request, image}）；
  // 数字形状会 400。生产实证：2026-10-08 23:20 structure_article 首次 OR 承接即 HTTP 400
  // 「provider.max_price: Invalid input: expected object, received number」；历史 OR 承接
  // （10-03~10-06，cost_evidence={}）走的是无策略路径，该形状从未在 OR 面成功过——本卡让
  // OR 面可达（S01）后必现。双方向都给 0 = 该请求必须零计费。
  if (policy.serverMaxPrice !== undefined) provider.max_price = { prompt: policy.serverMaxPrice, completion: policy.serverMaxPrice };
  if (policy.requireParameters !== undefined) provider.require_parameters = policy.requireParameters;
  // ym441：wire 键名=data_collection（官方口径；data_policy 会 400「Unrecognized key」——生产实证
  // 2026-10-08 23:35，max_price 修好后暴露的第二处遗留形状问题）。
  if (policy.dataPolicy !== undefined) provider.data_collection = policy.dataPolicy;
  return provider;
}

/** The assistant's text from either protocol's reply JSON. */
export function replyText(json: Record<string, unknown>): string {
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  if (choices?.[0]?.message?.content != null) return choices[0].message.content;
  const content = json.content as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(content)) return content.filter((p) => p?.text).map((p) => p.text).join("");
  return "";
}

/** Usage normalised to OpenAI field names, so receipts and the statistics pages stay single-shaped. */
export function usageOf(json: Record<string, unknown>): Record<string, unknown> | null {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  if (usage.prompt_tokens != null || usage.completion_tokens != null) return usage;
  const input = usage.input_tokens as number | undefined;
  const output = usage.output_tokens as number | undefined;
  if (input == null && output == null) return usage;
  return { ...usage, prompt_tokens: input ?? 0, completion_tokens: output ?? 0 };
}
