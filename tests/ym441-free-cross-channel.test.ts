// ym441（命主 2026-10-08 免费优先令）：①OR 面上下文闸 1M→100K（存量证书进路由，闸门不虚开）；
// ②免费预设候选链跨通道兜底——本通道成员 → 另一免费通道证书成员 → 抛错，整链失败才落付费；
// ③测试钉选（pinnedModel）是认证契约，钉选调用不跨通道。全程零真实网络：外呼指向本地 stub。
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureFreeRouting, invalidateFreeRouting, OPENROUTER_FREE_KEY } from "@aihot/backend/modelwatch/routing";
import { modelFor } from "@aihot/backend/editorial/models";
import { chatJson } from "@aihot/backend/providers/llm";
import { ZHIPU_FREE_KEY } from "@aihot/backend/providers/zhipu";

const T = tag();
const BIG_OR = `or-ctx256k-${T}`; // S01 正例：262144 ≥ 100K 闸
const SMALL_OR = `or-ctx96k-${T}`; // S01 反例：96000 < 100K 闸，仍被挡
const CROSS_OR = `or-cross-${T}`; // S02：OR 通道成员
const CROSS_ZP = `zhipu:zp-cross-${T}`; // S02：智谱通道成员（wire id 去前缀）
const MODELS_USED = [BIG_OR, SMALL_OR, CROSS_OR, CROSS_ZP];

const Schema = z.object({ ok: z.boolean() });

const insertModel = (modelId: string, context: number) =>
  sql`INSERT INTO model_watch_models (model_id, name, tier, context_length, supports_vision, supports_json, free_from)
      VALUES (${modelId}, ${modelId}, 'free_tier', ${context}, false, true, now())`;

const certify = (modelId: string, capability: string) =>
  sql`INSERT INTO model_free_capabilities (model_id, capability, verdict, pass_count, verdict_payload, receipt_id)
      VALUES (${modelId}, ${capability}, 'qualified', 10, '{}'::jsonb, NULL)
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
  await insertModel(BIG_OR, 262_144);
  await insertModel(SMALL_OR, 96_000);
  await insertModel(CROSS_OR, 1_100_000);
  await insertModel(CROSS_ZP, 200_000);
  for (const m of [BIG_OR, SMALL_OR, CROSS_OR, CROSS_ZP]) await certify(m, "brandProfile");
  await sql`DELETE FROM settings WHERE key IN ('llm.openrouter_circuit', 'llm.zhipu_circuit', 'modelwatch.routing')`;
});

after(async () => {
  await sql`DELETE FROM model_watch_models WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM model_free_capabilities WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM settings WHERE key IN ('llm.openrouter_circuit', 'llm.zhipu_circuit', 'modelwatch.routing')`;
  // 既有套件约定：测试库 openrouter 预算行保持缺席（ym249 AC1 断言「无行=拒发」）；zhipu-free 只在本次创建时才清。
  await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
  for (const s of createdBudgets) if (s !== "openrouter") await sql`DELETE FROM budgets WHERE service = ${s}`;
  await closeDb();
});

test("ym441 S01: OR 面上下文闸 1M→100K——262144 的持证模型进路由，96000 仍被挡", async () => {
  delete process.env.ZHIPU_API_KEY; // 本测只验 OR 面成员面，智谱通道不参与
  delete process.env.ZHIPU_BASE_URL;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9"; // 只取快照，不发请求
  invalidateFreeRouting();
  const snap = await ensureFreeRouting();
  const list = snap.capabilityRoute.brandProfile ?? [];
  assert.ok(list.some((r) => r.model === BIG_OR), "262144 的持证模型跨过 100K 闸（原 1M 闸下同口径计数=0）");
  assert.ok(!list.some((r) => r.model === SMALL_OR), "96000 仍被 100K 闸挡住（闸门只放宽到 100K，未虚开）");
  assert.ok(list.every((r) => r.channel === "openrouter"), "OR 面成员通道戳正确");
  assert.equal(await modelFor("brandProfile"), OPENROUTER_FREE_KEY, "生产入口解析到免费预设（证书已可承接）");
});

test("ym441 S02: 候选链跨通道兜底——OR 通道全挂，同一调用落智谱承接", async () => {
  const orStub = await stub(() => new Reply(503, { error: "or down" }));
  const zpStub = await stub(() => ({ id: "zp-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  process.env.OPENROUTER_BASE_URL = orStub.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.ZHIPU_API_KEY = "test-key";
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    const r = await chatJson({ model: OPENROUTER_FREE_KEY, purpose: "brand_profile", subject: `cross-a-${T}`, promptVersion: "t16", system: "s", user: `u cross-a ${T}`, schema: Schema });
    assert.equal(r.data.ok, true);
    assert.ok(orStub.hits() >= 1, "A 通道（OR）有真实尝试且全挂");
    assert.equal(zpStub.hits(), 1, "B 通道（智谱）承接，整链失败才落付费");
    const [row] = await sql<{ service: string; model: string }[]>`SELECT service, model FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.service, "zhipu-free", "回执服务名=实际承接通道");
    assert.ok(!row!.model!.startsWith("zhipu:"), "wire id 已去通道前缀");
    const [attempts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${r.receiptId} AND service = 'zhipu-free'`;
    assert.equal(attempts!.n, 1, "智谱面恰一次尝试落账");
  } finally {
    await orStub.close();
    await zpStub.close();
  }
});

test("ym441 S02 反向: 智谱通道全挂，同一调用落 OpenRouter 承接", async () => {
  const orStub = await stub(() => ({ id: "or-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const zpStub = await stub(() => new Reply(503, { error: "zp down" }));
  process.env.OPENROUTER_BASE_URL = orStub.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.ZHIPU_API_KEY = "test-key";
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    const r = await chatJson({ model: ZHIPU_FREE_KEY, purpose: "brand_profile", subject: `cross-b-${T}`, promptVersion: "t16", system: "s", user: `u cross-b ${T}`, schema: Schema });
    assert.equal(r.data.ok, true);
    assert.ok(zpStub.hits() >= 1, "A 通道（智谱）有真实尝试且全挂");
    assert.equal(orStub.hits(), 1, "B 通道（OpenRouter）承接");
    const [row] = await sql<{ service: string; model: string }[]>`SELECT service, model FROM receipts WHERE id = ${r.receiptId}`;
    assert.equal(row!.service, "openrouter", "回执服务名=实际承接通道");
  } finally {
    await orStub.close();
    await zpStub.close();
  }
});

test("ym441 认证契约: 钉选（pinnedModel）调用不跨通道——A 通道全挂不落 B", async () => {
  const orStub = await stub(() => ({ id: "or-x", choices: [{ message: { content: '{"ok":true}' } }] }));
  const zpStub = await stub(() => new Reply(503, { error: "zp down" }));
  process.env.OPENROUTER_BASE_URL = orStub.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.ZHIPU_API_KEY = "test-key";
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    await assert.rejects(
      chatJson({ model: ZHIPU_FREE_KEY, pinnedModel: CROSS_ZP, purpose: "brand_profile", subject: `pin-${T}`, promptVersion: "t16", system: "s", user: `u pin ${T}`, schema: Schema }),
      /HTTP 503/,
    );
    assert.equal(orStub.hits(), 0, "钉选链不跨通道：另一通道的模型不得为被钉模型代考");
    assert.ok(zpStub.hits() >= 1, "被钉通道真实尝试后失败");
  } finally {
    await orStub.close();
    await zpStub.close();
  }
});
