// Admission worker entries, valves ON (ym312): the discovery round persists candidates from an
// approved root through the engine's idempotent upsert, the probe round works the due set and
// never re-selects parked/retired rows, the all-pass feed with sufficient fetch numbers is promoted
// (ym334 froze the policy; ym883/d-ym334 enforce compares the numbers per candidate; activation
// itself stays unwired — ym311), and a full round writes zero business rows. The
// valves are read from the environment at import time,
// so this file must run with SOURCE_DISCOVERY_ENABLED=1 SOURCE_PROBE_ENABLED=1 (the run command
// sets them; the sibling admission-jobs-off.test.ts covers the default-off process).
// Local HTTP stubs on 127.0.0.1 stand in for the official site — the run must set
// ALLOW_PRIVATE_NETWORK_FETCH=true for this process only (see tests/source-admission.test.ts).
import "./setup.ts";

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runDiscoveryRound, runProbeRound } from "@aihot/backend/jobs/admission";
import { endpointIdentityOf, transitionCandidate } from "@aihot/backend/sources/admission/store";

const SLUG = "balabala";
const T = `ym312-${Date.now().toString(36)}`;
const servers: http.Server[] = [];
let A = "";

before(async () => {
  A = await new Promise<string>((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (req.url === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`);
      if (req.url === "/sitemap.xml") {
        return void res.writeHead(200, { "content-type": "text/xml" }).end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset>` +
          `<url><loc>${origin}/news/a</loc><lastmod>2026-10-01</lastmod></url>` +
          `<url><loc>${origin}/news/b</loc></url>` +
          `<url><loc>${origin}/about</loc></url></urlset>`);
      }
      if (req.url === "/") {
        return void res.writeHead(200, { "content-type": "text/html" }).end(
          `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS"></head>` +
          `<body><a href="/news">新闻中心 news</a> <a href="/api.json">open data</a></body></html>`);
      }
      if (req.url === "/api.json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ title: `${SLUG} t`, url: `${origin}/x` }]));
      if (req.url === "/news") {
        return void res.writeHead(200, { "content-type": "text/html" }).end(
          `<html><body>${[1, 2, 3].map((n) => `<a href="/news/p${n}">${SLUG} story ${n}</a>`).join("")}</body></html>`);
      }
      if (req.url?.startsWith("/feed")) {
        const items = Array.from({ length: 6 }, (_, i) => {
          const n = i + 1;
          return `<item><title>${SLUG} story ${n}</title><link>${origin}/news/p${n}</link>` +
            `<pubDate>Mon, 2${n} Sep 2026 08:00:00 GMT</pubDate><description>${SLUG} update ${n}</description></item>`;
        }).join("");
        return void res.writeHead(200, { "content-type": "application/rss+xml" }).end(
          `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${SLUG} news</title>` +
          `<link>${origin}/</link><description>official news</description>${items}</channel></rss>`);
      }
      res.writeHead(404).end("nf");
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    servers.push(server);
  });

  await sql`INSERT INTO source_official_roots (id, entity_type, entity_slug, root_url, approved_origins, identity_evidence, rights_note, status, verified_at, verified_by)
            VALUES (${T + "-a"}, 'brand', ${SLUG}, ${A + "/"}, ${[A]}, ${sql.json({ ownership: "verified", rights: "public feed" } as never)}, 'RSS permitted', 'approved', now(), ${T})
            ON CONFLICT (entity_type, entity_slug, root_url) DO NOTHING`;
  // The shared test DB keeps residue from earlier runs of this file (checks are append-only, so
  // old candidates cannot be deleted): retire previous ym312 roots from the discovery walk so the
  // round's own assertions stay scoped to this run. Assertions elsewhere stay residue-tolerant.
  await sql`UPDATE source_official_roots SET status = 'suspended' WHERE verified_by LIKE 'ym312-%' AND id <> ${T + "-a"} AND status = 'approved'`;
});

after(async () => {
  for (const s of servers) s.close();
  await closeDb();
});

type Counted = "articles" | "analyses" | "receipts" | "job_runs" | "sources" | "fetch_runs";
async function tableCount(t: Counted): Promise<number> {
  const q: Record<Counted, ReturnType<typeof sql>> = {
    articles: sql`SELECT count(*)::int AS n FROM articles`,
    analyses: sql`SELECT count(*)::int AS n FROM analyses`,
    receipts: sql`SELECT count(*)::int AS n FROM receipts`,
    job_runs: sql`SELECT count(*)::int AS n FROM job_runs`,
    sources: sql`SELECT count(*)::int AS n FROM sources`,
    fetch_runs: sql`SELECT count(*)::int AS n FROM fetch_runs`,
  };
  const [r] = (await q[t]) as unknown as [{ n: number }];
  return r!.n;
}

test("发现轮：approved 根 → 候选落库（三类入口），重复轮幂等零新增", async () => {
  const first = await runDiscoveryRound();
  assert.ok(!("skipped" in first) || !first.skipped, "valve is on for this process");
  // The round walks every approved root in the shared DB (residue from other tests may add to the
  // count); this file only asserts its own root was worked and its own candidates were persisted.
  assert.ok((first.roots ?? 0) >= 1, "the fresh root was walked");
  assert.ok((first.endpoints ?? 0) >= 3, "feed + news section + json endpoint found");
  assert.ok((first.newCandidates ?? 0) >= 3, "candidates persisted");

  const second = await runDiscoveryRound();
  assert.equal(second.endpoints, first.endpoints, "re-discovery stable");
  assert.equal(second.newCandidates, 0, "idempotent upsert creates nothing new");
});

test("探测轮：due 候选全部走查（全检查 pass 的 feed 晋级 eligible），parked/退役行不被复选", async () => {
  // Seed one parked and one manually retired candidate: neither may be selected by the round.
  const parkedIdentity = endpointIdentityOf(`${A}/seeded-parked.xml`);
  const [parked] = (await sql`INSERT INTO source_candidates (endpoint_identity, url, kind, root_id, discovered_via)
    VALUES (${parkedIdentity}, ${A + "/seeded-parked.xml"}, 'rss', ${T + "-a"}, 'test') ON CONFLICT (endpoint_identity) DO NOTHING RETURNING id, version`) as unknown as [{ id: number; version: number } | undefined];
  const parkedId = Number(parked!.id);
  await transitionCandidate({ candidateId: parkedId, expectVersion: parked!.version, fromStatuses: ["discovered"], toStatus: "parked" });

  const retiredIdentity = endpointIdentityOf(`${A}/seeded-retired.xml`);
  await sql`INSERT INTO source_candidates (endpoint_identity, url, kind, root_id, manual_retired, retired_at, retired_by, retire_reason)
    VALUES (${retiredIdentity}, ${A + "/seeded-retired.xml"}, 'rss', ${T + "-a"}, true, now(), ${"owner-" + T}, 'ym312 test retire')
    ON CONFLICT (endpoint_identity) DO NOTHING`;

  const tables: Counted[] = ["articles", "analyses", "receipts", "job_runs", "sources", "fetch_runs"];
  const beforeCounts = await Promise.all(tables.map(tableCount));
  const round = await runProbeRound();
  const afterCounts = await Promise.all(tables.map(tableCount));
  assert.deepEqual(afterCounts, beforeCounts, "probe round writes no business rows");

  assert.ok((round.probed ?? 0) >= 3, "discovered candidates were worked");
  assert.equal(round.untouched, 0, "every selected candidate produced checks");
  const statuses = await sql`SELECT status, count(*)::int AS n FROM source_candidates WHERE root_id = ${T + "-a"} GROUP BY 1`;
  const by = Object.fromEntries(statuses.map((r) => [r.status, Number(r.n)]));
  assert.ok((by.probing ?? 0) >= 1, "date-unknown endpoints (news/json) stay probing");
  assert.ok((by.parked ?? 0) >= 1, "a stub-missing endpoint parks through the engine");
  assert.ok((by.eligible ?? 0) >= 1, "policy frozen + numbers met (6 dated, ratio 1.0) → the all-pass feed is promoted (activation still ym311)");
  const [parkedRow] = await sql`SELECT status, version FROM source_candidates WHERE id = ${parkedId}`;
  assert.equal(parkedRow!.status, "parked");
  const [retiredRow] = await sql`SELECT manual_retired, last_probe_at FROM source_candidates WHERE endpoint_identity = ${retiredIdentity}`;
  assert.equal(retiredRow!.manual_retired, true);
  assert.equal(retiredRow!.last_probe_at, null, "retired candidate never selected");
});
