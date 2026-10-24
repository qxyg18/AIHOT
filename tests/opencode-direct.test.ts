// opencode 免费档直连传输（ym20261020，Magpie opencode-2-free 同款）：
// 纯函数判别面——免费模型判定、网关五道门禁（public 凭证/UA/ses_ 会话/流式/工具声明）、
// ses_ id 形状、SSE→非流式折叠、传输选择。全程零网络零数据库写入。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpencodeDirectRequest,
  collapseOpencodeSse,
  isOpencodeFreeModelId,
  opencodeID,
  opencodeTransport,
  OPENCODE2_CORE_TOOLS,
  OPENCODE2_USER_AGENT,
} from "@aihot/backend/providers/opencode";

const T = tag();

test(`${T} 免费模型判定只认 -free 后缀与 big-pickle`, () => {
  assert.equal(isOpencodeFreeModelId("deepseek-v4.1-flash-free"), true);
  assert.equal(isOpencodeFreeModelId("big-pickle"), true);
  assert.equal(isOpencodeFreeModelId("glm-5.3-flash-free"), true);
  assert.equal(isOpencodeFreeModelId("deepseek-v4.1-flash"), false);
  assert.equal(isOpencodeFreeModelId("test"), false);
  assert.equal(isOpencodeFreeModelId("jev-1.13-free"), false);
  assert.equal(isOpencodeFreeModelId(""), false);
});

test(`${T} 直连请求补齐网关五道门禁`, () => {
  const session = "ses_0123456789abABCDEFGHIJKLMN";
  const built = buildOpencodeDirectRequest({
    model: "deepseek-v4.1-flash-free",
    system: "你是 JSON 抽取器",
    user: "只输出 JSON",
    temperature: 0.2,
    maxTokens: 1_500,
    session,
  });
  // 1) 公开凭证 + OpenCode 2 客户端身份
  assert.equal(built.url, "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.equal(built.headers.authorization, "Bearer public");
  assert.equal(built.headers["user-agent"], OPENCODE2_USER_AGENT);
  assert.equal(built.headers["x-opencode-client"], "cli");
  // 2) 会话 id 以四个名字同时透传（网关按会话做粘性）
  for (const name of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "X-Session-Id"]) {
    assert.equal(built.headers[name], session);
  }
  const body = JSON.parse(built.body) as Record<string, unknown>;
  // 3) 必须流式
  assert.equal(body.stream, true);
  // 4) 必须声明核心工具
  const tools = body.tools as Array<{ function: { name: string } }>;
  assert.ok(tools.some((t) => t.function.name === "read"));
  assert.equal(tools.length, OPENCODE2_CORE_TOOLS.length);
  assert.equal(body.tool_choice, "none");
  // 5) 不用 response_format（免费模型会把它和思考预算打架），但留思考余量
  assert.equal("response_format" in body, false);
  assert.equal(body.max_tokens, 5_500);
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.messages, [
    { role: "system", content: "你是 JSON 抽取器" },
    { role: "user", content: "只输出 JSON" },
  ]);
});

test(`${T} opencodeID 与 OpenCode 2 会话形状一致`, () => {
  const a = opencodeID("ses", true);
  const b = opencodeID("ses", true);
  assert.match(a, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(b, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.notEqual(a, b);
  const msg = opencodeID("msg", false);
  assert.match(msg, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test(`${T} SSE 折叠为单条 chat.completion`, () => {
  const sse = [
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    "",
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"{\\"category\\":","reasoning_content":"想一下"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"\\"品牌动作\\"}"},"finish_reason":"stop"}]}',
    "",
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const reply = collapseOpencodeSse(sse);
  assert.equal(reply.content, '{"category":"品牌动作"}');
  assert.equal(reply.finish, "stop");
  assert.equal(reply.completed, true);
  assert.equal(reply.id, "chatcmpl-1");
  assert.equal(reply.reasoningChars, 3);
  assert.deepEqual(reply.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test(`${T} SSE 内的上游错误不被吞`, () => {
  assert.throws(
    () => collapseOpencodeSse('data: {"error":{"type":"FreeTierError","message":"download OpenCode"}}\n\n'),
    /FreeTierError/,
  );
});

test(`${T} 传输选择：宿主凭据优先，否则直连`, () => {
  const url = process.env.OPENCODE_SERVE_URL;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    delete process.env.OPENCODE_SERVE_URL;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    assert.equal(opencodeTransport(), "direct");
    process.env.OPENCODE_SERVE_URL = "http://127.0.0.1:4096";
    process.env.OPENCODE_SERVER_PASSWORD = "test-password";
    assert.equal(opencodeTransport(), "serve");
  } finally {
    if (url === undefined) delete process.env.OPENCODE_SERVE_URL;
    else process.env.OPENCODE_SERVE_URL = url;
    if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = password;
  }
});
