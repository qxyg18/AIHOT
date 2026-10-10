// ym436 智谱免费通道（命主令 2026-10-08）：双通道证书合流（智谱优先）、通道判别前缀、
// legacy 槽位不收智谱成员、预设面（端点凭据/缺省主力）。纯函数面；chatJson 候选链的
// 端到端行为由 api-router/capability-routing 既有套件与夜批验收管线覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCapabilityRoutes, type QualifiedRow } from "../packages/backend/src/modelwatch/routing.ts";
import { channelOfModel } from "../packages/backend/src/modelwatch/capability-routing.ts";
import { pickRouting } from "../packages/backend/src/modelwatch/monitor.ts";
import type { WatchRow } from "../packages/backend/src/modelwatch/store.ts";
import { MODELS } from "../packages/backend/src/providers/llm.ts";
import { ZHIPU_FREE_KEY } from "../packages/backend/src/providers/zhipu.ts";

const row = (over: Partial<QualifiedRow>): QualifiedRow => ({
  capability: "summarize",
  model_id: "zhipu:glm-4.7-flash",
  supports_vision: false,
  tested_at: "2026-10-08T12:00:00.000Z",
  pass_count: 10,
  cert_version: null,
  ...over,
});

test("mergeCapabilityRoutes puts zhipu members first and stamps channels (ym436)", () => {
  const merged = mergeCapabilityRoutes(
    [row({ model_id: "zhipu:glm-4.7-flash", pass_count: 10 })],
    [row({ model_id: "meta/llama-x:free", pass_count: 9 }), row({ model_id: "qwen/qwq:free", pass_count: 10 })],
  );
  const list = merged.summarize!;
  assert.equal(list.length, 3);
  assert.equal(list[0]!.model, "zhipu:glm-4.7-flash"); // 智谱优先（命主口径）
  assert.equal(list[0]!.channel, "zhipu");
  assert.equal(list[1]!.channel, "openrouter");
  assert.equal(list[2]!.channel, "openrouter");
});

test("mergeCapabilityRoutes dedupes per capability×model, keeps a model across capabilities (ym436)", () => {
  const merged = mergeCapabilityRoutes(
    [row({ capability: "prefilter", model_id: "zhipu:glm-4.7-flash" }), row({ capability: "prefilter", model_id: "zhipu:glm-4.7-flash" })],
    [],
  );
  assert.equal(merged.prefilter!.length, 1); // 同能力同模型去重
  const two = mergeCapabilityRoutes([row({ capability: "a", model_id: "zhipu:glm-4.7-flash" }), row({ capability: "b", model_id: "zhipu:glm-4.7-flash" })], []);
  assert.equal(two.a!.length, 1);
  assert.equal(two.b!.length, 1); // 跨能力持证保留
});

test("channelOfModel reads the zhipu: prefix", () => {
  assert.equal(channelOfModel("zhipu:glm-4.7-flash"), "zhipu");
  assert.equal(channelOfModel("meta/llama-x:free"), "openrouter"); // ':' 后缀不算通道前缀
});

const watchRow = (over: Record<string, unknown>): WatchRow => over as unknown as WatchRow;

test("pickRouting never promotes zhipu members into the legacy OpenRouter slots (ym436)", () => {
  const zhipuOnly = [watchRow({ model_id: "zhipu:glm-4.7-flash", status: "vetted", tier: "free_tier", free_from: null, context_length: 200000, supports_vision: false })];
  const picked = pickRouting(zhipuOnly, { autoSwitch: true, pinned: null }, null);
  assert.equal(picked.primary, null); // 智谱成员绝不进 openrouter-free 预设的槽位
  const mixed = [...zhipuOnly, watchRow({ model_id: "a/big:free", status: "vetted", tier: "promo", free_from: new Date(), context_length: 1_100_000, supports_vision: false })];
  const picked2 = pickRouting(mixed, { autoSwitch: true, pinned: null }, null);
  assert.equal(picked2.primary?.model_id, "a/big:free");
});

test("zhipu-free preset: own endpoint credentials and a sane default model (ym436)", () => {
  const spec = MODELS[ZHIPU_FREE_KEY]!;
  assert.equal(spec.service, "zhipu-free");
  assert.equal(spec.baseUrlEnv, "ZHIPU_BASE_URL");
  assert.equal(spec.apiKeyEnv, "ZHIPU_API_KEY");
  assert.equal(spec.model, "glm-4.7-flash"); // 快照空时的缺省主力
  assert.equal(spec.jsonMode, true);
});
