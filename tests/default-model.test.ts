// The open-source default: one OpenAI-compatible model (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) runs every
// step of the analysis, with no per-step configuration.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { TestContext } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";

// ym241 counts mimoUsable evaluations inside modelFor (the lazy short-circuit card). The mock must
// register before editorial/models is loaded, so the editorial imports below are dynamic. Module
// mocking needs --experimental-test-module-mocks; under the plain `npm test` invocation the
// counting test skips itself, and the mock is a pass-through wrapper, so behavior is unchanged.
let mimoUsableCalls = 0;
const mockHarness = mock as unknown as {
  module?: (specifier: string, options: { exports: Record<string, unknown> }) => void;
};
const canMockModules = typeof mockHarness.module === "function";
const realMimo = canMockModules ? await import("@aihot/backend/providers/mimo") : null;
if (mockHarness.module && realMimo) {
  mockHarness.module("@aihot/backend/providers/mimo", {
    exports: {
      MIMO_CIRCUIT_KEY: realMimo.MIMO_CIRCUIT_KEY,
      MIMO_CIRCUIT_COOLDOWN_MS: realMimo.MIMO_CIRCUIT_COOLDOWN_MS,
      isMimoBalanceError: (status: number | null, message: string) => realMimo.isMimoBalanceError(status, message),
      mimoCircuitOpen: () => realMimo.mimoCircuitOpen(),
      mimoCircuitRemainingMs: () => realMimo.mimoCircuitRemainingMs(),
      mimoUsable: async () => {
        mimoUsableCalls += 1;
        return realMimo.mimoUsable();
      },
      openMimoCircuit: (reason: string) => realMimo.openMimoCircuit(reason),
    },
  });
}

const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { analyzeArticle } = await import("@aihot/backend/editorial/analyze");
const { invalidateModelCache, modelFor, MIMO_SHIFT_MODEL, routeToMimo, ShiftWaitError } = await import("@aihot/backend/editorial/models");
// The circuit key comes from the same module face as production (mocked in the counting test).
const { MIMO_CIRCUIT_KEY } = await import("@aihot/backend/providers/mimo");
const { stopBoss } = await import("@aihot/backend/jobs/queue");

// Nothing chosen per step: every capability falls back to the `default` model.
for (const name of Object.keys(process.env)) if (/_MODEL$/.test(name) && name !== "LLM_MODEL" && name !== "EMBEDDING_MODEL") delete process.env[name];

const T = tag();
const SOURCE = `test-default-model-${T}`;
const seen: Array<{ model: string; system: string }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const user = String(body.messages.at(-1)!.content);
  seen.push({ model: body.model, system });
  const content =
    system.includes("宽召回") ? { label: "PASS", reason: "测试" }
    : system.includes("事件注意力评分器") ? { attentionScore: 80 }
    : system.includes("内容理解编辑") ? { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "理由", titleZh: "一个模型的标题", summaryZh: "一个模型写的摘要。第二句。" }
    : system.includes("资料结构化助手") ? { category: "ai-products", tags: ["产品更新"], subjects: [], fact: null }
    : user.includes("title_zh") ? "title_zh: 标题\nsummary_zh: 摘要。"
    : null;
  if (content === null) throw new Error("unexpected request");
  return { id: `stub-${seen.length}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true" });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test default model', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("one model runs the prefilter, both scores, the writing and the structure", async (t) => {
  // ym434: inside the daytime shift a deployment without MIMO (or with its circuit open) now waits
  // (ShiftWaitError) instead of falling back to the plan model — the one-model invariant holds
  // inside the plan window, where falling back to `default` is the intended behavior.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 13, 12, 0) }); // 2026-10-13 20:00 Beijing
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}`, title: `A product launch ${T}`, bodyText: `A company launched a product with pricing and availability. ${T} `.repeat(6),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  const res = await analyzeArticle(articleId);
  assert.equal(res!.output!.selected, true);
  assert.equal(res!.output!.titleZh, "一个模型的标题");
  assert.equal(seen.length, 5, "prefilter, two scores, understand, structure");
  assert.ok(seen.every((r) => r.model === "one-model"), "every request names the configured model");
  const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
  assert.deepEqual(services.map((s) => s.service), ["llm"]);
});

test("ym241: mimoUsable is evaluated only when the MIMO shift route is reachable", async (t: TestContext) => {
  if (!canMockModules) return t.skip("mimoUsable counting needs --experimental-test-module-mocks");
  // Beijing wall clock (fixed UTC+8, same convention as lib/windows.ts).
  const bj = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 8, mi);
  const hadKey = "XIAOMI_MIMO_API_KEY" in process.env;
  const keyBefore = process.env.XIAOMI_MIMO_API_KEY;
  try {
    t.mock.timers.enable({ apis: ["Date"], now: bj(2026, 9, 29, 14, 0) }); // before any MIMO window
    process.env.XIAOMI_MIMO_API_KEY = "test-key";
    const base = mimoUsableCalls;

    invalidateModelCache();
    assert.equal(await modelFor("prefilter"), "default");
    assert.equal(mimoUsableCalls - base, 0, "before any mimo window: zero evaluations");

    // Live shift on a plan-live day, circuit closed: the one path that still pays for the probe.
    t.mock.timers.tick(bj(2026, 10, 8, 14, 0) - bj(2026, 9, 29, 14, 0)); // forward 9 days
    invalidateModelCache();
    assert.equal(await modelFor("prefilter"), MIMO_SHIFT_MODEL);
    assert.equal(mimoUsableCalls - base, 1, "live shift: exactly one mimoUsable evaluation");

    // An explicit admin switch wins before the shift route, so the probe is never paid.
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.prefilter', ${sql.json({ model: "deepseek-flash" } as never)}, 'test')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    try {
      invalidateModelCache();
      assert.equal(await modelFor("prefilter"), "deepseek-flash");
      assert.equal(mimoUsableCalls - base, 1, "override: zero extra mimoUsable evaluations");
    } finally {
      await sql`DELETE FROM settings WHERE key = 'models.prefilter'`;
    }

    // Circuit open inside the window (ym434): probed exactly once, then the shift waits — the
    // fallback to `default` here was the ym431 audit P1-1 plan-model splash.
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${MIMO_CIRCUIT_KEY}, ${sql.json({ openUntil: "2100-01-01T00:00:00.000Z" } as never)}, 'test')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    try {
      invalidateModelCache();
      await assert.rejects(() => modelFor("prefilter"), (error: unknown) => error instanceof ShiftWaitError && error.retryable);
      assert.equal(mimoUsableCalls - base, 2, "open circuit: still exactly one evaluation in-window");
    } finally {
      await sql`DELETE FROM settings WHERE key = ${MIMO_CIRCUIT_KEY}`;
    }

    // Missing key inside the window (ym434): same wait semantics, still the single evaluation.
    delete process.env.XIAOMI_MIMO_API_KEY;
    invalidateModelCache();
    await assert.rejects(() => modelFor("prefilter"), (error: unknown) => error instanceof ShiftWaitError);
    assert.equal(mimoUsableCalls - base, 3, "missing key: one evaluation, shift wait");

    // Past the shift (ym431: the plan window starts 2026-10-13 18:00): short-circuits before the
    // probe, and falling back to the plan model is legitimate again.
    t.mock.timers.tick(bj(2026, 10, 13, 20, 0) - bj(2026, 10, 8, 14, 0)); // forward to the Tuesday switch
    invalidateModelCache();
    assert.equal(await modelFor("prefilter"), "default");
    assert.equal(mimoUsableCalls - base, 3, "after the shift: zero extra evaluations");
  } finally {
    if (hadKey) process.env.XIAOMI_MIMO_API_KEY = keyBefore;
    else delete process.env.XIAOMI_MIMO_API_KEY;
    await sql`DELETE FROM settings WHERE key = 'models.prefilter' OR key = ${realMimo!.MIMO_CIRCUIT_KEY}`;
    invalidateModelCache();
  }
});

test("ym241: routeToMimo counter-example matrix is unchanged", () => {
  // [overridden, planLive, shift, usable, expected]
  const cases = [
    [true, true, true, true, false],
    [true, true, true, false, false],
    [false, false, true, true, false],
    [false, true, false, true, false],
    [false, true, true, false, false],
    [false, true, true, true, true],
  ] as const;
  for (const [overridden, planLive, shift, usable, expected] of cases) {
    assert.equal(routeToMimo({ overridden, planLive, shift, usable }), expected, `override=${overridden} planLive=${planLive} shift=${shift} usable=${usable}`);
  }
});

test("ym434: no free route + MIMO unavailable in the shift waits instead of splashing onto the plan model", async (t) => {
  // ym431 audit P1-1: the schedule guard only covered offpeak-marked jobs, and modelFor itself
  // fell back to the plan model whenever the shift had no free-certificate route and MIMO was
  // unavailable. The gate under test: a retryable wait signal — never `default` (the plan model).
  const bj = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
  const hadKey = "XIAOMI_MIMO_API_KEY" in process.env;
  const keyBefore = process.env.XIAOMI_MIMO_API_KEY;
  t.mock.timers.enable({ apis: ["Date"], now: bj(2026, 10, 10, 14, 0) }); // Saturday midday: the shift
  try {
    process.env.XIAOMI_MIMO_API_KEY = "test-key";
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${MIMO_CIRCUIT_KEY}, ${sql.json({ openUntil: "2100-01-01T00:00:00.000Z" } as never)}, 'test')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    invalidateModelCache();
    await assert.rejects(
      () => modelFor("prefilter"),
      (error: unknown) => {
        assert.ok(error instanceof ShiftWaitError, "the wait signal is the router's ShiftWaitError");
        const wait = error as InstanceType<typeof ShiftWaitError>;
        assert.equal(wait.retryable, true, "existing retry paths treat it as a retryable rejection");
        assert.ok(wait.retryAfterSeconds >= 60 && wait.retryAfterSeconds <= 1800, "bounded retry hint");
        return true;
      },
    );
    // An explicit admin/env choice still wins: the gate only guards the unoverridden default.
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.prefilter', ${sql.json({ model: "deepseek-flash" } as never)}, 'test')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    try {
      invalidateModelCache();
      assert.equal(await modelFor("prefilter"), "deepseek-flash");
    } finally {
      await sql`DELETE FROM settings WHERE key = 'models.prefilter'`;
    }
    // From 2026-10-13 18:00 the plan window is back — the fallback is intended there.
    t.mock.timers.tick(bj(2026, 10, 13, 20, 0) - bj(2026, 10, 10, 14, 0));
    invalidateModelCache();
    assert.equal(await modelFor("prefilter"), "default", "inside the plan window the fallback is legitimate");
  } finally {
    if (hadKey) process.env.XIAOMI_MIMO_API_KEY = keyBefore;
    else delete process.env.XIAOMI_MIMO_API_KEY;
    await sql`DELETE FROM settings WHERE key = 'models.prefilter' OR key = ${MIMO_CIRCUIT_KEY}`;
    invalidateModelCache();
  }
});
