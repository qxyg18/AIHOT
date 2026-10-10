// T08 (ym245): a deep reading is only valid for the inputs that produced it. AC1: a content
// revision bump or a prompt/vocab basis change voids the stored reading (the public read returns
// a miss and the sweep re-reads it), and a revision that moved while the model was in flight is
// never committed (transaction CAS — the old reading survives whole). AC2: a budget stop leaves
// no row and halts the sweep round; a transient provider rejection records a failed row with a
// retry_at backoff (not a fake terminal skip), climbing to an attempt ceiling. AC3: the old
// reading's payload survives every failed re-read until a newer success replaces it, skipped
// rows are permanent until their input identity moves, and legacy NULL-identity rows read as a
// miss (0052's contract). Each test drives its own stub provider (chatJson reads the endpoint
// env at call time), so hit counts stay per-test.
// Conventions this file relies on (audit delta P3): run with --test-concurrency=1 against a
// throwaway exclusive *_test/*_ci database, as the suite already does — resetState wipes the
// whole article_deep_reads table and T9/T10 rewrite the shared seed files byte-for-byte, which
// is only safe single-threaded on a test-owned database.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { __deepreadTestHooks, classifyArticle, generateDeepRead, loadDeepReadForSite, sweepDeepReads } from "@aihot/backend/editorial/deepread";
import { BRANDS_FILE } from "@aihot/backend/leaderboard/directory";
import { ENTITIES } from "@aihot/industry/taxonomy";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-deepread-id-${T}`;

// What the model "answers". `bumpArticle` simulates a re-analysis landing in the model-in-flight
// window (the stub bumps the article revision before returning); `replyStatus` turns the stub
// into a rejecting provider (non-2xx → ProviderRejectedError). All readings clear the schema's
// 40-char floor.
const reading = (text: string) => ({ angle: "direct", interpretation: text });
const OK_TEXT = "这是深读身份测试的解读文本，用来验证输入身份绑定的行为，长度超过四十个字符的下限要求。";
const OLD_TEXT = "第一版解读：旧输入下生成的大白话深读文本，这里补足长度以确保超过四十个字符的下限要求。";
const NEW_TEXT = "第二版解读：新输入下生成的大白话深读文本，这里补足长度以确保超过四十个字符的下限要求。";
const KEEP_TEXT = "旧解读原文：这个字段必须在重读失败之后被完整地保留下来，作为解读数据不会丢失的证据存在。";
const FRESH_TEXT = "新解读原文：重试成功之后新解读替换旧解读，覆盖全部解读字段的内容，留下替换完成的证据。";
let payloadFor: (hit: number) => unknown = () => reading(OK_TEXT);
let bumpArticle: string | null = null;
let replyStatus = 0;

/** Per-test state reset: these module-level knobs leak across tests otherwise, and earlier
 *  rounds' leftover rows (e.g. a failed row past its retry_at) would ride the next round's
 *  sweep and break the scanned===0 assertions — the table is test-owned, so wipe it. */
async function resetState() {
  payloadFor = () => reading(OK_TEXT);
  bumpArticle = null;
  replyStatus = 0;
  // Wipe this file's whole candidate pool: earlier rounds' articles left with no deep-read row
  // would ride every sweep's LIMIT ahead of the CASE-weighted stale rows (structural starvation)
  // — dropping their publications removes them from the sweep's FROM clause entirely, and
  // deleting the rows keeps the table test-owned. Articles stay (the archive trigger is another
  // file's landmine); a publication-less article is invisible to the sweep.
  await sql`DELETE FROM publications WHERE source_id LIKE 'test-deepread-id-%'`;
  await sql`DELETE FROM article_deep_reads`;
}

type Provider = { url: string; hits: () => number; close: () => Promise<void> };
async function newStub(): Promise<Provider> {
  const p = await stub(async (hit) => {
    if (replyStatus) return new Reply(replyStatus, { error: "stub rejected" });
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
  Object.assign(process.env, {
    LLM_BASE_URL: `${p.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model",
    DEEPREAD_MODEL: "one-model", MODEL_CALLS_ENABLED: "true",
  });
  return p;
}

let seq = 0;
/** A published pool article. `signal` rides the title so classification lands deterministically:
 *  a macro signal (国家统计局) earns a reading; a plain title with no seed hit earns a skip.
 *  `at` pins the publication date — rule 7 (2026-10-05) gives every October-on article a plain
 *  reading, so the skip-verdict tests pass an explicit pre-cutoff date. */
async function article(signal: string, at: Date = new Date()): Promise<string> {
  seq += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}/${seq}`,
    title: `${signal} 深读身份测试 ${seq} ${T}`,
    bodyText: `一份用于深读输入身份测试的正文，包含足够长度的内容以通过最小长度校验。${seq} ${T} `.repeat(3),
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: at,
  } as never);
  const id = articleId!;
  await sql`
    INSERT INTO publications (article_id, visibility, eligible, title, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at)
    SELECT a.id, 'public', true, a.title, a.source_id, 'news', a.url, a.published_at, a.discovered_at, a.timeline_at, a.timeline_at
    FROM articles a WHERE a.id = ${id}`;
  return id;
}

type Row = {
  status: string; skip_reason: string | null; error: string | null;
  input_revision: number | null; pub_revision: number | null; input_hash: string | null;
  attempts: number; retry_at: Date | null; interpretation: string | null;
};
const rowOf = async (id: string): Promise<Row | undefined> =>
  (await sql<Row[]>`SELECT status, skip_reason, error, input_revision, pub_revision, input_hash, attempts, retry_at, interpretation
                    FROM article_deep_reads WHERE article_id = ${id}`)[0];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test deepread identity', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  // Park this file's residue outside the sweep's filter (same note as insights-transaction.test.ts).
  await sql`UPDATE articles SET processing_state = 'skipped' WHERE source_id = ${SOURCE}`;
await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
  await stopBoss();
  await closeDb();
});

test("AC1-T1: a revision bump voids the reading (public read misses, sweep re-reads)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    const first = await generateDeepRead(id);
    assert.equal(first.ok, true);
    assert.equal(first.status, "ready");
    assert.ok((await loadDeepReadForSite(id)) != null, "a current reading is public");

    await sql`UPDATE articles SET revision = revision + 1, updated_at = now() WHERE id = ${id}`;
    assert.equal(await loadDeepReadForSite(id), null, "a moved revision no longer presents as current");

    await sweepDeepReads(5);
    assert.ok((await loadDeepReadForSite(id)) != null, "after the re-read the fresh reading is public again");
    const row = await rowOf(id);
    assert.equal(row!.input_revision, 2, "the stored identity carries the revision it read");
    assert.equal(row!.attempts, 0);
    assert.equal(row!.retry_at, null);
  } finally {
    await p.close();
  }
});

test("AC1-T2: a basis change voids the reading the same way (simulated vocab/prompt edit)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    assert.equal((await generateDeepRead(id)).status, "ready");

    await sql`UPDATE article_deep_reads SET input_hash = 'stale-basis-simulated-vocab-edit' WHERE article_id = ${id}`;
    assert.equal(await loadDeepReadForSite(id), null, "a stale basis no longer presents as current");

    await sweepDeepReads(5);
    const row = await rowOf(id);
    assert.notEqual(row!.input_hash, "stale-basis-simulated-vocab-edit", "the re-read stores the current basis");
    assert.ok((await loadDeepReadForSite(id)) != null);
  } finally {
    await p.close();
  }
});

test("AC1-T3: a revision bump mid-flight is not committed; the old reading survives whole", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    payloadFor = () => reading(OLD_TEXT);
    assert.equal((await generateDeepRead(id)).status, "ready");
    const hitsAfterFirst = p.hits();

    // An article edit moves the revision to 2 (the stored row goes stale on its own), and the
    // changed body gives the retry a fresh operation key — otherwise paidRequest would reuse the
    // first call's raw and never reach the stub (the receipt-reuse path is a feature, not a bug).
    await sql`UPDATE articles SET revision = revision + 1, body_text = body_text || ' 修文补充段落，改变模型输入。', updated_at = now() WHERE id = ${id}`;
    // The stub bumps the revision once more (2 → 3) while the model call is in flight.
    bumpArticle = id;
    payloadFor = () => reading(NEW_TEXT);
    const stale = await generateDeepRead(id);
    assert.equal(stale.ok, false);
    assert.equal(stale.status, "pending");
    assert.equal(stale.error, "stale revision");

    const row = await rowOf(id);
    assert.equal(row!.interpretation, OLD_TEXT,
      "the stale pass wrote nothing over the old reading");
    assert.equal(row!.status, "ready", "the row keeps its prior state");
    assert.equal(row!.input_revision, 1, "the stored identity still points at revision 1");

    // The retry on the current inputs lands normally — and reuses the stale pass's raw answer
    // (same inputs as the in-flight call) without a re-send.
    const retry = await generateDeepRead(id);
    assert.equal(retry.status, "ready");
    assert.equal((await rowOf(id))!.input_revision, 3, "the retry commits against the bumped revision");
    assert.equal((await loadDeepReadForSite(id))!.interpretation, NEW_TEXT);
    assert.equal(p.hits(), hitsAfterFirst + 1, "the retry re-sent nothing — paidRequest reused the raw");
  } finally {
    await p.close();
  }
});

test("AC2-T4: a budget stop leaves no row and halts the round (nothing counted as scanned)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const a1 = await article("国家统计局");
    const a2 = await article("国家统计局");
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 0, 0, 0)
      ON CONFLICT (service) DO UPDATE SET per_minute = 0, per_hour = 0, per_day = 0`;

    const stats = await sweepDeepReads(5);
    assert.equal(stats.scanned, 0, `a global budget stop counts nothing worked (got ${JSON.stringify(stats)})`);
    assert.equal(await rowOf(a1), undefined, "the budget-stopped article has no row");
    assert.equal(await rowOf(a2), undefined, "the round halted — later articles were not even attempted");
    assert.equal(p.hits(), 0, "no provider call was made");

    // "Budget back" = the migration 0036 defaults restored (a missing row is fail-closed since
    // ym436, so a bare DELETE here would keep the sweep rejected, not unblocked).
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
    const after = await sweepDeepReads(5);
    assert.ok(after.ready >= 1, "with the budget back the sweep works the same articles");
  } finally {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 300, 6000, 40000)
      ON CONFLICT (service) DO UPDATE SET per_minute = 300, per_hour = 6000, per_day = 40000`;
    await p.close();
  }
});

test("AC2-T5: a transient rejection records a failed row with retry_at backoff, bounded by MAX_ATTEMPTS", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    replyStatus = 503;
    const out = await generateDeepRead(id);
    assert.equal(out.ok, false);
    assert.equal(out.status, "pending", "a provider rejection is a recoverable wait, not a terminal skip");
    let row = await rowOf(id);
    assert.equal(row!.status, "failed");
    assert.equal(row!.skip_reason, null, "not recorded as skipped");
    assert.equal(row!.attempts, 1);
    assert.ok(row!.retry_at != null && row!.retry_at > new Date(), "retry_at is a future backoff (15min)");

    // While the backoff holds, the sweep does not touch this row (assertions anchor on the row,
    // not on the sweep's global counts — leftover pool articles from other files may ride in).
    await sweepDeepReads(5);
    let afterWait = await rowOf(id);
    assert.equal(afterWait!.attempts, 1, "an unexpired backoff keeps the row untouched");

    // Expire it: the sweep retries, fails again (attempts climbs), then the ceiling stops it.
    await sql`UPDATE article_deep_reads SET retry_at = now() - interval '1 second' WHERE article_id = ${id}`;
    await sweepDeepReads(5);
    row = await rowOf(id);
    assert.equal(row!.attempts, 2);
    assert.ok(row!.retry_at != null, "second failure backs off again (30min)");

    await sql`UPDATE article_deep_reads SET retry_at = now() - interval '1 second' WHERE article_id = ${id}`;
    await sweepDeepReads(5);
    row = await rowOf(id);
    assert.equal(row!.attempts, 3);
    assert.equal(row!.retry_at, null, "at the ceiling retry_at goes NULL — automatic retries stop");

    // No retry_at rewrite here — a ceiling row's retry_at is NULL, which the sweep's
    // (retry_at IS NULL OR ...) clause already admits, so if the terminal guard works the row
    // stays exactly as the third round left it.
    await sweepDeepReads(5);
    afterWait = await rowOf(id);
    assert.equal(afterWait!.attempts, 3, "past the ceiling the row is terminal until its input moves");
    assert.equal(afterWait!.retry_at, null);

    // A moved input restarts the clock and the provider is healthy again.
    replyStatus = 0;
    await sql`UPDATE article_deep_reads SET input_hash = 'stale-basis-simulated-vocab-edit' WHERE article_id = ${id}`;
    await sweepDeepReads(5);
    row = await rowOf(id);
    assert.equal(row!.status, "ready", "an input change re-opens the row and the re-read lands");
    assert.equal(row!.status, "ready");
    assert.equal(row!.attempts, 0);
  } finally {
    replyStatus = 0;
    await p.close();
  }
});

test("AC3-T6: a skipped row is permanent — the sweep leaves it alone until its identity moves", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("普通无信号", new Date("2026-09-15T10:00:00+08:00")); // pre-cutoff: no seed hit, no macro signal
    const out = await generateDeepRead(id);
    assert.equal(out.status, "skipped");
    let row = await rowOf(id);
    assert.equal(row!.status, "skipped");
    assert.equal(row!.retry_at, null, "a skip is a permanent verdict, not a wait");
    const basis = row!.input_hash;

    await sweepDeepReads(5);
    assert.equal((await rowOf(id))!.input_hash, basis, "a steady skipped row never re-enters the sweep");

    // A vocab/basis change (simulated) re-opens it; the re-verdict refreshes the identity.
    await sql`UPDATE article_deep_reads SET input_hash = 'stale-basis-simulated-vocab-edit' WHERE article_id = ${id}`;
    await sweepDeepReads(5);
    row = await rowOf(id);
    assert.equal(row!.status, "skipped");
    assert.equal(row!.input_hash, basis, "the re-verdict stamps the current basis — back to steady");
    await sweepDeepReads(5);
    assert.equal((await rowOf(id))!.input_hash, basis, "and it stops there: no endless rescanning");
    assert.equal(p.hits(), 0, "a skip verdict costs no provider call");
  } finally {
    await p.close();
  }
});

test("AC3-T7: a failed re-read downgrades the status but never wipes the old reading's payload", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    payloadFor = () => reading(KEEP_TEXT);
    assert.equal((await generateDeepRead(id)).status, "ready");

    // An article edit makes the row stale and gives the re-read a fresh operation key (same note
    // as T3: without a changed body paidRequest would happily reuse the old raw and never fail).
    await sql`UPDATE articles SET revision = revision + 1, body_text = body_text || ' 修文补充段落，改变模型输入。', updated_at = now() WHERE id = ${id}`;
    replyStatus = 503;
    await sweepDeepReads(5);
    assert.ok(p.hits() > 0, "the stale ready was really re-worked against the provider");

    const row = await rowOf(id);
    assert.equal(row!.status, "failed", "the row stopped presenting as a valid ready");
    assert.equal(row!.interpretation, KEEP_TEXT,
      "the old reading's payload survives the failure untouched");
    assert.equal(await loadDeepReadForSite(id), null, "and it is not public while it waits");

    replyStatus = 0;
    await sql`UPDATE article_deep_reads SET retry_at = now() - interval '1 second' WHERE article_id = ${id}`;
    payloadFor = () => reading(FRESH_TEXT);
    await sweepDeepReads(5);
    const fresh = await loadDeepReadForSite(id);
    assert.equal(fresh!.interpretation, FRESH_TEXT,
      "only a newer success replaces the old reading");
  } finally {
    replyStatus = 0;
    await p.close();
  }
});

test("AC3-T8: a legacy NULL-identity row reads as a miss and is re-swept (0052's contract)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    assert.equal((await generateDeepRead(id)).status, "ready");
    await sql`UPDATE article_deep_reads SET input_revision = NULL, pub_revision = NULL, input_hash = NULL WHERE article_id = ${id}`;

    assert.equal(await loadDeepReadForSite(id), null, "a legacy row never presents as current");
    await sweepDeepReads(5);
    const row = await rowOf(id);
    assert.equal(row!.status, "ready", "the sweep re-reads the legacy row");
    assert.ok(row!.input_revision != null && row!.input_hash != null, "the re-read stamps a full identity");
    assert.ok((await loadDeepReadForSite(id)) != null);
  } finally {
    await p.close();
  }
});

test("AC1-T9: a real vocab-seed edit flips the basis end to end (not just simulated)", async () => {
  const p = await newStub();
  try {
    await resetState();
    __deepreadTestHooks.resetBasisCache();
    const id = await article("国家统计局");
    assert.equal((await generateDeepRead(id)).status, "ready");
    const basis = (await rowOf(id))!.input_hash;
    assert.equal(basis, __deepreadTestHooks.currentBasis(), "a fresh reading stamps the live basis");

    // A hot seed edit (the ym238 M1 scenario): append a byte, expire the TTL, and the stored
    // reading must void on its own — no UPDATE simulation involved.
    const seedPath = BRANDS_FILE;
    const seedBytes = readFileSync(seedPath);
    try {
      writeFileSync(seedPath, Buffer.concat([seedBytes, Buffer.from("\n")]));
      __deepreadTestHooks.resetBasisCache();
      assert.notEqual(__deepreadTestHooks.currentBasis(), basis, "the basis really moved with the seed bytes");
      assert.equal(await loadDeepReadForSite(id), null, "the reading voids end to end");

      await sweepDeepReads(5);
      assert.equal((await rowOf(id))!.input_hash, __deepreadTestHooks.currentBasis(), "the sweep re-reads it against the new basis");
      assert.ok((await loadDeepReadForSite(id)) != null, "and the fresh reading is public again");
    } finally {
      writeFileSync(seedPath, seedBytes); // restore the seed byte-for-byte
      __deepreadTestHooks.resetBasisCache();
      assert.equal(__deepreadTestHooks.currentBasis(), basis, "seed restored — the basis is back");
    }
  } finally {
    await p.close();
  }
});

test("AC1-T10: a real vocab edit changes what the re-read matches (behavioral anchor for the cache drop)", async () => {
  const p = await newStub();
  try {
    await resetState();
    __deepreadTestHooks.resetBasisCache();
    const title = "探针品牌天灵灵 深读词表行为锚定";
    const id = await article("探针品牌天灵灵", new Date("2026-09-15T10:00:00+08:00")); // pre-cutoff so the no-signal verdict is a skip, not a rule-7 plain read
    const before = await generateDeepRead(id);
    assert.equal(before.status, "skipped", "with no such brand in the seeds the article earns a skip");
    assert.equal((await rowOf(id))!.skip_reason, "no_entity_no_macro");

    // Inject a real brand entry into the live seeds file (parse → add → write), so the vocab
    // PARSE result changes, not just the raw bytes: the cache drop must make the re-read
    // classify against the new vocabulary. A trailing-newline edit (T9) cannot prove that.
    const seedBytes = readFileSync(BRANDS_FILE);
    try {
      const seeds = JSON.parse(seedBytes.toString("utf8"));
      seeds.brands.push({ slug: "t08-probe", name: "探针品牌天灵灵", keywords: ["探针品牌天灵灵"] });
      writeFileSync(BRANDS_FILE, JSON.stringify(seeds, null, 1));
      __deepreadTestHooks.resetBasisCache();
      assert.notEqual(__deepreadTestHooks.currentBasis(), (await rowOf(id))!.input_hash,
        "the injected entry really moved the basis off the stored one");

      const stats = await sweepDeepReads(5);
      void stats;
      const row = await rowOf(id);
      assert.equal(row!.status, "ready", "the skip verdict is re-examined against the new vocab");
      const reading = await loadDeepReadForSite(id);
      assert.ok(reading != null, "the new reading is public");
      assert.equal(reading!.kind, "brand", "the re-read classifies via the injected brand entry");
      assert.ok(reading!.entities.some((e) => e.name === "探针品牌天灵灵"),
        "the matched entity comes from the reloaded vocabulary, not the stale cache");
    } finally {
      writeFileSync(BRANDS_FILE, seedBytes); // byte-for-byte restore
      __deepreadTestHooks.resetBasisCache();
    }
  } finally {
    await p.close();
  }
});

test("AC1-T11: a publication re-analysis (p.revision bump, article untouched) voids the reading", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("国家统计局");
    assert.equal((await generateDeepRead(id)).status, "ready");
    const pubRev = await sql<{ revision: number }[]>`SELECT revision FROM publications WHERE article_id = ${id}`;
    const [aRev] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${id}`;
    assert.ok((await loadDeepReadForSite(id)) != null);

    // The re-analysis path: publish.ts bumps publications.revision while articles.revision
    // stands still (summary/tags rewritten) — the stored reading must void on its own.
    await sql`UPDATE publications SET revision = revision + 1, summary = '再分析改写后的新摘要', updated_at = now() WHERE article_id = ${id}`;
    const [aRevAfter] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${id}`;
    assert.equal(aRevAfter.revision, aRev.revision, "the article row really stood still (projection-layer change only)");
    assert.equal(await loadDeepReadForSite(id), null, "a re-analyzed publication no longer presents the old reading as current");

    await sweepDeepReads(5);
    const row = await rowOf(id);
    assert.equal(row!.status, "ready", "the sweep re-read it against the new projection");
    assert.equal(row!.pub_revision, (pubRev[0]!.revision) + 1, "the stored identity carries the projection revision it read");
    assert.ok((await loadDeepReadForSite(id)) != null, "the fresh reading is public again");
  } finally {
    await p.close();
  }
});

test("Rule7-T12: an October article with no signal earns a plain reading (the default-read rollover)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("普通无信号"); // no seed hit, no macro signal — but published now
    const out = await generateDeepRead(id);
    assert.equal(out.status, "ready", "rule 7: a published-on/after-October article is never skipped for lacking signals");
    const reading = await loadDeepReadForSite(id);
    assert.ok(reading != null);
    assert.equal(reading!.kind, "plain");
    assert.equal(reading!.angle, "direct");
    assert.deepEqual(reading!.entities, [], "a signal-free reading carries no entities");
    assert.equal(p.hits(), 1, "the plain reading costs exactly one provider call");
  } finally {
    await p.close();
  }
});

test("Rule7-T13: the cutoff is exact Beijing 2026-10-01 and never overrides a richer classification", () => {
  const base = { title: "普通无信号", originalTitle: null, summary: null, category: null, tags: [] as string[], body: null };
  // 23:59 Beijing on 9-30 is still September: rule 4's skip stands.
  assert.equal(classifyArticle({ ...base, publishedAt: new Date("2026-09-30T23:59:00+08:00") }), null);
  // 00:00 Beijing on 10-1 is October: the plain default-read kicks in.
  assert.equal(classifyArticle({ ...base, publishedAt: new Date("2026-10-01T00:00:00+08:00") })?.kind, "plain");
  // No date at all: the signal rules stand (no default read).
  assert.equal(classifyArticle({ ...base, publishedAt: null }), null);
  // A macro signal still yields the richer kind — rule 7 only fills the no-signal gap.
  assert.equal(classifyArticle({ ...base, title: "国家统计局", publishedAt: new Date() })?.kind, "macro");
});

test("Rule7-T14: the re-verify path honors the rule-7 default read (entity stripped, October still reads)", async () => {
  const p = await newStub();
  try {
    await resetState();
    const id = await article("普通无信号");
    // An entity: tag puts a match into classification without any text check (structure-step
    // subjects ride that channel); the belt-and-suspenders re-verify then strips it when none of
    // the resolved keywords appear in the haystack. Pre-rule-7 this second skip path ended in a
    // skip; rule 7 must keep the October article reading. The probe entity is picked so that the
    // tag string itself cannot smuggle a keyword past the re-verify: every resolved keyword
    // (seed's list or the taxonomy name + aliases) must be absent from title+body+tag.
    const [row] = await sql<{ title: string; body_text: string | null }[]>`
      SELECT p.title, a.body_text FROM publications p JOIN articles a ON a.id = p.article_id WHERE p.article_id = ${id}`;
    const seeds = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands?: Array<{ name: string; keywords?: string[] }> }).brands ?? [];
    const resolvedKeywords = (eid: string): string[] => {
      const e = ENTITIES[eid]!;
      const seed = seeds.find((b) => b.name === e.name || (b.keywords ?? []).includes(e.name));
      return seed ? [...(seed.keywords ?? []), seed.name] : [e.name, ...(e.aliases ?? [])];
    };
    const eid = Object.keys(ENTITIES).find((k) => {
      const text = `${row!.title}\n${row!.body_text ?? ""}\nentity:${k}`.toLowerCase();
      return resolvedKeywords(k).every((kw) => !text.includes(kw.toLowerCase()));
    });
    assert.ok(eid, "a probe entity whose keywords stay outside the haystack exists");
    const base = { title: row!.title, originalTitle: null, summary: null, category: null, tags: [] as string[], body: row!.body_text };
    // Preconditions: the bare text carries no seed signal at all, and the tag alone is what
    // produces the (unverifiable) brand match.
    assert.equal(classifyArticle({ ...base, publishedAt: new Date("2026-09-15T10:00:00+08:00") }), null, "precondition: no seed noise on the probe text");
    const tagged = classifyArticle({ ...base, tags: ["entity:" + eid], publishedAt: new Date("2026-09-15T10:00:00+08:00") });
    assert.equal(tagged?.kind, "brand", "precondition: the entity tag alone creates the match");

    await sql`UPDATE publications SET tags = ${["entity:" + eid]} WHERE article_id = ${id}`;
    const out = await generateDeepRead(id);
    assert.equal(out.status, "ready", "the re-verify path honors the default read");
    const reading = await loadDeepReadForSite(id);
    assert.ok(reading != null);
    assert.equal(reading!.kind, "plain");
    assert.deepEqual(reading!.entities, [], "the unverifiable entity is stripped from the payload");
  } finally {
    await p.close();
  }
});
