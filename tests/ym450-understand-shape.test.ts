// ym450（承 ym447 缺口①）：understand 位在智谱免费通道的两个确定性请求形状 400/1210——
// ①messages.content.type 只收 text（多模态 content 数组被拒）；②max_tokens 越界
// （analyze 恒发 16384 + 智谱候选 4000 思考余量 = 20384 > 端点上限 16384）。
// 判别面：智谱候选 max_tokens 按端点上限夹取（非智谱候选零变化）；带图请求在免费面降级
// 纯文本 + 回执 requestSummary.imageDropped 留痕；钉选（认证/探针）保持请求形状原样打真实线。
// 全程零真实网络：外呼指向本地 stub。
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureFreeRouting, invalidateFreeRouting } from "@aihot/backend/modelwatch/routing";
import { chatJson, type ContentPart } from "@aihot/backend/providers/llm";
import { ZHIPU_FREE_KEY } from "@aihot/backend/providers/zhipu";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";

const T = tag();
const ZP_MEMBER = `zhipu:zp-shape-${T}`; // 智谱通道成员（wire id 去前缀）
const OR_MEMBER = `or-shape-${T}`; // OR 通道成员（跨通道兜底承接）
const MODELS_USED = [ZP_MEMBER, OR_MEMBER];
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const Schema = z.object({ ok: z.boolean() });
/** analyze 的 understand 带图形状：[{type:text}, {type:image_url}]。
 *  文本带运行唯一标签 T：回执逻辑键不含 subject，恒等输入会跨轮复用旧回执（不发请求）。 */
const imageUser = (marker: string): ContentPart[] => [
  { type: "text", text: `【正文】${marker}-${T}` },
  { type: "image_url", image_url: { url: IMAGE } },
];
const lastContent = (body: { messages: Array<{ content: unknown }> }) => body.messages[body.messages.length - 1]!.content;
const okReply = () => ({ id: "s-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

const insertModel = (modelId: string) =>
  sql`INSERT INTO model_watch_models (model_id, name, tier, context_length, supports_vision, supports_json, free_from)
      VALUES (${modelId}, ${modelId}, 'free_tier', 200000, false, true, now())`;
const certify = (modelId: string) =>
  sql`INSERT INTO model_free_capabilities (model_id, capability, verdict, pass_count, verdict_payload, receipt_id)
      VALUES (${modelId}, 'understand', 'qualified', 10, '{}'::jsonb, NULL)
      ON CONFLICT (model_id, capability) DO UPDATE SET verdict = 'qualified', pass_count = 10, tested_at = now()`;

const createdBudgets: string[] = [];
async function ensureBudgets() {
  for (const s of ["openrouter", "zhipu-free"]) {
    const existing = await sql`SELECT 1 FROM budgets WHERE service = ${s}`;
    if (!existing.length) createdBudgets.push(s);
  }
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('openrouter', 60, 100, 500)
            ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('zhipu-free', 90, 5000, 100000)
            ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day`;
}

before(async () => {
  await insertModel(ZP_MEMBER);
  await insertModel(OR_MEMBER);
  await certify(ZP_MEMBER);
  await certify(OR_MEMBER);
  await sql`DELETE FROM settings WHERE key IN ('llm.openrouter_circuit', 'llm.zhipu_circuit', 'modelwatch.routing')`;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.ZHIPU_API_KEY = "test-key";
});

after(async () => {
  await sql`DELETE FROM model_watch_models WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM model_free_capabilities WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM settings WHERE key IN ('llm.openrouter_circuit', 'llm.zhipu_circuit', 'modelwatch.routing')`;
  await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
  for (const s of createdBudgets) if (s !== "openrouter") await sql`DELETE FROM budgets WHERE service = ${s}`;
  delete process.env.ZHIPU_API_KEY;
  invalidateFreeRouting();
  invalidateModelCache();
  await closeDb();
});

const ask = (opts: { subject: string; user: string | ContentPart[]; maxTokens: number; pinnedModel?: string }) =>
  chatJson({
    model: ZHIPU_FREE_KEY, purpose: "understand_article", subject: opts.subject, promptVersion: "ym450-t1", system: "s",
    user: opts.user, schema: Schema, temperature: 0.2, maxTokens: opts.maxTokens, ...(opts.pinnedModel ? { pinnedModel: opts.pinnedModel } : {}),
  });

test("ym450 S02/S03: understand 位智谱承接——max_tokens 夹到 16384、带图降级纯文本并留痕", async () => {
  const bodies: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = [];
  const zpStub = await stub((_hit, req) => {
    bodies.push(JSON.parse(req.body));
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9"; // 本测只走智谱，不发 OR
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  const savedUnderstand = process.env.UNDERSTAND_MODEL;
  delete process.env.UNDERSTAND_MODEL; // 无显式指派：生产入口按证书路由解析
  invalidateModelCache();
  try {
    assert.equal(await modelFor("understand"), ZHIPU_FREE_KEY, "understand 位的生产入口解析到智谱免费预设");
    const r = await ask({ subject: `zp-${T}`, user: imageUser("理解位夹取"), maxTokens: 16_384 });
    assert.equal(r.data.ok, true);
    const body = bodies.at(-1)!;
    assert.equal(body.max_tokens, 16_384, "max_tokens 夹到端点上限（旧码 16384+4000=20384 越界 400/1210）");
    const content = lastContent(body);
    assert.equal(typeof content, "string", "带图请求在智谱面降级纯文本（旧码原样透传 content 数组被拒）");
    assert.ok((content as string).includes("理解位夹取"), "文本部分原样保留");
    assert.ok(!(content as string).includes("image_url"), "图片部分已丢弃");
    const [row] = await sql<{ request: Record<string, unknown> }[]>`SELECT request FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.request.imageDropped, true, "降级在回执留痕（imageDropped）");
    assert.equal(row!.request.maxTokens, 16_384, "回执记录的 max_tokens=夹取后值");
  } finally {
    if (savedUnderstand !== undefined) process.env.UNDERSTAND_MODEL = savedUnderstand;
    invalidateModelCache();
    await zpStub.close();
  }
});

test("ym450 S02: 同调用内两通道对照——智谱候选夹取、非智谱候选 max_tokens 零变化（跨通道降级承接）", async () => {
  const zpBodies: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = [];
  const orBodies: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = [];
  const zpStub = await stub((_hit, req) => {
    zpBodies.push(JSON.parse(req.body));
    return new Reply(400, { error: { code: "1210", message: "messages.content.type 参数非法，取值范围 ['text']" } });
  });
  const orStub = await stub((_hit, req) => {
    orBodies.push(JSON.parse(req.body));
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.OPENROUTER_BASE_URL = orStub.url;
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    const r = await ask({ subject: `chain-${T}`, user: imageUser("跨通道"), maxTokens: 20_000 });
    assert.equal(r.data.ok, true);
    assert.equal(zpBodies.at(-1)!.max_tokens, 16_384, "智谱候选：请求 20000 夹到 16384");
    assert.equal(orBodies.at(-1)!.max_tokens, 20_000, "非智谱候选：请求值原样（零变化）");
    assert.equal(typeof lastContent(orBodies.at(-1)!), "string", "OR 面同样按纯文本降级");
    const [row] = await sql<{ service: string; request: Record<string, unknown> }[]>`SELECT service, request FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.service, "openrouter", "整链智谱失败后 OR 承接（不再因带图整链失败）");
    assert.equal(row!.request.imageDropped, true, "兜底通道的降级同样留痕");
  } finally {
    await zpStub.close();
    await orStub.close();
  }
});

test("ym450 S03 认证契约: 钉选调用保持带图请求形状原样（认证的 image variant 打真实线）", async () => {
  const bodies: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = [];
  const zpStub = await stub((_hit, req) => {
    bodies.push(JSON.parse(req.body));
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    const r = await ask({ subject: `pin-${T}`, user: imageUser("钉选"), maxTokens: 16_384, pinnedModel: ZP_MEMBER });
    assert.equal(r.data.ok, true);
    const body = bodies.at(-1)!;
    assert.ok(Array.isArray(lastContent(body)), "钉选保持 content 数组（认证必须打在真实线上）");
    assert.equal(body.max_tokens, 16_384, "钉选调用的 max_tokens 同样按端点上限夹取");
    const [row] = await sql<{ request: Record<string, unknown> }[]>`SELECT request FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.request.imageDropped, undefined, "钉选调用无降级留痕");
  } finally {
    await zpStub.close();
  }
});

test("ym450 零变化: 非免费候选（付费预设）保持带图请求原样与预算算法不变", async () => {
  const bodies: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = [];
  const zpStub = await stub((_hit, req) => {
    bodies.push(JSON.parse(req.body));
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  try {
    const r = await chatJson({
      model: "glm-5.3-flash", purpose: "brand_profile", subject: `paid-${T}`, promptVersion: "ym450-t1", system: "s",
      user: imageUser("付费面"), schema: Schema, temperature: 0.2, maxTokens: 1024,
    });
    assert.equal(r.data.ok, true);
    const body = bodies.at(-1)!;
    assert.ok(Array.isArray(lastContent(body)), "非免费候选保持 content 数组");
    assert.equal(body.max_tokens, 5_024, "付费面预算算法不变（1024+4000 thinking 余量，无夹取）");
  } finally {
    await zpStub.close();
  }
});
