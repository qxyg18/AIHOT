// T07 (ym240): the viewpoint replace write is one transaction with a revision CAS. AC1: a failure
// injected after the DELETE never leaves a half-replaced set — the old viewpoints survive whole.
// AC2: a revision that moved while the model was in flight abandons the pass, and the retry reuses
// the raw receipt answer without re-sending. AC3: concurrent passes never interleave batches, a
// replay of the same input reproduces its rows, and an empty pass legally clears the article.
// Each test drives its own stub provider so hit counts stay per-test (chatJson reads the endpoint
// env at call time, so pointing LLM_BASE_URL at a fresh stub per test just works).
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { extractInsights } from "@aihot/backend/editorial/insights";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

// ym434 rework（shoumen 一审 P1-1）：insight 位在测试里显式指派 default——否则白天窗+无
// MIMO/免费凭据下 modelFor 抛等待信号，把 AC1-AC3 的事务语义断言整个遮蔽（失败点前移）。
process.env.INSIGHT_MODEL ??= "default";

const T = tag();
const SOURCE = `test-insights-tx-${T}`;

type InsightItem = {
  entity_id: string;
  entity_name: string;
  kind: string;
  stance: string;
  statement: string;
  figures: Array<{ value: string; unit: string; caliber: string }>;
  quote: string;
  org: string;
};

const batch = (name: string, statements: string[]): { insights: InsightItem[] } => ({
  insights: statements.map((s, i) => ({
    entity_id: "",
    entity_name: name,
    kind: "performance",
    stance: "positive",
    statement: s,
    figures: [{ value: String(i + 1), unit: "亿元", caliber: "全年" }],
    quote: `引文${i + 1}`,
    org: "测试机构",
  })),
});

// What the model "answers"; `bumpArticle` simulates a re-analysis landing in the model-in-flight
// window (the stub bumps the article revision before returning the payload).
let payloadFor: (hit: number) => { insights: InsightItem[] } = () => batch("默认批", ["默认观点"]);
let bumpArticle: string | null = null;

type Provider = { url: string; hits: () => number; close: () => Promise<void> };
async function newStub(): Promise<Provider> {
  const p = await stub(async (hit) => {
    if (bumpArticle) {
      const id = bumpArticle;
      bumpArticle = null;
      await sql`UPDATE articles SET revision = revision + 1, updated_at = now() WHERE id = ${id}`;
    }
    return {
      id: `stub-${hit}`,
      choices: [{ message: { content: JSON.stringify(payloadFor(hit)) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  });
  Object.assign(process.env, { LLM_BASE_URL: `${p.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true" });
  return p;
}

let seq = 0;
async function article(label: string): Promise<string> {
  seq += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}/${label}-${seq}`,
    title: `研报观点事务测试 ${label} ${seq} ${T}`,
    bodyText: `一份关于童装品牌与商业体的研究报告正文，包含业绩数字、客流判断与开店计划，正文长度超过截断阈值下限。${label} ${seq} ${T} `.repeat(4),
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  } as never);
  return articleId!;
}

type Row = { statement: string; entity_name: string | null; input_revision: number; receipt_id: number | null; figures: unknown };
const insightsOf = (id: string) =>
  sql<Row[]>`SELECT statement, entity_name, input_revision, receipt_id, figures FROM report_insights WHERE article_id = ${id} ORDER BY id`;
const receiptStatus = async (id: number) => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`)[0]!.status;
const articleRevision = async (id: string) => (await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${id}`)[0]!.revision;

// Test-owned injection fixture: a marker row plus a BEFORE INSERT trigger that raises while the
// marker is on — the failure lands exactly between the (rolled-back) DELETE and the batch INSERT.
async function installInject() {
  await sql`CREATE TABLE IF NOT EXISTS _t07_inject (fail boolean NOT NULL DEFAULT false)`;
  await sql`INSERT INTO _t07_inject (fail) VALUES (false)`;
  await sql`CREATE OR REPLACE FUNCTION _t07_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
            BEGIN
              IF EXISTS (SELECT 1 FROM _t07_inject WHERE fail) THEN
                RAISE EXCEPTION 'T07 injected insert failure';
              END IF;
              RETURN NEW;
            END $fn$`;
  await sql`DROP TRIGGER IF EXISTS _t07_before_insert ON report_insights`;
  await sql`CREATE TRIGGER _t07_before_insert BEFORE INSERT ON report_insights
            FOR EACH ROW EXECUTE FUNCTION _t07_fail_insert()`;
}
const setInject = (on: boolean) => sql`UPDATE _t07_inject SET fail = ${on}`;
async function dropInject() {
  await sql`DROP TRIGGER IF EXISTS _t07_before_insert ON report_insights`;
  await sql`DROP FUNCTION IF EXISTS _t07_fail_insert()`;
  await sql`DROP TABLE IF EXISTS _t07_inject`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test insights tx', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await dropInject();
  // Residue articles are deleted outright: since 0052 the archive trigger takes an explicit column
  // list, so the DELETE lands the row in articles_archived (cascades clear the related rows)
  // instead of erroring or parking the residue outside the sweep's filter. Receipts of this file's
  // own subject prefix are swept too — AC1 asserts an exact receipt list, which otherwise
  // accumulates across runs and turns any second run on the same database red.
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM receipts WHERE subject LIKE ${"研报观点事务测试%"}`;
  await stopBoss();
  await closeDb();
});

test("AC1: an injected failure after the DELETE leaves the old viewpoints whole (zero half-write)", async () => {
  const p = await newStub();
  try {
    const id = await article("ac1");
    payloadFor = () => batch("旧批实体", ["旧观点甲", "旧观点乙"]);
    const first = await extractInsights(id);
    assert.equal(first.ok, true);
    assert.equal(first.count, 2);

    await installInject();
    try {
      await setInject(true);
      payloadFor = () => batch("新批实体", ["新观点甲", "新观点乙", "新观点丙"]);
      await assert.rejects(extractInsights(id, { attemptTag: "ac1-second" }), /T07 injected insert failure/);

      const kept = await insightsOf(id);
      assert.deepEqual(kept.map((r) => r.statement), ["旧观点甲", "旧观点乙"], "old batch survives whole, zero half-write");
      assert.ok(kept.every((r) => r.entity_name === "旧批实体"), "no row of the failed batch leaked");
      assert.deepEqual(kept[0]!.figures, [{ value: "1", unit: "亿元", caliber: "全年" }], "figures stay a parsed jsonb array");

      // The failed pass's raw answer is kept reusable (received); the committed one is completed.
      const receipts = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject LIKE ${`研报观点事务测试 ac1%`} ORDER BY id`;
      assert.deepEqual(receipts.map((r) => r.status), ["completed", "received"]);

      await setInject(false);
      const retry = await extractInsights(id, { attemptTag: "ac1-second" });
      assert.equal(retry.ok, true, "retry with the same input succeeds once the injection is gone");
      assert.equal(retry.count, 3);
      assert.equal(p.hits(), 2, "the retry reuses the received raw — no re-send");
      assert.deepEqual((await insightsOf(id)).map((r) => r.statement), ["新观点甲", "新观点乙", "新观点丙"]);
      assert.equal(await receiptStatus(retry.receiptId!), "completed");
    } finally {
      await dropInject();
    }
  } finally {
    await p.close();
  }
});

test("AC2: a revision bump during the model call abandons the pass; the retry reuses the raw", async () => {
  const p = await newStub();
  try {
    const id = await article("ac2");
    payloadFor = () => batch("乙批实体", ["乙观点一", "乙观点二", "乙观点三"]);
    bumpArticle = id;

    const stale = await extractInsights(id);
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "stale revision");
    assert.equal(await articleRevision(id), 2, "the stub really bumped the revision mid-flight");
    assert.equal((await insightsOf(id)).length, 0, "the stale input is not written to revision 2");
    assert.equal(await receiptStatus(stale.receiptId!), "received", "raw kept in the reusable state");

    const retried = await extractInsights(id);
    assert.equal(retried.ok, true);
    assert.equal(retried.count, 3);
    assert.equal(p.hits(), 1, "the retry re-sent nothing — paidRequest reused the raw");
    const rows = await insightsOf(id);
    assert.ok(rows.every((r) => r.input_revision === 2), "rows carry the revision the retry actually read");
    assert.ok(rows.every((r) => r.entity_name === "乙批实体"));
    assert.equal(await receiptStatus(retried.receiptId!), "completed");
  } finally {
    await p.close();
  }
});

test("AC3: concurrent passes never interleave; replay is stable; an empty pass legally clears", async () => {
  const p = await newStub();
  try {
    const id = await article("ac3");
    payloadFor = (hit) => (hit === 1
      ? batch("X批实体", ["X观点一", "X观点二"])
      : batch("Y批实体", ["Y观点一", "Y观点二", "Y观点三"]));

    const [a, b] = await Promise.all([
      extractInsights(id, { attemptTag: "ac3-a" }),
      extractInsights(id, { attemptTag: "ac3-b" }),
    ]);
    assert.equal(a.ok && b.ok, true);
    assert.equal(p.hits(), 2, "both passes really called the model (distinct attempt tags)");

    const after = await insightsOf(id);
    assert.equal(new Set(after.map((r) => r.receipt_id)).size, 1, "one batch only — no interleaving");
    const statements = after.map((r) => r.statement);
    assert.ok(
      JSON.stringify(statements) === JSON.stringify(["X观点一", "X观点二"]) ||
      JSON.stringify(statements) === JSON.stringify(["Y观点一", "Y观点二", "Y观点三"]),
      `a whole batch survived (${statements.join(",")})`,
    );

    const replay = await extractInsights(id, { attemptTag: "ac3-b" });
    assert.equal(replay.ok, true);
    assert.equal(replay.count, 3);
    assert.equal(p.hits(), 2, "replaying a completed receipt re-sends nothing");
    assert.deepEqual((await insightsOf(id)).map((r) => r.statement), ["Y观点一", "Y观点二", "Y观点三"], "same input, same rows");

    payloadFor = () => ({ insights: [] });
    const empty = await extractInsights(id, { attemptTag: "ac3-empty" });
    assert.equal(empty.ok, true, "an empty viewpoint set is a legal clear, not an error");
    assert.equal(empty.count, 0);
    assert.equal((await insightsOf(id)).length, 0, "the article's insights are cleared at the current revision");
    assert.equal(await receiptStatus(empty.receiptId!), "completed");
  } finally {
    await p.close();
  }
});
