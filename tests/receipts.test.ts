// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), a lost answer is bought again at most once, and the
// valve stops calls before they are sent.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { BudgetExceededError, completeReceipt, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { testLlmConnection } from "@aihot/backend/admin/llmconfig";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  await provider.close();
  await closeDb();
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "socialdata", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => outcomes.push(error instanceof ModelOutputError ? "unusable" : error instanceof BudgetExceededError ? "budget" : String(error)),
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("an unknown outcome is released automatically once, so a lost answer costs at most one repeat", async () => {
  // A service without a budget row: the budget tests above may have used up deepseek's.
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  let sent = 0;
  const lost = () => {
    sent += 1;
    return Promise.reject(new Error("socket hang up after sending"));
  };
  const status = async () => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject = ${req.subject}`)[0]!.status;
  const age = () => sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${req.subject}`;

  await assert.rejects(paidRequest(req, lost));
  assert.equal(await status(), "unknown");
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "not within half an hour");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "failed");
  await assert.rejects(paidRequest(req, lost));
  assert.equal(sent, 2, "one repeat after the release");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "a second loss waits for the admin");
  await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
  assert.equal(sent, 2);
});

// ---- ym249：free-only/自治 scope 的护栏（operationKey / reservation / cost_evidence / 缺预算拒绝）----

test("ym249 free-only: a missing budgets row rejects instead of unlimited; nothing is written or sent", async () => {
  const subject = `nobudget-${tag()}`;
  let sent = 0;
  await assert.rejects(
    paidRequest(
      { service: "invariant-freeonly", purpose: "invariant_test", subject, identity: { v: tag() }, requireBudget: true },
      async () => { sent += 1; return { response: { ok: 1 } }; },
    ),
    (error: unknown) => error instanceof BudgetExceededError && /invariant-freeonly/.test(error.message),
  );
  assert.equal(sent, 0, "AC1: no POST when the budgets row is missing");
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE subject = ${subject}`;
  assert.equal(rows[0]!.n, 0, "a rejected request leaves no receipt row");
  // 旧付费语义：同一个无行服务，不带 requireBudget 仍按 unlimited 放行（既有行为不变）。
  const ok = await paidRequest({ service: "invariant-freeonly", purpose: "invariant_test", subject: `legacy-${tag()}`, identity: { v: tag() } }, async () => ({ response: { ok: 1 } }));
  assert.equal(ok.reused, false);
});

test("ym249 free-only: an unknown outcome blocks the sibling candidate models (operation key, one POST total)", async () => {
  const opKey = `op-${tag()}`;
  const base = { service: "invariant-unbudgeted", purpose: "invariant_test", identity: { v: tag() }, operationKey: opKey };
  let sent = 0;
  const lost = () => { sent += 1; return Promise.reject(new Error("socket hang up after sending")); };

  await assert.rejects(paidRequest({ ...base, subject: `opmodel-${tag()}`, model: "model-a" }, lost));
  assert.equal(sent, 1);
  // 同一操作换模型（另一 logicalKey）：立即 unknown 停车——不发送、不落新行。
  await assert.rejects(paidRequest({ ...base, subject: `opmodel-${tag()}`, model: "model-b", identity: { v: `${tag()}-b` } }, lost), ReceiptUnknownError);
  assert.equal(sent, 1, "AC2: the sibling candidate is never sent");
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE operation_key = ${opKey}`;
  assert.equal(rows[0]!.n, 1, "only the first candidate has a row");
});

test("ym249 free-only: unknowns carrying an operation key are not auto-released after 30 minutes", async () => {
  const opKey = `op-${tag()}`;
  await assert.rejects(
    paidRequest({ service: "invariant-unbudgeted", purpose: "invariant_test", subject: `keep-${tag()}`, identity: { v: tag() }, operationKey: opKey }, () => Promise.reject(new Error("lost"))),
  );
  await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE operation_key = ${opKey}`;
  await autoReleaseUnknownReceipts();
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE operation_key = ${opKey}`;
  assert.equal(row!.status, "unknown", "free-only unknowns wait for the admin, not the timer");
});

test("ym249 free-only: reservation columns and cost evidence land; a missing cost is never zero", async () => {
  const subject = `ev-${tag()}`;
  const res = await paidRequest(
    { service: "invariant-unbudgeted", purpose: "invariant_test", subject, identity: { v: tag() }, reservedTokens: { input: 111, output: 222 } },
    async () => ({ response: { ok: 1 }, cost: null, costEvidence: { basis: "provider-routing", serverMaxPrice: 0 } }),
  );
  assert.equal(res.reused, false);
  const [row] = await sql<{ reserved_input_tokens: number | null; reserved_output_tokens: number | null; cost: number | null; cost_evidence: Record<string, unknown> }[]>`
    SELECT reserved_input_tokens, reserved_output_tokens, cost, cost_evidence FROM receipts WHERE id = ${res.receiptId}`;
  assert.equal(row!.reserved_input_tokens, 111);
  assert.equal(row!.reserved_output_tokens, 222);
  assert.equal(row!.cost, null, "AC3: an unknown price stays NULL, never zero");
  assert.equal(row!.cost_evidence.serverMaxPrice, 0, "AC3: the fee evidence lands separately");
});

test("ym249 admin test connection: through the same valve and receipts, a received answer is reused", async () => {
  process.env.LLM_BASE_URL = provider.url;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  answer = () => '{"ok":true}';
  // 阀关：不发送、不落回执。
  config.modelCallsEnabled = false;
  try {
    const off = await testLlmConnection();
    assert.equal(off.ok, false);
    assert.match(off.error ?? "", /disabled/);
    assert.equal(off.receiptId, null);
  } finally {
    config.modelCallsEnabled = true;
  }
  // 走统一回执：同 identity 二次测试复用已收答案（0 新发送）。
  const before = provider.hits();
  const first = await testLlmConnection();
  assert.equal(first.ok, true, first.error ?? "connection test failed");
  const second = await testLlmConnection();
  assert.equal(provider.hits() - before, 1, "a received answer is reused without a second send");
  assert.equal(second.receiptId, first.receiptId);
  assert.ok(!JSON.stringify(first).includes("test-key"), "no raw key in the result");
  // 跨族审计 P1 销项断言：本链非 free-only scope——budgets 无 llm 行（migrations 不 seed llm）
  // 时按旧 unlimited 语义照发，但每次发送都进统一回执计数（receipt_attempts 落行）。
  const attempts = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
    WHERE r.purpose = 'admin.test_connection' AND r.subject = 'llm.config'`;
  assert.ok(attempts[0]!.n >= 1, "the connection test is counted in receipts like any other send");
});

// ---- ym302：completeReceipt 幂等（源卡 ym240/T07 审计 3473a079 ISS-1 的真缺口直断言） ----
// T07 把 completeReceipt 收进业务事务，其幂等由 coalesce 保证，但此前无任何用例直接断言；
// 这里补的是「同一回执重复提交」这一条：幂等一旦被改成 now() 重写戳，本用例会红。

test("ym302 completeReceipt: committing twice keeps the first completed_at and never reopens the row", async () => {
  const subject = `idem-${tag()}`;
  const res = await paidRequest(
    { service: "invariant-unbudgeted", purpose: "invariant_test", subject, identity: { v: tag() } },
    async () => ({ response: { ok: 1 } }),
  );
  assert.equal(res.reused, false);
  const read = async () =>
    (await sql<{ status: string; completed_at: Date | null }[]>`SELECT status, completed_at FROM receipts WHERE id = ${res.receiptId}`)[0]!;
  assert.equal((await read()).status, "received", "the answer is received before the business write commits");

  await completeReceipt(sql, res.receiptId);
  const first = await read();
  assert.equal(first.status, "completed");
  assert.ok(first.completed_at, "the first commit stamps completed_at");

  await completeReceipt(sql, res.receiptId);
  const second = await read();
  assert.equal(second.status, "completed");
  assert.equal(
    second.completed_at?.getTime(),
    first.completed_at?.getTime(),
    "a repeated commit must keep the first completed_at (coalesce), never restamp it",
  );
});
