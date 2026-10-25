// ym573（yn245-A2，命主 2026-10-14 拍板 opt-fix-pinned-strict）：钉选=认证契约，证书只认
// 被钉模型自答——钉选调用的免费候选链收敛为被钉目标单体，同通道成员不再回代答顶替出证；
// 钉选目标失败即调用失败（capability-test 的样本 catch 后记 ok=false → 判卷按判负计，
// 证书不落回代答模型名下）。旧码在钉选链里保留同通道成员与 snap.fallback：目标挂了成员
// 顶答仍 ok=true，证书错误归属被钉模型——本用例即该判别面。
// 回归护栏：非钉选调用链为不变（本通道成员垫后→跨通道垫链，ym436/ym441/ym467 语义原样）。
// 全程零真实网络：外呼指向本地 stub。
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureFreeRouting, invalidateFreeRouting } from "@aihot/backend/modelwatch/routing";
import { chatJson } from "@aihot/backend/providers/llm";
import { ZHIPU_FREE_KEY } from "@aihot/backend/providers/zhipu";

const T = tag();
const PIN = `zhipu:zp-pin-${T}`; // 被钉目标（stub 恒 500）；带通道前缀才进 zhipu 路由面（LIKE 'zhipu:%'）
const MATE = `zhipu:zp-mate-${T}`; // 同通道成员（stub 会成功——旧码会用它顶答）
const wire = (m: string) => m.replace(/^zhipu:/, "");
const MODELS_USED = [PIN, MATE];
const Schema = z.object({ ok: z.boolean() });
const okReply = () => ({ id: "s-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

const insertModel = (modelId: string) =>
  sql`INSERT INTO model_watch_models (model_id, name, tier, context_length, supports_vision, supports_json, free_from)
      VALUES (${modelId}, ${modelId}, 'free_tier', 200000, false, true, now())`;
/** tested_at 显式错开：routing primary 按 tested_at DESC——PIN 新 = 主力，MATE 旧 = 替补。 */
const certify = (modelId: string, ageSql: string) =>
  sql`INSERT INTO model_free_capabilities (model_id, capability, verdict, pass_count, verdict_payload, receipt_id, tested_at)
      VALUES (${modelId}, 'understand', 'qualified', 10, '{}'::jsonb, NULL, now() - ${ageSql}::interval)
      ON CONFLICT (model_id, capability) DO UPDATE SET verdict = 'qualified', pass_count = 10, tested_at = now() - ${ageSql}::interval`;

const createdBudgets: string[] = [];
async function ensureBudgets() {
  const existing = await sql`SELECT 1 FROM budgets WHERE service = 'zhipu-free'`;
  if (!existing.length) createdBudgets.push("zhipu-free");
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('zhipu-free', 90, 5000, 100000)
            ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day`;
}

before(async () => {
  await insertModel(PIN);
  await insertModel(MATE);
  await certify(PIN, "0 seconds");
  await certify(MATE, "1 hour");
  await sql`DELETE FROM settings WHERE key IN ('modelwatch.routing')`;
  process.env.ZHIPU_API_KEY = "test-key";
});

after(async () => {
  await sql`DELETE FROM model_watch_models WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM model_free_capabilities WHERE model_id IN ${sql(MODELS_USED)}`;
  await sql`DELETE FROM settings WHERE key IN ('modelwatch.routing')`;
  for (const s of createdBudgets) await sql`DELETE FROM budgets WHERE service = ${s}`;
  delete process.env.ZHIPU_API_KEY;
  invalidateFreeRouting();
  await closeDb();
});

const ask = (opts: { subject: string; pinnedModel?: string }) =>
  chatJson({
    model: ZHIPU_FREE_KEY, purpose: "understand_article", subject: opts.subject, promptVersion: "ym573-t1", system: "s",
    user: `钉选自答判别-${T}`, schema: Schema, temperature: 0.2, maxTokens: 1500,
    ...(opts.pinnedModel ? { pinnedModel: opts.pinnedModel, pinnedStrict: true } : {}),
  });

test("ym573: 钉选目标挂时同通道成员不回代答——调用失败（样本判负面），成员零调用", async () => {
  const mateHits: string[] = [];
  let pinHits = 0;
  const zpStub = await stub((_hit, req) => {
    const body = JSON.parse(req.body);
    if (body.model === wire(PIN)) {
      pinHits++;
      return new Reply(500, { error: { code: "1305", message: "platform overloaded" } });
    }
    mateHits.push(body.model);
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9"; // 不发 OR
  await ensureBudgets();
  invalidateFreeRouting();
  await ensureFreeRouting();
  try {
    await assert.rejects(
      ask({ subject: `pin-${T}`, pinnedModel: PIN }),
      /HTTP 500/,
      `钉选链收敛为被钉目标单体：目标 500 即整调用失败，不再回代答（pinHits=${pinHits}，mateHits=${mateHits.length}）`,
    );
    assert.ok(pinHits >= 1, "被钉目标被真实尝试");
    assert.equal(mateHits.length, 0, "同通道成员零调用（旧码在此会顶答并 ok=true）");
  } finally {
    await zpStub.close();
  }
});

test("ym573 回归护栏: 非钉选调用链不变——主力挂时同通道成员照常垫后承接", async () => {
  const seen: string[] = [];
  const zpStub = await stub((_hit, req) => {
    const body = JSON.parse(req.body);
    seen.push(body.model);
    if (body.model === wire(PIN)) return new Reply(500, { error: { code: "1305", message: "platform overloaded" } });
    return okReply();
  });
  process.env.ZHIPU_BASE_URL = zpStub.url;
  try {
    const r = await ask({ subject: `nopin-${T}` });
    assert.equal(r.data.ok, true, "非钉选：主力（PIN）挂后成员（MATE）垫后承接成功");
    assert.ok(seen.includes(wire(PIN)) && seen.includes(wire(MATE)), `垫后链真实发生（实际顺序=${seen.join("→")}）`);
  } finally {
    await zpStub.close();
  }
});
