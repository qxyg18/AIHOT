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
}

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

export function buildLlmRequest(req: LlmEndpointRequest): BuiltRequest {
  const base = req.baseUrl.replace(/\/+$/, "");
  if (isAnthropicEndpoint(req.baseUrl)) {
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
      ...(req.extra ?? {}),
    }),
  };
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
