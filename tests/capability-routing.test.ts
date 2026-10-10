// 免费模型能力级验收路由（ym196）：路由判定纯函数（qualified 优先/vision 过滤/断链回落）+
// purpose 反查 + 验收管线注入跑（10 样本→判卷写回→复测窗/判卷失败不写回/滚动排序）。
// ym249 追加：免费护栏段（free-only 预算/operationKey 停车/policy 强制/逐能力认证/option A
// 路由收口/overview DTO）。全程零真实网络：外呼指向本地 stub。
import { Reply, stub, tag } from "./setup.ts";
import http from "node:http";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { capabilityForPurpose, registerPurposeMap, resolveFreeModel, saveCapabilityRoute, type CapabilityRoute } from "@aihot/backend/modelwatch/capability-routing";
import { pickTestCombos, runCapabilityTests } from "@aihot/backend/modelwatch/capability-test";
import { certifyCapability } from "@aihot/backend/modelwatch/monitor";
import { ensureFreeRouting, invalidateFreeRouting, OPENROUTER_FREE_KEY } from "@aihot/backend/modelwatch/routing";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";
import { MIMO_CIRCUIT_KEY } from "@aihot/backend/providers/mimo";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { buildLlmRequest, PolicyViolationError, type LlmPolicy } from "@aihot/backend/providers/llmEndpoint";
import { modelWatchOverview } from "@aihot/backend/admin/modelwatch";

const T = tag();
const USED_MODELS: string[] = [];
const newModel = (label: string) => {
  const id = `cap-${label}-${T}`;
  USED_MODELS.push(id);
  return id;
};

const route = (model: string, vision = false): CapabilityRoute => ({ model, vision, testedAt: new Date().toISOString(), passCount: 10 });

// ---- 路由判定（纯函数） ----

test("resolveFreeModel: qualified 优先于 legacy，vision 过滤回落，全空断链走付费(null)", () => {
  const legacy = { primary: "legacy-primary", simple: null, primaryVision: false, simpleVision: false };
  assert.deepEqual(resolveFreeModel([route("qualified-1")], legacy, { vision: false, simpleEligible: false }), { model: "qualified-1", source: "capability" });
  // 能力表空 → legacy 主力兜底（免费冷启动桥）
  assert.deepEqual(resolveFreeModel([], legacy, { vision: false, simpleEligible: false }), { model: "legacy-primary", source: "legacy" });
  // vision 位：合格清单里只有非 vision 模型 → 回落 legacy vision 主力；legacy 也不支持 → null（付费）
  assert.deepEqual(resolveFreeModel([route("qualified-1", false)], { ...legacy, primaryVision: true }, { vision: true, simpleEligible: false }), { model: "legacy-primary", source: "legacy" });
  assert.equal(resolveFreeModel([route("qualified-1", false)], legacy, { vision: true, simpleEligible: false }), null);
  // 全空 → null=付费断链过渡档
  assert.equal(resolveFreeModel([], null, { vision: false, simpleEligible: true }), null);
  // 无主力有简单档：只接简单能力位
  const simpleOnly = { primary: null, simple: "simple-1", primaryVision: false, simpleVision: false };
  assert.deepEqual(resolveFreeModel([], simpleOnly, { vision: false, simpleEligible: true }), { model: "simple-1", source: "legacy" });
  assert.equal(resolveFreeModel([], simpleOnly, { vision: false, simpleEligible: false }), null);
});

test("capabilityForPurpose: 注册后按 purpose 反查能力位与 vision 要求", () => {
  registerPurposeMap({ deepread: { purposes: ["article_deep_read"], vision: false }, understand: { purposes: ["understand_article"], vision: true } });
  assert.deepEqual(capabilityForPurpose("article_deep_read"), { capability: "deepread", vision: false });
  assert.deepEqual(capabilityForPurpose("understand_article"), { capability: "understand", vision: true });
  assert.equal(capabilityForPurpose("unknown_purpose"), null);
});

// ---- 验收管线（注入调用与判卷；独立模型互不干扰） ----

const insertModel = (modelId: string) =>
  sql`INSERT INTO model_watch_models (model_id, name, tier, context_length, supports_vision, supports_json, free_from) VALUES (${modelId}, ${modelId}, 'free_tier', 1000000, false, true, now())`;

after(async () => {
  if (USED_MODELS.length) {
    await sql`DELETE FROM model_watch_models WHERE model_id IN ${sql(USED_MODELS)}`;
    await sql`DELETE FROM model_free_capabilities WHERE model_id IN ${sql(USED_MODELS)}`;
    // model_free_eval_samples 是 append-only（T01 合同触发器禁 DELETE/UPDATE）：认证样本行
    // 不清理，随一次性隔离库丢弃——触发器拦住清理本身就是合同在工作的证据。
  }
  await sql`DELETE FROM settings WHERE key IN ('modelwatch.routing', 'modelwatch.config')`;
  await closeDb();
});

test("验收管线：10 样本全过判卷 qualified → 写回；复测窗内不再入选", async () => {
  const m = newModel("ok");
  await insertModel(m);
  let calls = 0;
  const judged: Array<{ model: string; capability: string }> = [];
  const s = await runCapabilityTests({
    cap: 1,
    callModel: async () => {
      calls++;
      return { ok: true, output: { ok: 1 }, error: null };
    },
    judge: async (args) => {
      judged.push({ model: args.model, capability: args.capability });
      assert.equal(args.samples.length, 10, "每组合 10 份样本");
      return { verdict: "qualified" as const, passCount: 10, payload: { issues: "全过", judgedModel: "test" }, receiptId: 990_001 };
    },
  });
  assert.equal(calls, 10, "10 次能力调用");
  assert.equal(s.combos, 1);
  assert.equal(s.qualified, 1);
  assert.equal(judged.length, 1);
  const { model, capability } = judged[0]!;
  assert.equal(model, m);
  const [row] = await sql<{ verdict: string; pass_count: number }[]>`SELECT verdict, pass_count FROM model_free_capabilities WHERE model_id = ${m} AND capability = ${capability}`;
  assert.equal(row!.verdict, "qualified");
  assert.equal(row!.pass_count, 10);
  // 复测窗内：该组合不再出现在待测清单
  const combos = await pickTestCombos(500);
  assert.ok(!combos.some((c) => c.modelId === m && c.capability === capability), "7 天复测窗内不重测");
});

test("验收管线：rejected 写回；判卷失败不写回（组合保持未测）", async () => {
  const m = newModel("mix");
  await insertModel(m);
  const judged: Array<{ model: string; capability: string }> = [];
  const s = await runCapabilityTests({
    cap: 2,
    callModel: async () => ({ ok: true, output: {}, error: null }),
    judge: async (args) => {
      judged.push({ model: args.model, capability: args.capability });
      if (judged.length === 1) return { verdict: "rejected" as const, passCount: 3, payload: { issues: "结构挂" }, receiptId: 990_002 };
      throw new Error("判卷模型熔断");
    },
  });
  assert.equal(s.combos, 2);
  assert.equal(s.rejected, 1);
  assert.equal(s.failedCombos, 1);
  const [okRow] = await sql<{ verdict: string }[]>`SELECT verdict FROM model_free_capabilities WHERE model_id = ${judged[0]!.model} AND capability = ${judged[0]!.capability}`;
  assert.equal(okRow!.verdict, "rejected", "rejected 写回");
  const thrown = judged[1]!;
  const gone = await sql`SELECT 1 FROM model_free_capabilities WHERE model_id = ${thrown.model} AND capability = ${thrown.capability}`;
  assert.equal(gone.length, 0, "判卷失败不写回，下轮再测");
});

test("ym477 熔断闸（拍板 gate-review）：熔断态整轮跳过零调用零判卷；闸未启用/非熔断态照常跑", async () => {
  const m = newModel("circuit");
  await insertModel(m);
  let calls = 0;
  let judged = 0;
  const inject = {
    cap: 1,
    callModel: async () => {
      calls++;
      return { ok: true, output: {}, error: null };
    },
    judge: async () => {
      judged++;
      return { verdict: "qualified" as const, passCount: 10, payload: { issues: "全过" }, receiptId: 990_004 };
    },
  };
  // 熔断态：生产闸位整轮跳过（免费调用与付费判卷都不发生，事件留痕）
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${MIMO_CIRCUIT_KEY}, ${sql.json({ openUntil: new Date(Date.now() + 3_600_000).toISOString() } as never)}, 'test')`;
  try {
    const skipped = await runCapabilityTests({ ...inject, skipOnMimoCircuitOpen: true });
    assert.equal(skipped.skipped, "mimo-circuit-open");
    assert.equal(skipped.ok, true);
    assert.equal(skipped.combos, 0);
    assert.equal(calls, 0, "熔断态零能力调用");
    assert.equal(judged, 0, "熔断态零判卷（套餐消耗归零）");
    const [event] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM model_watch_events WHERE model_id = 'batch' AND kind = 'capability_test' ORDER BY id DESC LIMIT 1`;
    assert.ok(event && String(event.payload.skipped ?? "") === "mimo-circuit-open", "跳过事件留痕");
    // 闸未启用（判别性）：熔断态照常跑（旧码在此无闸，判卷照发）
    const ungated = await runCapabilityTests({ ...inject });
    assert.equal(ungated.skipped, null);
    assert.equal(judged, 1);
    // 非熔断态：闸开着也照常跑（拍板只收熔断期，常态验收节奏不变）
    await sql`DELETE FROM settings WHERE key = ${MIMO_CIRCUIT_KEY}`;
    const open = await runCapabilityTests({ ...inject, skipOnMimoCircuitOpen: true });
    assert.equal(open.skipped, null);
    assert.equal(judged, 2);
    assert.equal(calls, 20, "两轮各 10 次能力调用（跳过轮零调用）");
  } finally {
    await sql`DELETE FROM settings WHERE key = ${MIMO_CIRCUIT_KEY}`;
  }
});

test("合格线硬闸（ym196 复审 P3-1 销项）：判卷自评 qualified 但 passCount 不足线 → 落表 rejected 且 overridden 在案", async () => {
  const m = newModel("gate");
  await insertModel(m);
  const judged: Array<{ model: string; capability: string }> = [];
  const s = await runCapabilityTests({
    cap: 1,
    callModel: async () => ({ ok: true, output: {}, error: null }),
    judge: async (args) => {
      judged.push({ model: args.model, capability: args.capability });
      return { verdict: "qualified" as const, passCount: 3, payload: { issues: "判卷自评合格" }, receiptId: 990_003 };
    },
  });
  const j = judged[0]!;
  assert.ok(j, "判卷被调用");
  assert.equal(s.qualified, 0, "自评 qualified 不作数");
  assert.equal(s.rejected, 1);
  const [row] = await sql<{ verdict: string; verdict_payload: Record<string, unknown> }[]>`
    SELECT verdict, verdict_payload FROM model_free_capabilities WHERE model_id = ${j.model} AND capability = ${j.capability}`;
  assert.equal(row!.verdict, "rejected", "硬闸改判 rejected");
  assert.ok(String(row!.verdict_payload.overridden ?? "").includes("合格线"), "overridden 理由在案");
});

test("pickTestCombos: 未测排前，7 天前的旧行排复测队尾", async () => {
  const old = newModel("old");
  const fresh = newModel("fresh");
  await insertModel(old);
  await insertModel(fresh);
  await saveCapabilityRoute({ modelId: old, capability: "deepread", verdict: "qualified", passCount: 9, payload: {}, receiptId: null });
  await sql`UPDATE model_free_capabilities SET tested_at = now() - interval '8 days' WHERE model_id = ${old}`;
  const combos = await pickTestCombos(500);
  const idx = combos.findIndex((c) => c.modelId === old && c.capability === "deepread");
  assert.ok(idx >= 0, "8 天前的旧行进复测");
  assert.equal(idx, combos.length - 1, "复测在全量未测组合之后（队尾）");
  assert.ok(combos.some((c) => c.modelId === fresh), "未测组合在列");
});

// ---- ym249：免费护栏（AC1/AC2/AC4/AC5/AC6）----

const freeBudget = () =>
  sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('openrouter', 60, 100, 500)
      ON CONFLICT (service) DO UPDATE SET per_minute = 60, per_hour = 100, per_day = 500`;
const freeAsk = (subject: string, pinnedModel = `free/a-${T}`) =>
  chatJson({ model: OPENROUTER_FREE_KEY, pinnedModel, purpose: "invariant_test_free", subject, promptVersion: "t16", system: "s", user: `u ${subject}`, schema: z.object({ ok: z.boolean() }) });

test("ym249 policy: extra cannot override the free-only constraints (llmEndpoint 纯函数)", () => {
  const req = (policy?: LlmPolicy, extra?: Record<string, unknown>) =>
    buildLlmRequest({ baseUrl: "https://or.test/v1", apiKey: "k", model: "m", user: "u", temperature: 0.2, maxTokens: 10, jsonMode: false, policy, extra });
  // 无 policy：extra 原样透传（旧行为逐字节等价）。
  const legacy = JSON.parse(req(undefined, { top_p: 0.9 }).body) as Record<string, unknown>;
  assert.equal(legacy.top_p, 0.9);
  assert.equal(legacy.provider, undefined);
  // policy：provider 的 policy 键强制覆盖 extra（max_price 压不上去），非 policy 键保留。
  const capped = JSON.parse(req({ serverMaxPrice: 0, requireParameters: true, dataPolicy: "deny" }, { provider: { max_price: 5, order: ["x"] } }).body) as { provider: Record<string, unknown> };
  // ym441：max_price 的 wire 形状=对象（OpenRouter 官方口径；数字形状生产 400 实证）；policy 仍压过 extra 的 max_price=5。
  assert.deepEqual(capped.provider.max_price, { prompt: 0, completion: 0 });
  assert.equal(capped.provider.require_parameters, true);
  assert.equal(capped.provider.data_collection, "deny"); // ym441：wire 键名=data_collection（官方口径；data_policy 会 400）
  assert.deepEqual(capped.provider.order, ["x"]);
  // policy + 收费附加/身份覆盖 → 拒绝；anthropic 端点不支持 policy。
  assert.throws(() => req({ serverMaxPrice: 0 }, { tools: [{ type: "function" }] }), PolicyViolationError);
  assert.throws(() => req({ serverMaxPrice: 0 }, { plugins: [{ id: "p" }] }), PolicyViolationError);
  assert.throws(() => req({ serverMaxPrice: 0 }, { model: "other" }), PolicyViolationError);
  assert.throws(
    () => buildLlmRequest({ baseUrl: "https://z.test/anthropic", apiKey: "k", model: "m", user: "u", temperature: 0.2, maxTokens: 1, jsonMode: false, policy: { serverMaxPrice: 0 } }),
    PolicyViolationError,
  );
});

test("ym249 AC1/AC3: free-only chatJson — missing budget row sends nothing; a real call lands operation/reservation/fee evidence", async () => {
  const provider = await stub((hit) => ({ id: `s-${hit}`, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  process.env.OPENROUTER_BASE_URL = provider.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    // AC1：budgets 无 openrouter 行 → 拒绝且 0 发送。（ym438 勘正：0055 起迁移会 seed 该行，
    // 「migrations 不 seed 它」的旧假设失真——先删行保证本用例自述的缺失态，不被库内残留翻转。）
    await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
    await assert.rejects(freeAsk(`nb-${T}`), BudgetExceededError);
    assert.equal(provider.hits(), 0, "AC1: zero POST without a budgets row");

    await freeBudget();
    const r = await freeAsk(`ok-${T}`);
    assert.equal(r.reused, false);
    assert.equal(provider.hits(), 1);
    const [row] = await sql<{ cost: number | null; cost_evidence: Record<string, unknown>; has_op: boolean; reserved_input_tokens: number | null }[]>`
      SELECT cost, cost_evidence, operation_key IS NOT NULL AS has_op, reserved_input_tokens FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.cost, null, "AC3: an unknown price stays NULL, never zero");
    assert.equal(row!.cost_evidence.serverMaxPrice, 0, "AC3: fee evidence lands");
    assert.equal(row!.has_op, true, "the operation key (no model in it) is persisted");
    assert.ok((row!.reserved_input_tokens ?? 0) > 0, "the token reservation is persisted");
  } finally {
    await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
    await provider.close();
  }
});

test("ym249 AC2: an unknown first candidate stops the fallback — one POST total", async () => {
  let hits = 0;
  const killer = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on("end", () => res.destroy());
  });
  await new Promise<void>((resolve) => killer.listen(0, "127.0.0.1", resolve));
  const { port } = killer.address() as { port: number };
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_API_KEY = "test-key";
  const fallbackModel = newModel("kill-fallback");
  await insertModel(fallbackModel);
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.routing', ${sql.json({ primary: null, fallback: fallbackModel, simple: null, primaryVision: false, simpleVision: false, updatedAt: new Date().toISOString() } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  invalidateFreeRouting();
  await ensureFreeRouting();
  await freeBudget();
  try {
    await assert.rejects(freeAsk(`kill-${T}`), ReceiptUnknownError);
    assert.equal(hits, 1, "AC2: the fallback candidate is never sent — the operation key stops it first");
  } finally {
    await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
    await new Promise<void>((resolve) => killer.close(() => resolve()));
  }
});

test("ym249 AC2 对照: a known rejection still moves to the fallback within the budget", async () => {
  const provider = await stub(() => new Reply(502, { error: "bad gateway" }));
  process.env.OPENROUTER_BASE_URL = provider.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  const fallbackModel = newModel("reject-fallback");
  await insertModel(fallbackModel);
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.routing', ${sql.json({ primary: null, fallback: fallbackModel, simple: null, primaryVision: false, simpleVision: false, updatedAt: new Date().toISOString() } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  invalidateFreeRouting();
  await ensureFreeRouting();
  await freeBudget();
  try {
    await assert.rejects(freeAsk(`reject-${T}`), /HTTP 502/);
    assert.equal(provider.hits(), 2, "known rejects may switch within the approved budget");
  } finally {
    await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
    await provider.close();
  }
});

test("ym249 AC4/AC6: certifyCapability — real-schema verdicts park per capability", async () => {
  const m = newModel("cert");
  await insertModel(m);
  // 全过 → qualified；证据 append-only 落样本行；证书链版本前进。
  const r1 = await certifyCapability({ modelId: m, capability: "prefilter", samples: 10, call: async () => ({ ok: true }) });
  assert.equal(r1.verdict, "qualified");
  assert.equal(r1.passCount, 10);
  const [cap1] = await sql<{ verdict: string; pass_count: number }[]>`SELECT verdict, pass_count FROM model_free_capabilities WHERE model_id = ${m} AND capability = 'prefilter'`;
  assert.equal(cap1!.verdict, "qualified");
  const samples = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_free_eval_samples WHERE model_id = ${m} AND capability = 'prefilter'`;
  assert.equal(samples[0]!.n, 1, "one append-only sample row per variant");
  const [cert] = await sql<{ cert_version: string }[]>`SELECT cert_version FROM model_watch_models WHERE model_id = ${m}`;
  assert.match(cert!.cert_version, /certify:prefilter:qualified/);

  // 8/10=80% < 90% → rejected（park 原因在案），且 prefilter 结论不受影响（逐能力独立）。
  const r2 = await certifyCapability({ modelId: m, capability: "summarize", samples: 10, call: async (_spec, attempt) => ({ ok: attempt <= 8 }) });
  assert.equal(r2.verdict, "rejected");
  const [cap2] = await sql<{ verdict: string; verdict_payload: Record<string, unknown> }[]>`SELECT verdict, verdict_payload FROM model_free_capabilities WHERE model_id = ${m} AND capability = 'summarize'`;
  assert.equal(cap2!.verdict, "rejected");
  assert.match(String(cap2!.verdict_payload.parkReason ?? ""), /park/);
  const [cap1b] = await sql<{ verdict: string }[]>`SELECT verdict FROM model_free_capabilities WHERE model_id = ${m} AND capability = 'prefilter'`;
  assert.equal(cap1b!.verdict, "qualified", "a parked capability does not touch its siblings");

  // understand 文本/图像两 variant 分别认证（AC4：图像位单独判）。
  const r3 = await certifyCapability({ modelId: m, capability: "understand", samples: 4, call: async (spec) => ({ ok: spec.variant === "text" }) });
  assert.deepEqual(r3.variants.map((v) => v.variant), ["text", "image"]);
  assert.equal(r3.passCount, 4);
  assert.equal(r3.verdict, "rejected", "image-side failures sink the capability");

  // 未接 eval spec 的能力位：框架拒绝（不冒称认证）。
  await assert.rejects(certifyCapability({ modelId: m, capability: "deepread", call: async () => ({ ok: true }) }), /no eval spec/);
});

test("ym249 AC5(option A): capability certificates, not the observation-window bridge; Lyria never takes a text slot", async (t) => {
  // ym434: inside the daytime shift an uncertified capability with MIMO unavailable now waits
  // (ShiftWaitError) instead of falling back to the paid default — this case pins the paid-default
  // semantics inside the plan window (the shift-side wait is covered in default-model.test.ts).
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 13, 12, 0) }); // 2026-10-13 20:00 Beijing
  const m = newModel("route");
  await insertModel(m);
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.routing', ${sql.json({ primary: m, fallback: null, simple: null, primaryVision: false, simpleVision: false, updatedAt: new Date().toISOString() } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  process.env.OPENROUTER_API_KEY ??= "test-key";
  invalidateFreeRouting();
  await ensureFreeRouting();
  // 观察窗主力在快照里，但没有能力证书 → 该能力位照旧付费（legacy 桥收口）。
  assert.equal(await modelFor("brandProfile"), "default", "no certificate → the paid default; the legacy bridge is retired");

  await saveCapabilityRoute({ modelId: m, capability: "brandProfile", verdict: "qualified", passCount: 10, payload: {}, receiptId: null });
  invalidateFreeRouting();
  assert.equal(await modelFor("brandProfile"), OPENROUTER_FREE_KEY, "a certified model takes its capability slot");
  const sources = await modelSources();
  assert.equal(sources.brandProfile!.source, "free");
  assert.equal(sources.brandProfile!.evidence!.freeModel, m);
  assert.ok(sources.brandProfile!.evidence!.testedAt.length > 0, "resolved evidence carries the certification timestamp");

  // AC4 Lyria 反例：非文本模态（1M 上下文+零价的音乐模型）即使有证书行也不进文本路由。
  await sql`UPDATE model_watch_models SET provider_facts = ${sql.json({ supportsText: false, outputLimit: 1000000 } as never)} WHERE model_id = ${m}`;
  invalidateFreeRouting();
  assert.equal(await modelFor("brandProfile"), "default", "a non-text model never takes a text capability");
  // 恢复文本模态但输出上限明确不足 → 同样不路由。
  await sql`UPDATE model_watch_models SET provider_facts = ${sql.json({ supportsText: true, outputLimit: 100 } as never)} WHERE model_id = ${m}`;
  invalidateFreeRouting();
  assert.equal(await modelFor("brandProfile"), "default", "a declared-too-small output cap blocks routing");
});

test("ym249 AC1: with the model-call valve off, a free-only call sends nothing", async () => {
  process.env.OPENROUTER_API_KEY ??= "test-key";
  config.modelCallsEnabled = false;
  try {
    await assert.rejects(freeAsk(`valve-${T}`), /disabled/);
  } finally {
    config.modelCallsEnabled = true;
  }
});

test("ym249 overview DTO: catalog/fee/budget/policy/parked facts, desensitised", async () => {
  const o = await modelWatchOverview();
  assert.ok(o.catalog && typeof o.catalog.suspicious === "boolean" && typeof o.catalog.freeCount === "number");
  assert.ok(o.fee && typeof o.fee.attempts === "number" && typeof o.fee.withCostEvidence === "number");
  assert.ok(o.budget && typeof o.budget.openrouterMissing === "boolean");
  assert.ok(o.policyAndVersions && typeof o.policyAndVersions.autoSwitch === "boolean");
  assert.ok(Array.isArray(o.parked));
  const json = JSON.stringify(o);
  assert.ok(!json.includes("test-key"), "no raw credentials in the projection");
});

test("ym457 overview DTO 智谱观测三行: 熔断/预算用量/缺行告警（缺行正反例，判别性）", async () => {
  const canonical = { per_minute: 90, per_hour: 5000, per_day: 100000 }; // 0055 迁移规范值
  // 正例①：budgets 行在位 → 预算投影 + 不告警
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
            VALUES ('zhipu-free', ${canonical.per_minute}, ${canonical.per_hour}, ${canonical.per_day})
            ON CONFLICT (service) DO NOTHING`;
  const withRow = await modelWatchOverview();
  assert.ok(withRow.zhipu, "DTO 含 zhipu 观测块（旧码此处即红）");
  assert.equal(withRow.zhipu.budgetMissing, false, "行在位不告警");
  assert.equal(withRow.zhipu.budget?.per_day, canonical.per_day);
  assert.ok(typeof withRow.zhipu.used24h === "number" && withRow.zhipu.used24h >= 0);
  assert.ok(typeof withRow.zhipu.circuit.open === "boolean", "熔断状态恒有布尔投影");
  try {
    // 反例②：删行 → 缺行告警（fail-closed 判据：requireBudget 无 budgets 行即拒发）
    await sql`DELETE FROM budgets WHERE service = 'zhipu-free'`;
    const noRow = await modelWatchOverview();
    assert.equal(noRow.zhipu.budgetMissing, true, "缺行即告警");
    assert.equal(noRow.zhipu.budget, null, "缺行时预算投影为空");
  } finally {
    // 恢复规范值（不影响他套件；同时把「此前被误删」的态修回）
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
              VALUES ('zhipu-free', ${canonical.per_minute}, ${canonical.per_hour}, ${canonical.per_day})
              ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day`;
  }
});
