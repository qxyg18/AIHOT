// T14/ym247（G00 matrix gap ②，AC5）：item/original 复用 ItemPage 的 loader 契约。
// 修复前 item-original loader 只返回 {item}，ItemPage 的 entities.filter 在 SSR 取
// undefined 直接 500；修复后两个 loader 共用 app/lib/item-rail.server.ts 的 loadItemRailData。
// 真 SSR：先 `npm run build -w @aihot/web`，进程内用 @react-router/node 的
// createRequestListener 挂同一生产 build/server/index.js（与 server.ts 同管线；绕开
// server.ts:38 在 Windows 的裸路径动态导入缺陷——该缺陷不在本卡面，另行披露），
// 上游 API 用合成 http 服务器。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { after, before, test } from "node:test";
import type { SiteItemDetail } from "@aihot/contracts/site";

let origin: string;
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-10-04T12:00" }));
  if (url.pathname === "/api/site/insights/article/art-1") return res.end(JSON.stringify({ insights: [] }));
  if (url.pathname === "/api/site/articles/art-1/entities") {
    return res.end(JSON.stringify({ entities: [{ type: "brand", slug: "test-brand", name: "测试品牌" }, { type: "mall", slug: "test-mall", name: "测试商场" }] }));
  }
  if (url.pathname === "/api/site/articles/art-2/entities") return res.end(JSON.stringify({ entities: [] }));
  const m = url.pathname.match(/^\/api\/site\/items\/([^/]+)(\/original)?$/);
  if (m) {
    // 无权限/不存在的原文按原规则 404：art-2（summary-only）的 original 端点不给正文。
    if (m[2] === "/original" && m[1] === "art-2") { res.statusCode = 404; return res.end(JSON.stringify({ code: "not_found" })); }
    const it = ITEMS[m[1]];
    if (!it) { res.statusCode = 404; return res.end(JSON.stringify({ code: "not_found" })); }
    // original 端点返回带原文正文的同一详情形状。
    return res.end(JSON.stringify(m[2]
      ? { ...it, body: { zh: null, original: "<p>Original body.</p>", zhKind: null, complete: true }, hasTranslation: false, bodyLanguage: "original" as const }
      : it));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

function item(over: Partial<SiteItemDetail>): SiteItemDetail {
  return {
    id: "art-1", revision: 1, title: "童装行业三季报综述", originalTitle: null,
    summary: "一句话摘要", reason: null,
    source: { id: "src-1", name: "测试信源", kind: "external", firstParty: false, iconUrl: null },
    links: { aihot: "/items/art-1", original: "https://example.com/a1" },
    publishedAt: "2026-09-30T08:00:00Z", discoveredAt: "2026-09-30T09:00:00Z", timelineAt: "2026-09-30T08:00:00Z",
    category: "statistics", tags: ["研报"], score: 80, selected: true, channel: "news", story: null, x: null,
    readingMode: "full", author: null, language: null,
    body: { zh: "<p>正文一段。</p>", original: null, zhKind: "original", complete: true },
    outline: [], relatedStories: [], indexable: true, markdownAvailable: false, group: null,
    hasTranslation: false, bodyLanguage: "zh", brands: [], deepRead: null,
    ...over,
  } as SiteItemDetail;
}

const ITEMS: Record<string, SiteItemDetail> = {
  // statistics 类详情：触发 insights + entities 两条伴生取数（loader 契约的正例路径）。
  "art-1": item({}),
  // summary-only 受限文：详情页保持「只提供摘要与原文入口」的受限文案。
  "art-2": item({ id: "art-2", readingMode: "summary-only", body: null, category: "industry", selected: false, score: null }),
};

// 与 server.ts 同款挂法：createRequestListener({ build, mode: "production" })。
const web = createServer();

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  // api.server 在模块加载时读 API_BASE_URL，必须先设 env 再动态 import 生产 build。
  process.env.API_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const { createRequestListener } = await import("@react-router/node");
  const build = await import("../build/server/index.js");
  web.addListener("request", createRequestListener({ build, mode: "production" }));
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});

after(async () => {
  web.closeAllConnections();
  await new Promise<void>((resolve) => web.close(() => resolve()));
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("AC5 详情页 200 且实体行渲染（loader 契约基准面）", async () => {
  const res = await fetch(`${origin}/items/art-1`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /测试品牌/);
});

test("AC5 已存在合法 item/original 由 500 恢复 200：复用 ItemPage 不再 entities undefined", async () => {
  const res = await fetch(`${origin}/items/art-1/original`);
  assert.equal(res.status, 200, `原文页应 200（修复前 entities.filter undefined → SSR 500）`);
  const html = await res.text();
  assert.match(html, /测试品牌/, "实体标签行必须渲染（entities 已随 loader 返回）");
  assert.match(html, /Original body\./, "原文正文必须渲染");
});

test("AC5 无权限原文仍按原规则 404：不因修复放宽", async () => {
  const restricted = await fetch(`${origin}/items/art-2/original`);
  assert.equal(restricted.status, 404);
  const missing = await fetch(`${origin}/items/missing/original`);
  assert.equal(missing.status, 404);
});

test("AC5 summary-only 原文受限文案在位；详情页正常 200", async () => {
  const detail = await fetch(`${origin}/items/art-2`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /只提供摘要与原文入口/);
});
