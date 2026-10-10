// export-pool.mjs — 从本地真站 API 抓取 pool 全量，生成镜像站客户端交互数据包
// 用法: node export-pool.mjs [baseUrl] [outFile]
// 默认 baseUrl=http://localhost:3000 outFile=D:/myhot-dev/mirror-fidelity/data/pool.json
// 只导公开面字段（标题/提要/来源/原文链接/分类/标签/时间），不含全文，符合镜像站只读口径。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const base = process.argv[2] || "http://localhost:3000";
const out = process.argv[3] || "D:/myhot-dev/scripts/mirror/_work/pool.json";

const slim = (it) => ({
  id: it.id,
  t: it.title,
  s: it.summary,
  src: it.source?.name || "",
  pub: it.publishedAt,
  tl: it.timelineAt,
  cat: it.category,
  tags: it.tags || [],
  ch: it.channel,
  sc: it.score ?? null,
  sel: !!it.selected,
  url: it.links?.original || null,
});

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
};

const first = await get(`${base}/api/site/pool?page=1`);
const pageCount = first.pageCount || 1;
const seen = new Set();
const items = [];
const push = (list) => {
  for (const it of list || []) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(slim(it));
  }
};
push(first.items);
for (let p = 2; p <= pageCount; p++) {
  const d = await get(`${base}/api/site/pool?page=${p}`);
  push(d.items);
}

// 完整性强校验（守门员审计 ym303 #7）：API 中途挂掉导致少页时总数对不上，直接失败不产出半截数据包
if (items.length !== first.total) {
  console.error(`FUSE: 导出条数 ${items.length} != apiTotal ${first.total}（疑似中途少页），拒绝产出`);
  process.exit(1);
}

const payload = {
  total: items.length,
  apiTotal: first.total,
  freshness: first.freshness || null,
  exportedAt: new Date().toISOString(),
  items,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(payload), "utf8");
console.log(`pool.json written: ${items.length} items (apiTotal=${first.total}, pages=${pageCount}) -> ${out}`);
