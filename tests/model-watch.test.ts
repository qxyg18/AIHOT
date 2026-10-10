// 免费模型信源监控：免费判定/免费截止解析/自动判定/路由矩阵（纯函数），加上注入拉取与
// 探针的完整扫描链（发现 → 24h 观察窗 → 自动判定 → 主力/替补切换 → 冻结）。全程零网络：
// OpenRouter 列表与探针都从注入进来。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { isFreePricing, parseFreeUntil, tierOfOpenRouter, verdictOfProbe, type OrModel, type ProbeResult } from "@aihot/backend/modelwatch/openrouter";
import { pickRouting, scanModelWatch } from "@aihot/backend/modelwatch/monitor";
import { getRoutingState, refreshFreeModel, type WatchRow } from "@aihot/backend/modelwatch/store";
import { getOpencodePool, onboardOpencodeModel, removeFromOpencodePool } from "@aihot/backend/opencodewatch/pool";

const T = tag();

// ---- 纯函数 ----

test("free pricing: both zero prices count as free, near-zero does not", () => {
  const raw = (pricing?: { prompt?: string; completion?: string }) => ({ id: "x/y", pricing });
  assert.equal(isFreePricing(raw({ prompt: "0", completion: "0" })), true);
  assert.equal(isFreePricing(raw({ prompt: "0.0", completion: "0" })), true);
  assert.equal(isFreePricing(raw({ prompt: "0.000001", completion: "0" })), false);
  assert.equal(isFreePricing(raw({ prompt: "0", completion: "1" })), false);
  assert.equal(isFreePricing(raw()), false);
});

test("free-until hints: ISO, English month, Chinese, absent", () => {
  assert.equal(parseFreeUntil("Great model, free until 2026-11-01 for everyone."), "2026-11-01");
  // 无年份的截止按「最近的未来同名日」解析（过了就落到明年）。断言随运行日动态取年——
  // 写死年份会在 10-10 当天转红（2026-10-10 实证：UTC 零点后 10-10 已被算过）。
  const now = new Date();
  const year = new Date(Date.UTC(now.getUTCFullYear(), 9, 10)) < now ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  assert.equal(parseFreeUntil("Free until October 10th!"), `${year}-10-10`);
  assert.equal(parseFreeUntil("限时活动：免费至10月10日，抓紧。"), `${year}-10-10`);
  assert.equal(parseFreeUntil("A solid model with nothing time-related."), null);
});

test("tier: ':free' suffix is the perpetual free tier, the rest are promo windows", () => {
  assert.equal(tierOfOpenRouter("qwen/qwen3-235b:free"), "free_tier");
  assert.equal(tierOfOpenRouter("deepseek/deepseek-chat"), "promo");
});

test("probe verdict: both pass = good, one pass = simple, none = unusable", () => {
  const p = (jsonOk: boolean, summaryOk: boolean): ProbeResult => ({
    at: new Date().toISOString(),
    json: { ok: jsonOk, ms: 10, error: null, sample: "" },
    summary: { ok: summaryOk, ms: 10, error: null, sample: "" },
  });
  assert.equal(verdictOfProbe(p(true, true)), "good");
  assert.equal(verdictOfProbe(p(false, true)), "simple");
  assert.equal(verdictOfProbe(p(true, false)), "simple");
  assert.equal(verdictOfProbe(p(false, false)), "unusable");
});

// ym196：freeModelKeyFor 已删除——legacy 桥判定单源收拢进 capability-routing.resolveFreeModel
// （bridge 语义由 tests/capability-routing.test.ts 的 resolveFreeModel 用例覆盖）。

// ---- 选任策略（纯函数） ----

const row = (id: string, over: Partial<WatchRow> = {}): WatchRow => ({
  model_id: id, name: id, vendor: "", tier: id.endsWith(":free") ? "free_tier" : "promo",
  context_length: 64000, supports_vision: false, supports_json: true, free_from: new Date(), free_until_hint: null,
  last_prompt_price: "0", last_completion_price: "0", status: "vetted", verdict: "good", verdict_at: new Date(),
  verdict_by: "test", verdict_note: null, observe_until: null, probe: null,
  policy_version: "", catalog_version: "", probe_version: "", cert_version: "", provider_facts: {}, version: 1,
  created_at: new Date(), updated_at: new Date(),
  ...over,
});

test("pickRouting: pinned wins, fallback keeps the previous primary, autoSwitch off freezes", () => {
  const rows = [row("old/old", { free_from: new Date("2026-10-01") }), row("new/new", { free_from: new Date("2026-10-02") })];
  // 新窗口优先：new/new 当主力，old/old 自动成为替补。
  const picked = pickRouting(rows, { autoSwitch: true, pinned: null }, null);
  assert.equal(picked.primary?.model_id, "new/new");
  assert.equal(picked.fallback?.model_id, "old/old");
  // 切换后：上一任主力转任替补。
  const switched = pickRouting(rows, { autoSwitch: true, pinned: null }, { primary: "old/old", fallback: null, simple: null, primaryVision: false, simpleVision: false, updatedAt: null });
  assert.equal(switched.primary?.model_id, "new/new");
  assert.equal(switched.fallback?.model_id, "old/old", "the previous primary becomes the fallback");
  // 钉选压过排序（免观察窗的语义由调用方保证）。
  const pinned = pickRouting(rows, { autoSwitch: true, pinned: "old/old" }, null);
  assert.equal(pinned.primary?.model_id, "old/old");
  // autoSwitch 关闭：维持现状零变动。
  const frozen = pickRouting(rows, { autoSwitch: false, pinned: "new/new" }, { primary: "old/old", fallback: null, simple: null, primaryVision: false, simpleVision: false, updatedAt: null });
  assert.equal(frozen.primary?.model_id, "old/old");
  assert.equal(frozen.changed, false);
});

// ---- 扫描链（测试库 + 注入，零网络） ----

const or = (id: string, over: Partial<OrModel> = {}): OrModel => ({
  id, name: id, vendor: id.includes("/") ? id.split("/")[0]! : "", tier: id.endsWith(":free") ? "free_tier" : "promo",
  contextLength: 1_200_000, supportsVision: false, supportsJson: true, supportsText: true, outputLimit: null,
  promptPrice: "0", completionPrice: "0", freeUntilHint: null, ...over,
});
const goodProbe = (): ProbeResult => ({
  at: new Date().toISOString(),
  json: { ok: true, ms: 800, error: null, sample: "" },
  summary: { ok: true, ms: 700, error: null, sample: "" },
});
const hours = (n: number) => new Date(Date.now() + n * 3600_000);

const A = or(`${T}-a/promo-a`);
const B = or(`${T}-b/free-b:free`);
const C = or(`${T}-c/promo-c`, { contextLength: 2_000_000 });

async function cleanWatch() {
  await sql`DELETE FROM model_watch_models WHERE model_id LIKE ${`${T}-%`}`;
  await sql`DELETE FROM model_watch_events WHERE model_id LIKE ${`${T}-%`}`;
  // ym473：第三路（opencode）夹具行同清——前缀与 or/zhipu 行不同，单独一档。
  await sql`DELETE FROM model_watch_models WHERE model_id LIKE ${`opencode:${T}%`}`;
  await sql`DELETE FROM model_watch_events WHERE model_id LIKE ${`opencode:${T}%`}`;
  await sql`DELETE FROM settings WHERE key LIKE 'modelwatch.%'`;
}

before(cleanWatch);
after(async () => {
  await cleanWatch();
  await closeDb();
});

test("full cycle: discover → observe → verdict → primary → fallback after the window ends", async () => {
  const fetch = (models: OrModel[]) => () => Promise.resolve(models);
  // 第 1 轮：基线。promo 进观察窗，常年免费档只陈列；没有可用的主力。
  const s1 = await scanModelWatch({ fetchModels: fetch([A, B]), probe: false });
  assert.equal(s1.added, 2);
  assert.equal(s1.routing.primary, null);
  const rows1 = await sql<{ model_id: string; status: string }[]>`SELECT model_id, status FROM model_watch_models WHERE model_id LIKE ${`${T}-%`}`;
  const st1 = new Map(rows1.map((r) => [r.model_id, r.status]));
  assert.equal(st1.get(A.id), "observing");
  assert.equal(st1.get(B.id), "listed", "the perpetual free tier is never auto-enabled");

  // 第 2 轮（+25h，探针过关）：观察窗到点自动判定，A 升主力。
  const s2 = await scanModelWatch({ fetchModels: fetch([A, B]), probeModel: async () => goodProbe(), now: hours(25) });
  assert.equal(s2.routing.primary, A.id);
  const routing2 = await getRoutingState();
  assert.equal(routing2?.primary, A.id);

  // 第 3 轮（+50h）：A 的免费窗口结束（价格翻正即从列表消失），C 新上线进观察窗；主力悬空回落常规路由。
  const s3 = await scanModelWatch({ fetchModels: fetch([B, C]), probeModel: async () => goodProbe(), now: hours(50) });
  assert.equal(s3.ended, 1);
  assert.equal(s3.added, 1);
  assert.equal(s3.routing.primary, null, "no vetted free model left: the site falls back to the regular routing");

  // 第 4 轮（+75h）：C 观察窗到点判 good，接任主力；早前上线的 A 已结束不再回来。
  const s4 = await scanModelWatch({ fetchModels: fetch([B, C]), probeModel: async () => goodProbe(), now: hours(75) });
  assert.equal(s4.routing.primary, C.id);
  const rows4 = await sql<{ model_id: string; status: string; verdict: string | null }[]>`SELECT model_id, status, verdict FROM model_watch_models WHERE model_id LIKE ${`${T}-%`}`;
  const st4 = new Map(rows4.map((r) => [r.model_id, r.status]));
  assert.equal(st4.get(A.id), "ended");
  assert.equal(st4.get(C.id), "vetted");
  assert.equal(st4.get(B.id), "listed");

  // 冻结：autoSwitch 关掉后，即使出现更好的候选也不换。
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.config', ${sql.json({ autoSwitch: false, pinned: null } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const D = or(`${T}-d/promo-d`, { contextLength: 256000 });
  const s5 = await scanModelWatch({ fetchModels: fetch([B, C, D]), probeModel: async () => goodProbe(), now: hours(100) });
  assert.equal(s5.routing.primary, C.id, "frozen: the primary stays put");
});

test("below the 1M context bar: recorded and displayed, never observed or routed", async () => {
  await cleanWatch();
  const small = or(`${T}-s/promo-small`, { contextLength: 256_000 });
  await scanModelWatch({ fetchModels: () => Promise.resolve([small, A]), probe: false });
  const s = await scanModelWatch({ fetchModels: () => Promise.resolve([small, A]), probeModel: async () => goodProbe(), now: hours(25) });
  assert.equal(s.routing.primary, A.id, "only the eligible model can become primary");
  const rows = await sql<{ model_id: string; status: string; verdict_note: string | null }[]>`SELECT model_id, status, verdict_note FROM model_watch_models WHERE model_id LIKE ${`${T}-s%`}`;
  assert.equal(rows[0]?.status, "filtered");
  assert.match(rows[0]?.verdict_note ?? "", /不足 1M/);
});

test("events record the transitions", async () => {
  await cleanWatch();
  const fetch = () => Promise.resolve([A]);
  await scanModelWatch({ fetchModels: fetch, probe: false });
  // ym249：真·结束=目录仍有别的模型而 A 不在其中；空目录另测（不再集体判 ended）。
  await scanModelWatch({ fetchModels: () => Promise.resolve([B]), probe: false });
  const kinds = await sql<{ kind: string }[]>`SELECT kind FROM model_watch_events WHERE model_id = ${A.id} ORDER BY id`;
  assert.deepEqual(kinds.map((k) => k.kind), ["free_start", "free_end"]);
});

// ---- ym249 模型护栏 ----

test("ym249 free pricing: per-request pricing (-1) and one-sided zeros are not free", () => {
  const raw = (pricing?: { prompt?: string; completion?: string }) => ({ id: "x/y", pricing });
  // OpenRouter 的 "-1" 表示按请求计价：非零，不得判免费。
  assert.equal(isFreePricing(raw({ prompt: "-1", completion: "-1" })), false);
  assert.equal(isFreePricing(raw({ prompt: "0", completion: "-1" })), false);
  assert.equal(isFreePricing(raw({ prompt: undefined, completion: "0" })), false);
});

test("ym249 empty catalog: suspicious, not a mass retirement", async () => {
  await cleanWatch();
  await scanModelWatch({ fetchModels: () => Promise.resolve([A, B]), probe: false });
  const s = await scanModelWatch({ fetchModels: () => Promise.resolve([]), probe: false });
  assert.equal(s.ok, false);
  assert.match(s.error ?? "", /不集体判 ended|目录返回空/);
  assert.equal(s.ended, 0);
  const rows = await sql<{ status: string }[]>`SELECT status FROM model_watch_models WHERE model_id = ${A.id}`;
  assert.notEqual(rows[0]?.status, "ended", "a broken catalog never retires watched models");
  const suspicious = await sql<{ kind: string }[]>`SELECT kind FROM model_watch_events WHERE kind = 'catalog_suspicious'`;
  assert.ok(suspicious.length >= 1, "the suspicious catalog is on the record");
  // 目录恢复后一切照常（真实结束仍可判定）。
  const s2 = await scanModelWatch({ fetchModels: () => Promise.resolve([B]), probe: false });
  assert.equal(s2.ended, 1);
});

test("ym249 catalog facts + CAS: refresh writes versions/facts and honours the row version", async () => {
  await cleanWatch();
  await scanModelWatch({ fetchModels: () => Promise.resolve([A]), probe: false });
  const [row] = await sql<{ version: number; catalog_version: string; provider_facts: Record<string, unknown> }[]>`
    SELECT version, catalog_version, provider_facts FROM model_watch_models WHERE model_id = ${A.id}`;
  assert.ok(row!.catalog_version.length > 0, "insert writes a catalog version");
  assert.equal(row!.provider_facts.supportsText, true, "insert writes desensitised provider facts");
  // CAS：正确版本 → 刷新成功且 version+1；过期版本 → 0 行命中放弃。
  const refreshed = await refreshFreeModel(or(A.id, { contextLength: 3_000_000, outputLimit: 4096 }), row!.version);
  assert.equal(refreshed, true);
  const [row2] = await sql<{ version: number; provider_facts: Record<string, unknown> }[]>`
    SELECT version, provider_facts FROM model_watch_models WHERE model_id = ${A.id}`;
  assert.equal(row2!.version, row!.version + 1);
  assert.equal(row2!.provider_facts.outputLimit, 4096);
  const stale = await refreshFreeModel(or(A.id), row!.version);
  assert.equal(stale, false, "a stale expected version writes nothing");
});

test("ym249 reopen resets the certificate chain; verdicts keep 24h-window semantics only", async () => {
  await cleanWatch();
  await scanModelWatch({ fetchModels: () => Promise.resolve([A]), probe: false });
  await sql`UPDATE model_watch_models SET cert_version = 'old-cert', version = 5 WHERE model_id = ${A.id}`;
  await scanModelWatch({ fetchModels: () => Promise.resolve([A]), probe: false, now: hours(1) });
  const [row] = await sql<{ status: string; cert_version: string }[]>`SELECT status, cert_version FROM model_watch_models WHERE model_id = ${A.id}`;
  assert.notEqual(row!.status, "ended");
  assert.equal(row!.cert_version, "old-cert", "a catalog refresh does not touch the certificate chain");
  // 状态仍是观察窗语义（时间到点不写证书）。
  const certs = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM model_free_capabilities WHERE model_id = ${A.id}`;
  assert.equal(certs[0]!.count, 0, "the 24h window never certifies a capability by itself");
});

// ---- ym473 第三路（opencode）成员不进 OpenRouter 目录差分/探针/槽位面 ----
// 背景：cron.model-watch.scan 每日跑 OpenRouter 目录差分，原先只豁免 zhipu: 前缀，opencode:
// 成员（第三路客户端中介通道，不在 OpenRouter 目录）会被全量误标 free_end（2026-10-09 22:30
// UTC 实证 ×11）。修复=豁免与 zhipu 同款；本段锁定三面：差分循环、observing 探针面、
// legacy 主力槽位面，加复活幂等（onboardOpencodeModel 既有路径）。

/** 第三路成员行夹具：与 opencodewatch.pool.onboardOpencodeModel 的插入形态同形（observing，无观察窗）。 */
async function insertOpencodeRow(modelId: string, name: string, status = "observing"): Promise<void> {
  await sql`INSERT INTO model_watch_models
      (model_id, name, vendor, tier, context_length, supports_vision, supports_json,
       free_from, last_prompt_price, last_completion_price, status, verdict_note, provider_facts)
    VALUES (${modelId}, ${name}, 'opencode', 'free_tier', 200000, false, true,
      now(), '0', '0', ${status}, 'ym473 test fixture',
      ${sql.json({ channel: "opencode" } as never)})`;
}

test("ym473: opencode members skip the OpenRouter catalog diff; OpenRouter members still end (control)", async () => {
  await cleanWatch();
  const ocId = `opencode:${T}-pickle`;
  await insertOpencodeRow(ocId, "Big Pickle");
  // 第一轮：目录含 A——第三路成员本就不在 OpenRouter 目录里，不得被差分循环碰。
  await scanModelWatch({ fetchModels: () => Promise.resolve([A]), probe: false });
  // 第二轮：目录换成 B——A 离场应 end（对照）；opencode 成员仍不得被碰。
  const s2 = await scanModelWatch({ fetchModels: () => Promise.resolve([B]), probe: false });
  const rows = await sql<{ model_id: string; status: string }[]>`
    SELECT model_id, status FROM model_watch_models WHERE model_id IN (${A.id}, ${ocId})`;
  const st = new Map(rows.map((r) => [r.model_id, r.status]));
  assert.equal(st.get(ocId), "observing", "the third-channel member never ends on an OpenRouter diff");
  assert.equal(st.get(A.id), "ended", "control: the OpenRouter member that left the catalog still ends");
  assert.equal(s2.ended, 1, "only the OpenRouter member is counted as ended");
  const ev = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM model_watch_events WHERE kind = 'free_end' AND model_id = ${ocId}`;
  assert.equal(ev[0]!.n, "0", "no free_end is ever recorded for the third channel");
});

test("ym473: opencode members are never probed on the OpenRouter probe face", async () => {
  await cleanWatch();
  const ocId = `opencode:${T}-probe-target`;
  await insertOpencodeRow(ocId, "Probe Fixture");
  const probed: string[] = [];
  await scanModelWatch({
    fetchModels: () => Promise.resolve([A]),
    probeModel: async (model) => {
      probed.push(model);
      return goodProbe();
    },
  });
  assert.ok(probed.includes(A.id), "control: the OpenRouter observing member is probed");
  assert.ok(!probed.includes(ocId), "the third-channel member never goes through the OpenRouter probe");
});

test("ym473: pickRouting keeps third-channel members out of the OpenRouter legacy slots", () => {
  const rows = [
    row("opencode:big-pickle", { status: "vetted" }),
    row("or/keep", { status: "vetted" }),
    row("zhipu:glm-4.7-flash", { status: "vetted" }),
  ];
  const picked = pickRouting(rows, { autoSwitch: true, pinned: null }, null);
  assert.equal(picked.primary?.model_id, "or/keep", "neither foreign channel may take the OpenRouter primary slot");
  const pinned = pickRouting(rows, { autoSwitch: true, pinned: "opencode:big-pickle" }, null);
  assert.notEqual(pinned.primary?.model_id, "opencode:big-pickle", "a pinned third-channel id cannot be routed through the OpenRouter preset either");
});

test("ym473: onboarding revives a wrongly-ended member idempotently; filtered stays retired", async () => {
  await cleanWatch();
  const member = `${T}-revive-free`;
  const ocId = `opencode:${member}`;
  await insertOpencodeRow(ocId, "Revive Fixture", "ended");
  const r1 = await onboardOpencodeModel({ model: member, name: "Revive Fixture", contextTokens: 200000, sourceUrl: "test", note: "ym473 受控复活（目录在列确认）" });
  assert.deepEqual({ created: r1.created, revived: r1.revived, retired: r1.retired }, { created: false, revived: true, retired: false });
  const [after] = await sql<{ status: string }[]>`SELECT status FROM model_watch_models WHERE model_id = ${ocId}`;
  assert.equal(after!.status, "observing", "the wrongly-ended member is observing again");
  // 复跑：零动作、零新事件（幂等）。
  const r2 = await onboardOpencodeModel({ model: member, name: "Revive Fixture", contextTokens: 200000, sourceUrl: "test", note: "ym473 幂等复跑" });
  assert.deepEqual({ created: r2.created, revived: r2.revived, retired: r2.retired }, { created: false, revived: false, retired: false });
  const ev = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM model_watch_events WHERE kind = 'opencode_onboard' AND model_id = ${ocId}`;
  assert.equal(ev[0]!.n, "1", "the rerun adds no new event");
  const pool = await getOpencodePool();
  assert.equal(pool.models.filter((m) => m === member).length, 1, "the pool carries the member exactly once");
  // filtered（连续失败摘池）不复活——机器/人工退休结论优先。
  await sql`UPDATE model_watch_models SET status = 'filtered' WHERE model_id = ${ocId}`;
  const r3 = await onboardOpencodeModel({ model: member, name: "Revive Fixture", contextTokens: 200000, sourceUrl: "test", note: "ym473 filtered 保护" });
  assert.equal(r3.retired, true);
  const [still] = await sql<{ status: string }[]>`SELECT status FROM model_watch_models WHERE model_id = ${ocId}`;
  assert.equal(still!.status, "filtered");
  // 清场：池中夹具成员移除（行/事件由 cleanWatch 收尾）。
  await removeFromOpencodePool(member, "test: ym473 cleanup");
});
