// ym467 opencode 免费档通道（命主 2026-10-10 直令承接·拍板 A）：三通道合流（智谱→openrouter→
// opencode）、通道判别前缀、免费判定双信号、目录差分、连续失败摘池、熔断判据、预设面
// （端点/凭据键）。纯函数面；聊天候选链与证书管线的端到端行为由 capability-routing/
// api-router 既有套件与夜批验收管线覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCapabilityRoutes, type QualifiedRow } from "../packages/backend/src/modelwatch/routing.ts";
import { channelOfModel } from "../packages/backend/src/modelwatch/capability-routing.ts";
import { isFreeOpencodeModel, planOpencodeSync } from "../packages/backend/src/opencodewatch/scan.ts";
import { nextFailStreak } from "../packages/backend/src/opencodewatch/pool.ts";
import { isOpencodeChannelFailure, OPENCODE_FREE_KEY, OPENCODE_CIRCUIT_KEY } from "../packages/backend/src/providers/opencode.ts";
import { MODELS } from "../packages/backend/src/providers/llm.ts";
import { ZHIPU_FREE_KEY } from "../packages/backend/src/providers/zhipu.ts";

const row = (over: Partial<QualifiedRow>): QualifiedRow => ({
  capability: "summarize",
  model_id: "opencode:big-pickle",
  supports_vision: false,
  tested_at: "2026-10-10T01:00:00.000Z",
  pass_count: 10,
  cert_version: null,
  ...over,
});

test("mergeCapabilityRoutes orders zhipu → openrouter → opencode and stamps channels (ym467)", () => {
  const merged = mergeCapabilityRoutes(
    [row({ model_id: "zhipu:glm-4.7-flash" })],
    [row({ model_id: "meta/llama-x:free" })],
    [row({ model_id: "opencode:big-pickle" })],
  );
  const list = merged.summarize!;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.channel), ["zhipu", "openrouter", "opencode"]);
  assert.equal(list[2]!.model, "opencode:big-pickle");
});

test("mergeCapabilityRoutes keeps the two-argument call unchanged (ym467 backward compat)", () => {
  const merged = mergeCapabilityRoutes([row({ model_id: "zhipu:glm-4.7-flash" })], [row({ model_id: "a/b:free" })]);
  assert.deepEqual(merged.summarize!.map((r) => r.channel), ["zhipu", "openrouter"]);
});

test("mergeCapabilityRoutes dedupes opencode members per capability×model (ym467)", () => {
  const merged = mergeCapabilityRoutes([], [], [row(), row()]);
  assert.equal(merged.summarize!.length, 1);
});

test("channelOfModel reads the opencode: prefix (ym467)", () => {
  assert.equal(channelOfModel("opencode:big-pickle"), "opencode");
  assert.equal(channelOfModel("opencode:step-5-preview-free"), "opencode");
  assert.equal(channelOfModel("zhipu:glm-4.7-flash"), "zhipu");
  assert.equal(channelOfModel("meta/llama-x:free"), "openrouter"); // 非通道前缀
});

test("isFreeOpencodeModel: suffix convention + known-free allowlist, paid ids excluded (ym467)", () => {
  assert.equal(isFreeOpencodeModel("big-pickle"), true);
  assert.equal(isFreeOpencodeModel("step-5-preview-free"), true);
  assert.equal(isFreeOpencodeModel("mimo-v2.6-flash-free"), true);
  assert.equal(isFreeOpencodeModel("jev-1.13"), false);
  assert.equal(isFreeOpencodeModel("claude-sonnet-5-5"), false);
});

test("planOpencodeSync: additions and disappearances, order preserved (ym467)", () => {
  const plan = planOpencodeSync(
    ["big-pickle", "fledge-alpha-free"],
    ["big-pickle", "step-5-preview-free"],
  );
  assert.deepEqual(plan.onboard, ["step-5-preview-free"]);
  assert.deepEqual(plan.gone, ["fledge-alpha-free"]);
  // 同一集合=零动作（幂等）
  const none = planOpencodeSync(["a-free"], ["a-free"]);
  assert.deepEqual(none, { onboard: [], gone: [] });
});

test("nextFailStreak retires only after three consecutive all-fail rounds; a success clears (ym467)", () => {
  const r = (ok: number) => [{ modelId: "opencode:big-pickle", calls: 10, ok, lastError: ok === 0 ? "HTTP 400: gone" : null }];
  let state: Record<string, { count: number; lastAt: string; lastError: string | null }> = {};
  let retired: string[] = [];
  for (let i = 0; i < 3; i++) {
    const out = nextFailStreak(state, r(0), `2026-10-${10 + i}T00:00:00Z`);
    state = out.state;
    retired = retired.concat(out.retired.map((x) => x.modelId));
  }
  assert.deepEqual(retired, ["opencode:big-pickle"]); // 第 3 轮达阈值出退休名单
  const cleared = nextFailStreak({ "opencode:big-pickle": { count: 2, lastAt: "x", lastError: null } }, r(10), "2026-10-13T00:00:00Z");
  assert.deepEqual(cleared.cleared, ["opencode:big-pickle"]); // 有成功即清零
  assert.deepEqual(Object.keys(cleared.state), []);
});

test("isOpencodeChannelFailure: client unreachable / auth / free-gate are channel-level; 429 and 5xx are not (ym467)", () => {
  assert.equal(isOpencodeChannelFailure(null, "opencode client unreachable: fetch failed"), true); // 客户端不可达（独立熔断因）
  assert.equal(isOpencodeChannelFailure(401, "opencode message HTTP 401"), true);
  assert.equal(isOpencodeChannelFailure(404, "opencode session create returned no id"), true); // API 形状漂移
  assert.equal(isOpencodeChannelFailure(400, "opencode upstream APIError: Upstream request failed: Free models may train on request data. Allow free endpoints in your workspace's Privacy settings to use them."), true); // 免费闸被关
  assert.equal(isOpencodeChannelFailure(400, "opencode upstream APIError: Account budget exceeded"), true);
  assert.equal(isOpencodeChannelFailure(429, "opencode message HTTP 429"), false); // 排队瞬态：换候选不熔断
  assert.equal(isOpencodeChannelFailure(503, "opencode message HTTP 503"), false);
});

test("MODELS carries the opencode-free preset wired to the serve credentials (ym467)", () => {
  const spec = MODELS[OPENCODE_FREE_KEY]!;
  assert.ok(spec, "opencode-free preset missing");
  assert.equal(spec.service, "opencode-free");
  assert.equal(spec.baseUrlEnv, "OPENCODE_SERVE_URL");
  assert.equal(spec.apiKeyEnv, "OPENCODE_SERVER_PASSWORD");
  assert.equal(OPENCODE_FREE_KEY, "opencode-free");
  assert.match(OPENCODE_CIRCUIT_KEY, /^llm\.opencode_circuit$/);
  assert.ok(MODELS[ZHIPU_FREE_KEY]); // 既有通道不回退
});
