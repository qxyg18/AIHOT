// T09 (ym255): the deep-read backfill replaces per article instead of mass-deleting — a success
// swaps the row whole, a failure downgrades status but keeps the old reading payload, and rows
// the run never reached are untouched; the run is bounded (precise --limit, --max-batches, and a
// no-progress bound that stops rounds which scan but ready nothing on an unchanged failed list)
// and reports what it leaves waiting (retry backoffs, a budget stop, unworked rows) as
// waiting_external_window evidence. The insights backfill selects through the realtime gate
// (insightEligible — pass plus any editorial category) instead of a private keyword subset, with
// a receipt budget cap (--max). AC3: every provider call in here lands on a per-test stub
// endpoint; nothing calls a real model, and a rejected article is called exactly once (no blind
// re-sends inside a run).
// Receipt keys are content-based (logicalKeyFor hashes the request identity, not the article
// revision), so tests that need a fresh paid call bump the article's body first; AC1-T3 drives
// the script's own loop bound through the injected sweep seam, because the live module semantics
// (retry backoffs, receipt reuse) already converge every loop shape the T08 rewrite could find.
// Conventions (same as deepread-identity.test.ts): run with --test-concurrency=1 against a
// throwaway exclusive *_test/*_ci database; wipe this file's own pool so leftover rows never
// ride the next test's sweep.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { generateDeepRead } from "@aihot/backend/editorial/deepread";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { runBackfillDeepreads } from "../scripts/backfill-deepreads.ts";
import { runBackfillInsights } from "../scripts/backfill-insights.ts";

const T = tag();
const SOURCE = `test-backfill-scripts-${T}`;

const OK_TEXT = "这是回填脚本测试的解读文本，用来验证逐条替换行为，长度超过四十个字符的下限要求。";
const NEW_TEXT = "第二版解读：重跑之后新解读替换旧解读，覆盖解读字段的内容，留下替换完成的证据文本。";
const reading = (text: string) => ({ angle: "direct", interpretation: text });

// Stub knobs: replyStatus turns the provider rejecting; hits are 0-based call counts.
let payloadFor: (hit: number) => unknown = () => reading(OK_TEXT);
let bumpEveryCall = false;

type Provider = { url: string; hits: () => number; close: () => Promise<void> };
async function newStub(): Promise<Provider> {
  const p = await stub(async (hit) => {
    if (bumpEveryCall) await sql`UPDATE articles SET revision = revision + 1, updated_at = now()`;
    return {
      id: `stub-${hit}`,
      choices: [{ message: { content: JSON.stringify(payloadFor(hit)) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  });
  Object.assign(process.env, {
    LLM_BASE_URL: `${p.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model",
    DEEPREAD_MODEL: "one-model", MODEL_CALLS_ENABLED: "true",
  });
  return p;
}

let seq = 0;
/** A published pool article; `signal` rides the title so classification is deterministic, and
 *  publishedAt is caller-controlled because both backfill selections order newest-first. */
async function article(signal: string, publishedAt = new Date()): Promise<string> {
  seq += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}/${seq}`,
    title: `${signal} 回填脚本测试 ${seq} ${T}`,
    bodyText: `一份用于回填脚本测试的正文，包含足够长度的内容以通过最小长度校验。${seq} ${T} `.repeat(3),
    bodyStatus: "ok",
    via: "fetch",
    publishedAt,
  } as never);
  const id = articleId!;
  await sql`
    INSERT INTO publications (article_id, visibility, eligible, title, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at)
    SELECT a.id, 'public', true, a.title, a.source_id, 'news', a.url, a.published_at, a.discovered_at, a.timeline_at, a.timeline_at
    FROM articles a WHERE a.id = ${id}`;
  return id;
}

/** New body content for an existing article: a fresh receipt key (keys hash the request
 *  identity, which is content-based) plus a revision bump, without touching the publication. */
async function bumpBody(id: string, mark: string): Promise<void> {
  await sql`UPDATE articles SET body_text = ${`升级后的正文内容 ${mark}：包含足够长度的内容以通过最小长度校验，用于强制一次新的付费调用。`.repeat(3)}, revision = revision + 1, updated_at = now() WHERE id = ${id}`;
}

/** An analyzed article for the insights-backfill selection (latest analysis per article wins). */
async function analyzedArticle(relevance: string, category: string | null): Promise<string> {
  const id = await article("国家统计局");
  await sql`
    INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
    SELECT id, revision, 'model', ${relevance}, ${category}, title, '测试摘要', '测试理由', 0.9, false
    FROM articles WHERE id = ${id}`;
  return id;
}

type Row = { status: string; interpretation: string | null; retry_at: Date | null };
const rowOf = async (id: string): Promise<Row | undefined> =>
  (await sql<Row[]>`SELECT status, interpretation, retry_at FROM article_deep_reads WHERE article_id = ${id}`)[0];

async function resetState() {
  payloadFor = () => reading(OK_TEXT);
  bumpEveryCall = false;
  await sql`DELETE FROM publications WHERE source_id LIKE 'test-backfill-scripts-%'`;
  await sql`DELETE FROM analyses WHERE article_id IN (SELECT id FROM articles WHERE source_id LIKE 'test-backfill-scripts-%')`;
  await sql`DELETE FROM article_deep_reads`;
await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test backfill scripts', 'rss', 'T1', 'editorial', '2100-01-01')`;
});

after(async () => {
  // Park this file's residue outside other sweeps, then drop its pool (test-owned tables only).
  await sql`UPDATE articles SET processing_state = 'skipped' WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM publications WHERE source_id LIKE 'test-backfill-scripts-%'`;
  await sql`DELETE FROM analyses WHERE article_id IN (SELECT id FROM articles WHERE source_id = ${SOURCE})`;
  await sql`DELETE FROM article_deep_reads`;
await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
  await stopBoss();
  await closeDb();
});

test("AC1-T1: --limit N scans exactly N even when the pool is bigger (precise N, batch cut to fit)", async () => {
  const p = await newStub();
  try {
    await resetState();
    for (let i = 0; i < 7; i += 1) await article("国家统计局");
    const summary = await runBackfillDeepreads(["--limit", "3"]);
    assert.equal(summary.scanned, 3, `got ${JSON.stringify(summary)}`);
    assert.equal(summary.ready, 3);
    assert.equal(summary.stoppedReason, "limit");
    assert.equal(summary.cleared, 0, "no mode deletes first anymore");
    assert.ok(p.hits() <= 3, `no overshoot calls (got ${p.hits()})`);
  } finally {
    await p.close();
  }
});

test("AC1-T2: --max-batches bounds the run even with work left", async () => {
  const p = await newStub();
  try {
    await resetState();
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) mine.push(await article("国家统计局"));
    const summary = await runBackfillDeepreads(["--max-batches", "1"]);
    // The pool is shared with sibling suites' parked residue, so `scanned` can exceed the five
    // seeds; the bound under test is exact: one round only, and all five seeds are ready in it.
    assert.equal(summary.stoppedReason, "max_batches", `got ${JSON.stringify(summary)}`);
    assert.ok(summary.scanned >= 5, `got ${JSON.stringify(summary)}`);
    for (const id of mine) {
      const row = await rowOf(id);
      assert.equal(row?.status, "ready", `seed article got its reading in the single round: ${id}`);
    }
  } finally {
    await p.close();
  }
});

test("AC1-T3: consecutive scan-but-nothing-ready rounds on an unchanged failed list stop as no_progress", async () => {
  await resetState();
  // Drive the script's own loop bound through the sweep seam: every round "scans" 5 rows and
  // readies none while the failed list never moves — the exact F6 spin the bound exists for.
  // (The live module converges such shapes via retry backoffs and receipt reuse; the bound is
  // the defense that keeps the backfill finite if those semantics ever regress.)
  let rounds = 0;
  const summary = await runBackfillDeepreads([], {
    sweep: async () => {
      rounds += 1;
      return { scanned: 5, ready: 0, skipped: 0, failed: 0 };
    },
  });
  assert.equal(summary.stoppedReason, "no_progress", `got ${JSON.stringify(summary)}`);
  assert.equal(rounds, 2, "stops on the second unchanged zero-ready round, not never");
  assert.equal(summary.scanned, 10);
  assert.equal(summary.ready, 0);
});

test("AC1-T3b: a moved failed list resets the no-progress counter (audit ISS-4: real non-empty set path)", async () => {
  await resetState();
  // A real failed row gives failedIdSet() a non-empty list; the injected sweep moves the list
  // after round 2 (the parked row's article is deleted, so the set shrinks) — the bound must
  // reset and only fire two unchanged rounds LATER, proving the set comparison actually gates.
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}/failed-seat`,
    title: `国家统计局 回填脚本测试 失败名单座席 ${T}`,
    bodyText: `一份用于失败名单边界测试的正文，包含足够长度的内容以通过最小长度校验。${T} `.repeat(3),
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  } as never);
  const seat = articleId!;
  await sql`
    INSERT INTO article_deep_reads (article_id, status, error, input_revision, pub_revision, input_hash, attempts, retry_at, updated_at)
    VALUES (${seat}, 'failed', '名单座席', 1, 1, 'seed', 1, now() + interval '1 hour', now())`;
  let rounds = 0;
  const summary = await runBackfillDeepreads([], {
    sweep: async () => {
      rounds += 1;
      if (rounds === 2) await sql`DELETE FROM article_deep_reads WHERE article_id = ${seat}`;
      return { scanned: 5, ready: 0, skipped: 0, failed: 0 };
    },
  });
  assert.equal(summary.stoppedReason, "no_progress", `got ${JSON.stringify(summary)}`);
  assert.equal(rounds, 3, `rounds: 1 (set=A, counter 1) → 2 (set moved to ∅, counter reset 1) → 3 (set=∅ unchanged, counter 2 → stop), got ${rounds}`);
  assert.equal(summary.scanned, 15);
});

test("AC2-T4: --all never deletes — success replaces whole, failure keeps the old payload, unreached rows stay ready", async () => {
  const p = await newStub();
  try {
    await resetState();
    // Seeded oldest-first so the run's --limit 2 picks a1 and a2, leaving a3 untouched.
    const a3 = await article("国家统计局", new Date(Date.now() - 2000));
    const a2 = await article("国家统计局", new Date(Date.now() - 1000));
    const a1 = await article("国家统计局", new Date(Date.now()));
    for (const id of [a1, a2, a3]) {
      const out = await generateDeepRead(id);
      assert.equal(out.status, "ready");
    }
    // Fresh body content for a1/a2: new receipt keys, so the rerun really calls the stub
    // (a2's rejection must be a live provider rejection, not a replayed receipt). The rerun's
    // calls are counted from arm time — absolute hit counts include setup-phase requests.
    await bumpBody(a1, "甲");
    await bumpBody(a2, "乙");
    let rerunCall = 0;
    payloadFor = () => {
      const i = rerunCall++;
      if (i === 0) return reading(NEW_TEXT);
      if (i === 1) return new Reply(500, { error: "stub rejected" });
      return reading(OK_TEXT);
    };
    const setupHits = p.hits();
    const summary = await runBackfillDeepreads(["--all", "--limit", "2"]);
    assert.equal(summary.cleared, 0);
    assert.equal(summary.scanned, 2, `got ${JSON.stringify(summary)}`);
    assert.equal(summary.ready, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.stoppedReason, "limit");
    assert.equal(p.hits() - setupHits, 2, "a rejected article is called once, never re-sent inside the run");

    const r1 = await rowOf(a1);
    assert.equal(r1?.status, "ready");
    assert.equal(r1?.interpretation, NEW_TEXT, "success replaced the reading whole");

    const r2 = await rowOf(a2);
    assert.equal(r2?.status, "failed", "the failed regen downgrades status");
    assert.equal(r2?.interpretation, OK_TEXT, "the old reading payload survives the failure");
    assert.ok(r2?.retry_at, "the failure parks on a retry backoff (external window)");

    const r3 = await rowOf(a3);
    assert.equal(r3?.status, "ready", "the row the run never reached is untouched");
    assert.equal(r3?.interpretation, OK_TEXT, "no pre-delete: the unreached reading is still there");

    assert.ok(summary.waitingExternalWindow.pendingRetry >= 1, "retry-window evidence reported");
    assert.ok(summary.waitingExternalWindow.earliestRetryAt, "earliest retry timestamp reported");
  } finally {
    await p.close();
  }
});

test("AC2-T5: a budget stop leaves rows unworked and is reported as waiting_external_window", async () => {
  const p = await newStub();
  try {
    await resetState();
    await article("国家统计局");
    await article("国家统计局");
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 0, 0, 0)
      ON CONFLICT (service) DO UPDATE SET per_minute = 0, per_hour = 0, per_day = 0`;
    const summary = await runBackfillDeepreads(["--all"]);
    assert.equal(summary.stoppedReason, "budget_stopped", `got ${JSON.stringify(summary)}`);
    assert.equal(summary.scanned, 0, "a budget stop works nothing");
    assert.equal(summary.waitingExternalWindow.budgetStopped, true);
    assert.equal(p.hits(), 0, "no provider call was made");
    const [count] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM article_deep_reads`;
    assert.equal(count.n, "0", "no rows appeared");
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
  } finally {
    await p.close();
  }
});

test("AC2-T6: --force re-runs failed/skipped rows without needing staleness, replacing on success", async () => {
  const p = await newStub();
  try {
    await resetState();
    const a1 = await article("国家统计局");
    const out = await generateDeepRead(a1);
    assert.equal(out.status, "ready");
    await sql`UPDATE article_deep_reads SET status = 'failed', error = '人工标注的失败', retry_at = NULL WHERE article_id = ${a1}`;
    // Drop the committed receipt so the forced rerun is a live call (receipt keys are
    // content-based and the body is unchanged — reuse would replay the old reading).
    const [rr] = await sql<{ receipt_id: number | null }[]>`SELECT receipt_id FROM article_deep_reads WHERE article_id = ${a1}`;
    assert.ok(rr?.receipt_id);
    await sql`DELETE FROM receipts WHERE id = ${rr.receipt_id}`;
    payloadFor = () => reading(NEW_TEXT);
    const rerunBase = p.hits();
    const summary = await runBackfillDeepreads(["--force"]);
    assert.equal(summary.scanned, 1, `got ${JSON.stringify(summary)}`);
    assert.equal(summary.ready, 1);
    assert.equal(summary.stoppedReason, "completed");
    assert.equal(p.hits(), rerunBase + 1, "the forced rerun made exactly one live call");
    const r1 = await rowOf(a1);
    assert.equal(r1?.status, "ready");
    assert.equal(r1?.interpretation, NEW_TEXT, "the forced rerun replaced the reading");
  } finally {
    await p.close();
  }
});

test("AC2-T7: insights selection equals the realtime gate (all editorial categories, no keyword subset)", async () => {
  await resetState();
  const passStatistics = await analyzedArticle("pass", "statistics");
  const passChannelReport = await analyzedArticle("pass", "channel"); // title lacks report words on purpose
  const passIndustry = await analyzedArticle("pass", "industry");
  const passBrandMoves = await analyzedArticle("pass", "brand-moves");
  const blocked = await analyzedArticle("block", "statistics");

  const summary = await runBackfillInsights([]);
  assert.equal(summary.matchedArticles, 4, `the realtime gate picks pass+editorial, not a keyword subset: ${JSON.stringify(summary)}`);
  assert.equal(summary.queued, 4);
  assert.equal(summary.budgetDeferred, 0);
  for (const id of [passStatistics, passChannelReport, passIndustry, passBrandMoves]) {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'content.insight' AND data->>'articleId' = ${id}`;
    assert.equal(row?.n, "1", `the eligible article is queued exactly once: ${id}`);
  }
  const [blockedRow] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'content.insight' AND data->>'articleId' = ${blocked}`;
  assert.equal(blockedRow?.n, "0", "a blocked article is never queued");
});

test("AC2-T8: --max caps the receipts one run may cause; the rest are reported, not queued", async () => {
  await resetState();
  await analyzedArticle("pass", "statistics");
  await analyzedArticle("pass", "industry");
  await analyzedArticle("pass", "overseas");
  const summary = await runBackfillInsights(["--max", "2"]);
  assert.equal(summary.matchedArticles, 3, `got ${JSON.stringify(summary)}`);
  assert.equal(summary.queued, 2);
  assert.equal(summary.budgetDeferred, 1, "the deferred tail is reported as the budget face");
});
