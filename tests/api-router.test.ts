// 统一接口路由（命主令 2026-10-05）：权重链排序 / 断链与连续 5 分钟异常切换 / 账户级配额
// 当日切走 / UTC 配额日自动重置 / 免费池按今日次数轮派（成员耗尽跳过）/ 免费日上限 /
// chatJson 跨供应商故障转移 / 显式指派与复核位不转移。全程零真实网络：三家供应商全部
// 指向本地 stub。路由默认关闭（无 settings 行）= 旧行为，由 capability-routing /
// default-model 既有用例守护，本文件只测路由开启后的增量。
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import {
  apiRouteChain, freePoolOrder, invalidateApiRouterCache, isFreeAccountQuotaError,
  markFreeMemberExhausted, routerReport, routerState, routeForPurpose,
} from "@aihot/backend/providers/api-router";
import { chatJson } from "@aihot/backend/providers/llm";
import { ensureFreeRouting, invalidateFreeRouting, OPENROUTER_FREE_KEY } from "@aihot/backend/modelwatch/routing";
import { saveCapabilityRoute } from "@aihot/backend/modelwatch/capability-routing";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";

const T = tag();
const MODEL = `router-free-${T}`;
// brandProfile 不在 setup.ts 的 AIHOT_MODELS 环境覆盖清单里：天然未指派，正好当路由能力位。
const CAP = "brandProfile";
const PURPOSE = "brand_profile";
// 免费位资格看 key 是否配置（credential 读环境）：先例口径 ??= test-key，收尾还原。
const ENV_BACKUP = { base: process.env.OPENROUTER_BASE_URL, key: process.env.OPENROUTER_API_KEY };
process.env.OPENROUTER_API_KEY ??= "test-key";

const enableRouter = async (over: { enabled?: boolean; weights?: Record<string, number>; freeDailyCap?: number } = {}) => {
  const cfg = {
    enabled: over.enabled ?? true,
    weights: { free: 100, mimo: 50, glm: 10, ...(over.weights ?? {}) },
    freeDailyCap: over.freeDailyCap ?? 1_000_000,
  };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('llm.api_router', ${sql.json(cfg as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'test', updated_at = now()`;
  invalidateApiRouterCache();
};

const seedFreeModel = async () => {
  await sql`INSERT INTO model_watch_models (model_id, name, tier, context_length, supports_vision, supports_json, free_from)
            VALUES (${MODEL}, ${MODEL}, 'free_tier', 1000000, false, true, now())
            ON CONFLICT (model_id) DO NOTHING`;
  await saveCapabilityRoute({ modelId: MODEL, capability: CAP, verdict: "qualified", passCount: 10, payload: {}, receiptId: null });
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.routing', ${sql.json({ primary: MODEL, fallback: null, simple: null, primaryVision: false, simpleVision: false, updatedAt: new Date().toISOString() } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'test', updated_at = now()`;
  invalidateFreeRouting();
  await ensureFreeRouting();
};

const freeBudget = () =>
  sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('openrouter', 60, 100, 500)
      ON CONFLICT (service) DO UPDATE SET per_minute = 60, per_hour = 100, per_day = 500`;

const ask = (subject: string) =>
  chatJson({ model: OPENROUTER_FREE_KEY, purpose: PURPOSE, subject, promptVersion: "tr1", system: "s", user: `u ${subject}`, schema: z.object({ ok: z.boolean() }) });

after(async () => {
  if (ENV_BACKUP.base) process.env.OPENROUTER_BASE_URL = ENV_BACKUP.base; else delete process.env.OPENROUTER_BASE_URL;
  if (ENV_BACKUP.key) process.env.OPENROUTER_API_KEY = ENV_BACKUP.key; else delete process.env.OPENROUTER_API_KEY;
  await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state', 'llm.openrouter_circuit', 'modelwatch.routing', 'models.brandProfile')`;
  await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
  await sql`DELETE FROM model_free_capabilities WHERE model_id = ${MODEL}`;
  await sql`DELETE FROM model_watch_models WHERE model_id = ${MODEL}`;
  invalidateApiRouterCache();
  invalidateFreeRouting();
  invalidateModelCache();
  await closeDb();
});

// ---- 纯函数与状态机 ----

test("isFreeAccountQuotaError：402 与 free-models-per-day 口径的 429 是账户级；普通限流不是", () => {
  assert.equal(isFreeAccountQuotaError(402, "Insufficient credits"), true);
  assert.equal(isFreeAccountQuotaError(429, "User has exceeded the free-models-per-day rate limit. Add 10 credits to unlock 1000 free requests"), true);
  assert.equal(isFreeAccountQuotaError(429, "Rate limit exceeded for model x, try again in 1s"), false);
  assert.equal(isFreeAccountQuotaError(500, "boom"), false);
  assert.equal(isFreeAccountQuotaError(null, "connect failed"), false);
});

test("routerReport：断链立即切换；429/5xx 连续满 5 分钟才切换；成功清计数；当日粘性", async (t: TestContext) => {
  await enableRouter();
  try {
    // 断链：立即 down
    await routerReport("glm", { ok: false, kind: "connect", status: null, message: "connect failed: ECONNREFUSED" });
    let st = await routerState();
    assert.equal(st.providers.glm.down, true, "断链立即切换");
    assert.match(st.providers.glm.reason ?? "", /断链/);

    // streak：第一次只记起点
    await routerReport("mimo", { ok: false, kind: "streak", status: 503, message: "HTTP 503" });
    st = await routerState();
    assert.equal(st.providers.mimo.down, false, "单次 5xx 不切换");
    assert.ok(st.providers.mimo.streakStart, "记下连续异常起点");
    // 4 分钟后仍异常：未满 5 分钟不切
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(4 * 60_000);
    await routerReport("mimo", { ok: false, kind: "streak", status: 503, message: "HTTP 503 again" });
    st = await routerState();
    assert.equal(st.providers.mimo.down, false, "未满 5 分钟不切换");
    // 满 5 分钟：切换，当日粘性（成功也不回切）
    t.mock.timers.tick(2 * 60_000);
    await routerReport("mimo", { ok: false, kind: "streak", status: 503, message: "HTTP 503 3rd" });
    st = await routerState();
    assert.equal(st.providers.mimo.down, true, "连续 5 分钟请求异常切换");
    assert.match(st.providers.mimo.reason ?? "", /连续 5 分钟/);
    await routerReport("mimo", { ok: true });
    st = await routerState();
    assert.equal(st.providers.mimo.down, true, "当日粘性：成功不自动回切（次日自动回第一个）");
    t.mock.timers.reset();
  } finally {
    await sql`DELETE FROM settings WHERE key = 'llm.api_router_state'`;
    invalidateApiRouterCache();
  }
});

test("UTC 配额日翻页：昨天的健康态自动重置，切走的接口回到可用（每天自动回第一个）", async () => {
  await enableRouter();
  await routerReport("free", { ok: false, kind: "quota", status: 402, message: "Insufficient credits" });
  assert.equal((await routerState()).providers.free.down, true);
  await sql`UPDATE settings SET value = jsonb_set(value, '{day}', '"2020-01-01"') WHERE key = 'llm.api_router_state'`;
  invalidateApiRouterCache();
  const st = await routerState();
  assert.equal(st.providers.free.down, false, "新的一天：免费位恢复第一个");
  assert.equal(st.day, new Date().toISOString().slice(0, 10), "按 UTC 配额日翻页");
});

// ---- 链解析与轮派 ----

test("apiRouteChain：权重降序；免费位无证书/超日上限让位；复核位永不走免费", async () => {
  await seedFreeModel();
  await enableRouter();
  const hadMimoKey = "XIAOMI_MIMO_API_KEY" in process.env;
  const mimoKeyBefore = process.env.XIAOMI_MIMO_API_KEY;
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  try {
    // brandProfile 有证书：免费位链首
    assert.deepEqual(await apiRouteChain(CAP), [OPENROUTER_FREE_KEY, "mimo-v2.6-flash", "default"]);
    // score 无证书（且 setup.ts 给了 env 覆盖，路由不接管）：显式指派恒单模型
    assert.deepEqual(await routeForPurpose("score_article", "glm-5.3-flash-selection"), ["glm-5.3-flash-selection"]);
    // 复核位排除免费
    await saveCapabilityRoute({ modelId: MODEL, capability: "ossDigestReview", verdict: "qualified", passCount: 10, payload: {}, receiptId: null });
    invalidateFreeRouting();
    await ensureFreeRouting();
    const chain = await apiRouteChain("ossDigestReview", { excludeFree: true });
    assert.equal(chain[0], "mimo-v2.6-flash", "复核位从 MIMO 起（绝不与被复核同源）");
    // 权重重排：GLM 抬到最高
    await enableRouter({ weights: { glm: 200, mimo: 50, free: 10 } });
    assert.equal((await apiRouteChain(CAP))[0], "default", "权重改动即时反映（缓存失效后）");
  } finally {
    if (hadMimoKey) process.env.XIAOMI_MIMO_API_KEY = mimoKeyBefore;
    else delete process.env.XIAOMI_MIMO_API_KEY;
    await sql`DELETE FROM model_free_capabilities WHERE model_id = ${MODEL} AND capability = 'ossDigestReview'`;
    await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state')`;
    invalidateApiRouterCache();
    invalidateFreeRouting();
    await ensureFreeRouting();
  }
});

test("免费池轮派：今日已用次数少的先上；成员耗尽当日跳过", async () => {
  const a = `${MODEL}-a`;
  const b = `${MODEL}-b`;
  const lkey = `pool-r-${T}`;
  await enableRouter();
  try {
    // 给 a 记一次今日实发（池排序只看 receipt_attempts 的 per-model 计数，走最小种子）
    await sql`INSERT INTO receipts (logical_key, service, model, purpose, subject, status) VALUES (${lkey}, 'openrouter', ${a}, ${`pool-${T}`}, 'seed', 'completed')`;
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, origin, status, started_at, finished_at)
              SELECT id, 1, 'openrouter', ${a}, 'live', 'received', now(), now() FROM receipts WHERE logical_key = ${lkey}`;
    assert.deepEqual(await freePoolOrder([a, b]), [b, a], "次数少的先派（b 零次在前）");
    await markFreeMemberExhausted(b, "HTTP 429: Rate limit exceeded for model b");
    assert.deepEqual(await freePoolOrder([a, b]), [a], "耗尽成员当日不再派");
    const st = await routerState();
    assert.ok(st.exhaustedFree.includes(b), "耗尽名单在案（次日自动清空）");
  } finally {
    await sql`DELETE FROM receipts WHERE logical_key = ${lkey}`;
    await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state')`;
    invalidateApiRouterCache();
  }
});

// ---- modelFor 与 chatJson 集成 ----

test("modelFor：路由启用走链首（免费证书位→免费；免费让位→MIMO）；显式后台切换仍最高优先", async () => {
  await seedFreeModel();
  await enableRouter();
  try {
    const hadMimoKey = "XIAOMI_MIMO_API_KEY" in process.env;
    const mimoKeyBefore = process.env.XIAOMI_MIMO_API_KEY;
    process.env.XIAOMI_MIMO_API_KEY = "test-key";
    try {
      invalidateModelCache();
      assert.equal(await modelFor(CAP), OPENROUTER_FREE_KEY, "证书位链首=免费");
      // 免费位当日切走 → 链首=MIMO（无需白班窗：路由启用即取代白班窗语义）
      await routerReport("free", { ok: false, kind: "quota", status: 402, message: "Insufficient credits" });
      invalidateModelCache();
      assert.equal(await modelFor(CAP), "mimo-v2.6-flash", "免费让位后 MIMO 顶上（全天候）");
      // 显式后台切换最高优先：不走路由
      await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.brandProfile', ${sql.json({ model: "deepseek-flash" } as never)}, 'test')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      invalidateModelCache();
      assert.equal(await modelFor(CAP), "deepseek-flash", "后台显式指派仍最高优先");
      await sql`DELETE FROM settings WHERE key = 'models.brandProfile'`;
    } finally {
      if (hadMimoKey) process.env.XIAOMI_MIMO_API_KEY = mimoKeyBefore;
      else delete process.env.XIAOMI_MIMO_API_KEY;
    }
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state')`;
    invalidateApiRouterCache();
    invalidateModelCache();
  }
});

test("chatJson 跨供应商故障转移：免费 402 → MIMO 接住；免费位当日切走，后续直发 MIMO", async () => {
  await seedFreeModel();
  await enableRouter();
  await freeBudget();
  const orHits: string[] = [];
  const or = await stub((hit, req) => {
    orHits.push(JSON.parse(req.body).model);
    return new Reply(402, { error: { message: "Insufficient credits. This account never purchased credits. Add 10 credits to unlock 1000 free model requests per day" } });
  });
  const mimoBodies: string[] = [];
  const mimo = await stub((_hit, req) => {
    mimoBodies.push(JSON.parse(req.body).model);
    return { id: "mimo-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  const had = { or: { base: process.env.OPENROUTER_BASE_URL, key: process.env.OPENROUTER_API_KEY }, mimo: { base: process.env.XIAOMI_MIMO_BASE_URL, key: process.env.XIAOMI_MIMO_API_KEY } };
  process.env.OPENROUTER_BASE_URL = or.url;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.XIAOMI_MIMO_BASE_URL = mimo.url;
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  try {
    // 第一次：免费 402（账户级）→ 链转移到 MIMO，一次成功
    const r1 = await ask(`failover-${T}`);
    assert.equal(r1.model, "mimo-v2.6-flash", "免费拒绝后由 MIMO 接住");
    assert.equal(or.hits(), 1, "免费位只撞了一次");
    assert.equal(mimo.hits(), 1);
    assert.deepEqual(orHits, [MODEL], "撞的就是证书成员");
    // 免费位已当日切走：第二次直发 MIMO
    const r2 = await ask(`failover2-${T}`);
    assert.equal(r2.model, "mimo-v2.6-flash");
    assert.equal(or.hits(), 1, "切走后不再撞免费通道");
    assert.equal(mimo.hits(), 2);
    // 回执落两家 service，审计面可追溯
    const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM receipts WHERE subject IN (${`failover-${T}`}, ${`failover2-${T}`}) ORDER BY service`;
    assert.ok(services.some((s) => s.service === "mimo"), "MIMO 回执在案");
    const st = await routerState();
    assert.equal(st.providers.free.down, true, "免费位当日健康态=已切走");
    assert.match(st.providers.free.reason ?? "", /免费额度/);
  } finally {
    await sql`DELETE FROM budgets WHERE service = 'openrouter'`;
    await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state', 'llm.openrouter_circuit')`;
    invalidateApiRouterCache();
    invalidateFreeRouting();
    await ensureFreeRouting();
    await or.close();
    await mimo.close();
    if (had.or.base) process.env.OPENROUTER_BASE_URL = had.or.base; else delete process.env.OPENROUTER_BASE_URL;
    if (had.or.key) process.env.OPENROUTER_API_KEY = had.or.key; else delete process.env.OPENROUTER_API_KEY;
    if (had.mimo.base) process.env.XIAOMI_MIMO_BASE_URL = had.mimo.base; else delete process.env.XIAOMI_MIMO_BASE_URL;
    if (had.mimo.key) process.env.XIAOMI_MIMO_API_KEY = had.mimo.key; else delete process.env.XIAOMI_MIMO_API_KEY;
  }
});

test("免费日上限：今日实发达到上限 → 免费位让位（次日自动回来）", async () => {
  await seedFreeModel();
  await enableRouter({ freeDailyCap: 1 });
  try {
    // 今日（UTC 配额日）免费通道已有实发（上一用例的 402 也算一次实发）——上限 1 即触发让位。
    const hadMimoKey = "XIAOMI_MIMO_API_KEY" in process.env;
    const mimoKeyBefore = process.env.XIAOMI_MIMO_API_KEY;
    process.env.XIAOMI_MIMO_API_KEY = "test-key";
    try {
      invalidateModelCache();
      const m = await modelFor(CAP);
      assert.notEqual(m, OPENROUTER_FREE_KEY, "到上限后免费位不再链首");
      assert.equal(m, "mimo-v2.6-flash");
    } finally {
      if (hadMimoKey) process.env.XIAOMI_MIMO_API_KEY = mimoKeyBefore;
      else delete process.env.XIAOMI_MIMO_API_KEY;
    }
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('llm.api_router', 'llm.api_router_state')`;
    invalidateApiRouterCache();
    invalidateModelCache();
  }
});
