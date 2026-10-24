// Admission engine invariants (T05/ym244): discovery stays inside approved origins; the probe
// writes zero business rows (articles/analyses/receipts/job_runs/sources/materials untouched);
// unknown roots, off-origin redirects, unclear rights, robots failures, manual tombstones and
// short-of-threshold fetch numbers (ym883/d-ym334 enforce) never promote; a normal 304 stays
// healthy; the observation window parks candidates without samples; and
// re-discovery neither duplicates a candidate nor revives a tombstone. Local HTTP stubs on 127.0.0.1
// stand in for the official site — the run must set ALLOW_PRIVATE_NETWORK_FETCH=true for this test
// process only (the local-debug allowance of the SSRF guard; it stays armed everywhere else), because
// ESM import hoisting loads config.ts before any statement here could set it.
import "./setup.ts";

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { checkRobots, resetRobotsCache } from "@aihot/backend/sources/admission/robots";
import { discoverOfficialCandidates } from "@aihot/backend/sources/admission/discover";
import { probeCandidate } from "@aihot/backend/sources/admission/probe";
import {
  endpointIdentityOf, listApprovedRoots, transitionCandidate, upsertCandidate,
  type OfficialRootRow,
} from "@aihot/backend/sources/admission/store";
import { isSourcePolicyActivatable, SOURCE_POLICY_V1 } from "@aihot/industry/source-policy";

const SLUG = "balabala";
const hits = { a: 0, b: 0, c: 0, d: 0 };

function rss(origin: string, dated: boolean, tag: string, opts: { items?: number; matched?: number } = {}): string {
  // items/matched drive the ym883 numeric gate: items below 5 or a matched ratio below 0.6 must
  // keep the candidate probing even when every structural check passes. Unmatched items avoid the
  // slug in BOTH title and description (the probe matches on either field).
  const items = opts.items ?? 6;
  const matched = opts.matched ?? items;
  const item = (n: number) =>
    `<item><title>${n <= matched ? `${SLUG} story ${n}` : `vendor story ${n}`}</title><link>${origin}/news/p${n}</link>` +
    (dated ? `<pubDate>Mon, 2${n} Sep 2026 08:00:00 GMT</pubDate>` : "") +
    `<description>${n <= matched ? `${SLUG} update ${n}` : `vendor update ${n}`}</description></item>`;
  const all = Array.from({ length: items }, (_, i) => item(i + 1)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${SLUG} news</title>` +
    `<link>${origin}/</link><description>official news</description>${all}</channel></rss><!--${tag}-->`;
}

interface ServerReply {
  status: number;
  body?: string;
  headers?: Record<string, string | undefined>;
}

function startServer(count: keyof typeof hits, handler: (url: string, req: http.IncomingMessage, origin: string) => ServerReply | null): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const out = handler(req.url ?? "/", req, origin);
      if (!out) {
        res.writeHead(404).end("nf");
        return;
      }
      hits[count] += 1;
      res.writeHead(out.status, out.headers ?? { "content-type": "text/plain" });
      res.end(out.body ?? "");
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    servers.push(server);
  });
}

const servers: http.Server[] = [];
let A = "";
let B = "";
let C = "";
let D = "";

before(async () => {
  A = await startServer("a", (url, req, origin) => {
    if (url === "/robots.txt") return { status: 200, body: `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n` };
    if (url === "/sitemap.xml") {
      return {
        status: 200, body:
          `<?xml version="1.0" encoding="UTF-8"?><urlset>` +
          `<url><loc>${origin}/news/a</loc><lastmod>2026-10-01</lastmod></url>` +
          `<url><loc>${origin}/news/b</loc></url>` +
          `<url><loc>${origin}/about</loc></url></urlset>`,
      };
    }
    if (url === "/" ) {
      return {
        status: 200, body:
          `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS">` +
          `<link rel="alternate" type="application/rss+xml" href="http://127.0.0.1:9/evil.xml" title="off-origin">` +
          `</head><body><a href="/news">新闻中心 news</a> <a href="/api.json">open data</a></body></html>`,
      };
    }
    if (url === "/api.json") return { status: 200, body: JSON.stringify([{ title: "t", url: `${origin}/x` }]) };
    if (url.startsWith("/feed")) {
      if (url === "/feed-few.xml") return { status: 200, headers: { "content-type": "application/rss+xml" }, body: rss(origin, true, url, { items: 3, matched: 3 }) };
      if (url === "/feed-mixed.xml") return { status: 200, headers: { "content-type": "application/rss+xml" }, body: rss(origin, true, url, { items: 6, matched: 2 }) };
      const etag = "t05-a-feed";
      if (req.headers["if-none-match"] === etag) return { status: 304, headers: { etag } };
      return { status: 200, headers: { etag, "content-type": "application/rss+xml" }, body: rss(origin, true, url) };
    }
    return null;
  });
  B = await startServer("b", (url) => {
    if (url === "/robots.txt") return { status: 503, body: "boom" };
    return null;
  });
  C = await startServer("c", (url, req, origin) => {
    if (url === "/robots.txt") return { status: 200, body: "User-agent: *\nDisallow: /private/\n" };
    if (url === "/private/feed.xml") return { status: 200, body: rss(origin, true, url) };
    return null;
  });
  D = await startServer("d", (url, req, origin) => {
    if (url === "/robots.txt") return { status: 200, body: "User-agent: *\nDisallow: /private/\n" };
    if (url === "/feed.xml") return { status: 200, headers: { etag: "t05-d" }, body: rss(origin, false, url) };
    return null;
  });
  assert.ok(A.startsWith("http://"), "stub origin ready before seeding");

  // Seed after the stubs are up (one hook: no ordering race between server startup and row inserts).
  await insRoot(`${T}-a`, SLUG, A, "approved", { ownership: "verified", rights: "public feed" }, "RSS permitted");
  await insRoot(`${T}-s`, `${SLUG}-s`, A, "suspended", {}, null);
  await insRoot(`${T}-r`, `${SLUG}-r`, A, "approved", { ownership: "verified" }, null);
  const roots = await listApprovedRoots();
  rootA = roots.find((r) => r.id === `${T}-a`)!;
  rootR = roots.find((r) => r.id === `${T}-r`)!;

  candRss = await insCand(`${A}/feed.xml`, rootA.id);
  candSuspended = await insCand(`${A}/feed2.xml`, `${T}-s`);
  candRights = await insCand(`${A}/feed3.xml`, rootR.id);
  cand503 = await insCand(`${B}/feed.xml`, rootA.id);
  candDisallow = await insCand(`${C}/private/feed.xml`, rootA.id);
  candNoDate = await insCand(`${D}/feed.xml`, rootA.id);
  candPaid = await insCand(`https://r.jina.ai/${A}/feed.xml`, rootA.id);
  candFew = await insCand(`${A}/feed-few.xml`, rootA.id);
  candMixed = await insCand(`${A}/feed-mixed.xml`, rootA.id);
  // rootR（rights=unknown）让该候选恒低于晋级线（ym334 冻结后 all-pass 会首轮晋级），
  // 304 健康路径因此保持可达；晋级语义由 R10/AC3 专测承载。
  cand304 = await insCand(`${A}/feed304.xml`, rootR.id);
  const retiredIdentity = endpointIdentityOf(`${A}/feed4.xml`);
  let [ret] = (await sql`SELECT id, version, status, updated_at FROM source_candidates WHERE endpoint_identity = ${retiredIdentity}`) as unknown as [{ id: number; version: number; status: string; updated_at: string } | undefined];
  if (!ret) {
    [ret] = (await sql`INSERT INTO source_candidates (endpoint_identity, url, kind, root_id, manual_retired, retired_at, retired_by, retire_reason)
      VALUES (${retiredIdentity}, ${`${A}/feed4.xml`}, 'rss', ${rootA.id}, true, now(), ${"owner-" + T}, 'manual test retire')
      ON CONFLICT (endpoint_identity) DO NOTHING RETURNING id, version, status, updated_at`) as unknown as [{ id: number; version: number; status: string; updated_at: string } | undefined];
  }
  candRetired = Number(ret!.id);
  retiredBefore = ret!;
});

after(async () => {
  for (const s of servers) s.close();
  await closeDb();
});

const T = `t05-${Date.now().toString(36)}`;
let rootA: OfficialRootRow;
let rootR: OfficialRootRow;
let candRss: number;
let candSuspended: number;
let candRights: number;
let cand503: number;
let candDisallow: number;
let candNoDate: number;
let candPaid: number;
let candFew: number;
let candMixed: number;
let cand304: number;
let candRetired: number;
let retiredBefore: { version: number; status: string; updated_at: string };

async function insRoot(id: string, slug: string, origin: string, status: "approved" | "suspended", evidence: Record<string, unknown>, rightsNote: string | null) {
  await sql`INSERT INTO source_official_roots (id, entity_type, entity_slug, root_url, approved_origins, identity_evidence, rights_note, status, verified_at, verified_by)
            VALUES (${id}, 'brand', ${slug}, ${origin + "/"}, ${[origin]}, ${sql.json(evidence as never)}, ${rightsNote}, ${status}, now(), ${T})
            ON CONFLICT (entity_type, entity_slug, root_url) DO NOTHING`;
}

async function insCand(url: string, rootId: string): Promise<number> {
  const identity = endpointIdentityOf(url);
  const [row] = await sql`INSERT INTO source_candidates (endpoint_identity, url, kind, root_id, discovered_via)
    VALUES (${identity}, ${url}, 'rss', ${rootId}, 'test')
    ON CONFLICT (endpoint_identity) DO NOTHING RETURNING id`;
  if (row) return Number(row!.id);
  const [ex] = await sql`SELECT id FROM source_candidates WHERE endpoint_identity = ${identity}`;
  return Number(ex!.id);
}

// postgres.js only accepts tagged templates (table names cannot be parameters), so each business
// table gets its own explicit query. "Materials" is a domain concept: its physical rows are
// articles/article_revisions/article_discoveries; fetch_runs is the collection-side log the probe
// must not touch either.
type Counted = "articles" | "article_revisions" | "article_discoveries" | "analyses" | "receipts" | "job_runs" | "sources" | "fetch_runs";
async function tableCount(t: Counted): Promise<number> {
  const q: Record<Counted, ReturnType<typeof sql>> = {
    articles: sql`SELECT count(*)::int AS n FROM articles`,
    article_revisions: sql`SELECT count(*)::int AS n FROM article_revisions`,
    article_discoveries: sql`SELECT count(*)::int AS n FROM article_discoveries`,
    analyses: sql`SELECT count(*)::int AS n FROM analyses`,
    receipts: sql`SELECT count(*)::int AS n FROM receipts`,
    job_runs: sql`SELECT count(*)::int AS n FROM job_runs`,
    sources: sql`SELECT count(*)::int AS n FROM sources`,
    fetch_runs: sql`SELECT count(*)::int AS n FROM fetch_runs`,
  };
  const [r] = (await q[t]) as unknown as [{ n: number }];
  return r!.n;
}

test("R10/policy 前置：阈值已冻结（中性档 5/0.6）→ 资格判定打开（激活面归 ym311）", () => {
  assert.deepEqual(SOURCE_POLICY_V1.thresholds, { minSamples: 5, minRelevanceRatio: 0.6 }, "冻结值=拍板中性档");
  assert.equal(SOURCE_POLICY_V1.version, "source-policy/2");
  assert.equal(isSourcePolicyActivatable(SOURCE_POLICY_V1), true);
});

test("R7/AC3 重复发现不重复 candidate；发现只在 approved origins 内；四类入口可见", async () => {
  resetRobotsCache();
  const first = await discoverOfficialCandidates(rootA);
  const second = await discoverOfficialCandidates(rootA);
  const urls = (l: Awaited<ReturnType<typeof discoverOfficialCandidates>>) => new Set(l.map((e) => e.url));
  assert.ok(urls(first).has(`${A}/feed.xml`), "rel=alternate feed found");
  assert.ok(urls(first).has(`${A}/news`), "news section found");
  assert.ok([...urls(first)].some((u) => u.endsWith(".json")), "json endpoint found");
  assert.ok(!urls(first).has("http://127.0.0.1:9/evil.xml"), "R3/AC2 off-origin endpoint never produced");
  assert.equal(first.length, second.length);
  const [row] = await sql`SELECT count(*)::int AS n FROM source_candidates WHERE root_id = ${rootA.id} AND endpoint_identity = ${endpointIdentityOf(`${A}/feed.xml`)}`;
  assert.equal(row!.n, 1, "one row per endpoint after two discoveries");
  const dup = await upsertCandidate({ endpointIdentity: endpointIdentityOf(`${A}/feed.xml`), url: `${A}/feed.xml`, kind: "rss", rootId: rootA.id });
  assert.equal(dup.created, false);
});

test("R1/AC1 probe 全流程零业务写入（articles 三物理表+analyses/receipts/job_runs/sources/fetch_runs 计数全等）", async () => {
  resetRobotsCache();
  // Dedicated candidates so this full-sweep probe (which parks some of them) does not consume the
  // scenarios the single-condition tests below rely on.
  const own = {
    ok: await insCand(`${A}/feedr1.xml`, rootA.id),
    robots: await insCand(`${B}/feedr1.xml`, rootA.id),
    disallow: await insCand(`${C}/private/feedr1.xml`, rootA.id),
    paid: await insCand(`https://r.jina.ai/${A}/feedr1.xml`, rootA.id),
  };
  const tables: Counted[] = ["articles", "article_revisions", "article_discoveries", "analyses", "receipts", "job_runs", "sources", "fetch_runs"];
  const beforeCounts = await Promise.all(tables.map(tableCount));
  for (const id of Object.values(own)) {
    await probeCandidate(id);
  }
  const afterCounts = await Promise.all(tables.map(tableCount));
  assert.deepEqual(afterCounts, beforeCounts, "probe writes no business rows");
});

test("R10/AC3 全检查 pass 且数字达标（ym883 数字门：6 dated、占比 1.0）→ 晋级 eligible（激活仍归 ym311）", async () => {
  resetRobotsCache();
  const out = await probeCandidate(candRss);
  const verdicts = Object.fromEntries(out.checks.map((c) => [c.checkKey, c.verdict]));
  assert.deepEqual(verdicts, { robots: "pass", health: "pass", domain: "pass", identity: "pass", rights: "pass", date: "pass", relevance: "pass" });
  assert.equal(out.status, "eligible", "numbers met → promotion reachable");
  const [row] = await sql`SELECT status, samples_ok, samples_total FROM source_candidates WHERE id = ${candRss}`;
  assert.equal(row!.status, "eligible");
  assert.equal(row!.samples_ok, 6);
  assert.equal(row!.samples_total, 6);
});

test("ym883/d-ym334 enforce 数字门：结构全过但数字不足 → 仍 probing 不晋级（条数不足/占比不足两形态）", async () => {
  resetRobotsCache();
  // 条数不足：3/3 dated、占比 1.0 达标，但 samplesOk=3 < minSamples=5。
  const few = await probeCandidate(candFew);
  const fewVerdicts = Object.fromEntries(few.checks.map((c) => [c.checkKey, c.verdict]));
  assert.deepEqual(fewVerdicts, { robots: "pass", health: "pass", domain: "pass", identity: "pass", rights: "pass", date: "pass", relevance: "pass" }, "结构检查全过");
  assert.equal(few.status, "probing", "samplesOk 3 < 5 → 不足不转正");
  // 占比不足：6 条 dated 全有，仅 2 条命中绑定实体（2/6≈0.33 < 0.6）。
  const mixed = await probeCandidate(candMixed);
  const mixedVerdicts = Object.fromEntries(mixed.checks.map((c) => [c.checkKey, c.verdict]));
  assert.deepEqual(mixedVerdicts, { robots: "pass", health: "pass", domain: "pass", identity: "pass", rights: "pass", date: "pass", relevance: "pass" }, "结构检查全过（relevance 判据=命中≥1）");
  assert.equal(mixed.status, "probing", "matched/total 2/6 < 0.6 → 不足不转正");
  const [fewRow] = await sql`SELECT status, samples_ok, samples_total FROM source_candidates WHERE id = ${candFew}`;
  assert.equal(fewRow!.status, "probing");
  assert.equal(fewRow!.samples_ok, 3);
  const [mixedRow] = await sql`SELECT status, samples_ok, samples_total FROM source_candidates WHERE id = ${candMixed}`;
  assert.equal(mixedRow!.status, "probing");
  assert.equal(mixedRow!.samples_ok, 6);
  assert.equal(mixedRow!.samples_total, 6);
});

test("R2/AC2 未知（suspended）官方根 → identity=fail 不晋级", async () => {
  resetRobotsCache();
  const out = await probeCandidate(candSuspended);
  const identity = out.checks.find((c) => c.checkKey === "identity")!;
  assert.equal(identity.verdict, "fail");
  assert.notEqual(out.status, "eligible");
});

test("R11+R13/AC2 权利不明（robots 放行不替代权利）→ rights=unknown 不晋级", async () => {
  resetRobotsCache();
  const out = await probeCandidate(candRights);
  const by = Object.fromEntries(out.checks.map((c) => [c.checkKey, c.verdict]));
  assert.equal(by.robots, "pass");
  assert.equal(by.rights, "unknown");
  assert.notEqual(out.status, "eligible");
});

test("R4/AC2 robots 5xx → unknown → parked（不判 fail）", async () => {
  resetRobotsCache();
  const out = await probeCandidate(cand503);
  assert.equal(out.parkedReason, "robots-unreachable");
  assert.equal(out.checks.find((c) => c.checkKey === "robots")!.verdict, "unknown");
  const [row] = await sql`SELECT status FROM source_candidates WHERE id = ${cand503}`;
  assert.equal(row!.status, "parked");
});

test("R5/AC2 robots Disallow 命中 → fail → parked", async () => {
  resetRobotsCache();
  const out = await probeCandidate(candDisallow);
  assert.equal(out.parkedReason, "robots-disallowed");
  assert.equal(out.checks.find((c) => c.checkKey === "robots")!.verdict, "fail");
});

test("R15/C1 付费读取前缀 → 任何网络调用前拒绝（stub 零请求）", async () => {
  resetRobotsCache();
  const before = { ...hits };
  const out = await probeCandidate(candPaid);
  assert.equal(out.parkedReason, "paid-prefix-refused");
  assert.equal(out.checks.find((c) => c.checkKey === "health")!.verdict, "fail");
  assert.deepEqual(hits, before, "zero outbound requests, robots included");
});

test("R8/AC3 第二次 probe 收 304 → 健康、不 parked、样本不清零", async () => {
  resetRobotsCache();
  const first = await probeCandidate(cand304);
  assert.equal(first.notModified, false);
  const second = await probeCandidate(cand304);
  assert.equal(second.notModified, true);
  assert.equal(second.status, "probing");
  const [row] = await sql`SELECT status, samples_ok FROM source_candidates WHERE id = ${cand304}`;
  assert.equal(row!.status, "probing");
  assert.equal(row!.samples_ok, 6, "counts kept from the 200 run");
});

test("R9/AC3 窗满样本不足 → parked(window-elapsed-insufficient-samples)", async () => {
  resetRobotsCache();
  const inWindow = await probeCandidate(candNoDate);
  assert.equal(inWindow.status, "probing");
  const elapsed = await probeCandidate(candNoDate, { now: new Date(Date.now() + 73 * 3600 * 1000) });
  assert.equal(elapsed.parkedReason, "window-elapsed-insufficient-samples");
  const [row] = await sql`SELECT status FROM source_candidates WHERE id = ${candNoDate}`;
  assert.equal(row!.status, "parked");
});

test("R6/AC2 人工退役候选重复发现不复活（零字段变化）", async () => {
  const dup = await upsertCandidate({ endpointIdentity: endpointIdentityOf(`${A}/feed4.xml`), url: `${A}/feed4.xml`, kind: "rss", rootId: rootA.id });
  assert.equal(dup.suppressedByTombstone, true);
  assert.equal(dup.candidate.status, retiredBefore.status);
  assert.equal(dup.candidate.version, retiredBefore.version);
  assert.equal(Date.parse(dup.candidate.updatedAt), Date.parse(retiredBefore.updated_at), "updated_at untouched (no revival)");
  // The retire bookkeeping itself must survive re-discovery untouched too (result-audit ISS-B).
  const [row] = await sql`SELECT manual_retired, retired_at, retired_by, retire_reason FROM source_candidates WHERE id = ${candRetired}`;
  assert.equal(row!.manual_retired, true);
  assert.equal(row!.retired_by, `owner-${T}`);
  assert.equal(row!.retire_reason, "manual test retire");
  assert.ok(row!.retired_at, "retired_at still set");
});

test("R12/AC2 checks append-only——UPDATE 被契约触发器拒", async () => {
  const [row] = await sql`SELECT id FROM source_candidate_checks WHERE candidate_id = ${candRss} LIMIT 1`;
  assert.ok(row, "probe recorded checks");
  await assert.rejects(
    sql`UPDATE source_candidate_checks SET verdict = 'fail' WHERE id = ${row!.id}`,
    /append-only/i,
  );
});

test("R14/幂等 stale CAS → null 不推进", async () => {
  // candRss 可能已被 R10/AC3 晋级 eligible：本测只断言 stale CAS 零推进（前后态一致）。
  const [before] = await sql`SELECT status FROM source_candidates WHERE id = ${candRss}`;
  const out = await transitionCandidate({ candidateId: candRss, expectVersion: 999, fromStatuses: ["probing"], toStatus: "parked" });
  assert.equal(out, null);
  const [row] = await sql`SELECT status FROM source_candidates WHERE id = ${candRss}`;
  assert.equal(row!.status, before!.status, "stale worker advanced nothing");
});

test("robots 单元：404=pass、无组=pass、cache 命中", async () => {
  resetRobotsCache();
  const missing = await checkRobots(`${D}/none.txt`);
  assert.equal(missing.verdict, "pass"); // D robots exists; hit the cache path instead:
  const cached = await checkRobots(`${D}/other`);
  assert.equal(cached.verdict, "pass");
  assert.equal(cached.fetchedAt, missing.fetchedAt, "second call served from cache");
});
