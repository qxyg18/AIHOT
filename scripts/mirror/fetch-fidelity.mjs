// 镜像站保真版 · 批量抓取原站已渲染页面 + 样式产物（剥 JS）
// 用法：node fetch-fidelity.mjs <清单文件.json>
// 清单格式：{ "pages": ["/", "/all", "/items/xxx"] }
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SRC_BASE || "http://localhost:3000";
const OUT = process.env.OUT_DIR || "D:/myhot-dev/mirror-fidelity";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

const listFile = process.argv[2];
if (!listFile) {
  console.error("用法：node fetch-fidelity.mjs <清单文件.json>");
  process.exit(1);
}
const PAGES = JSON.parse(readFileSync(listFile, "utf8")).pages;
mkdirSync(OUT, { recursive: true });

const fetchText = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

const fetchBinary = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

// 把 /a/b?x=1&y=2 映射成 a/b/x-1-y-2/index.html，使带参数的链接也能静态命中
function routeToFile(route) {
  const [p, q] = route.split("?");
  let dir = p.replace(/^\//, "").replace(/\/$/, "");
  if (q) {
    const slug = q
      .split("&")
      .map((kv) => kv.replace(/=+/g, "-").replace(/[^A-Za-z0-9\-_\u4e00-\u9fa5]/g, ""))
      .join("-");
    dir = dir ? `${dir}/${slug}` : slug;
  }
  return path.join(dir || "", "index.html");
}

function transform(html) {
  let h = html;
  h = h.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, "");
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  h = h.replace(/<script\b[^>]*\/>/g, "");
  h = h.replace(/(href|content)="https?:\/\/(?:localhost:3000|127\.0\.0\.1:3000)[^"]*"/g, '$1="#"');
  return h;
}

const cssSeen = new Set();
const assetSeen = new Set();

async function grabStaticRefs(raw) {
  const css = [...raw.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const assets = [...raw.matchAll(/<link[^>]*rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of css) {
    if (cssSeen.has(href)) continue;
    cssSeen.add(href);
    const buf = await fetchBinary(href).catch((e) => console.warn(`  css ${href} 失败 ${e.message}`));
    if (!buf) continue;
    const f = path.join(OUT, href.replace(/^\//, ""));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, buf);
  }
  for (const href of assets) {
    if (assetSeen.has(href)) continue;
    assetSeen.add(href);
    const buf = await fetchBinary(href).catch(() => null);
    if (!buf) continue;
    const f = path.join(OUT, href.replace(/^\//, ""));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, buf);
  }
}

let ok = 0;
const failed = [];

async function grab(route) {
  try {
    const raw = await fetchText(route);
    await grabStaticRefs(raw);
    const rel = routeToFile(route);
    const file = path.join(OUT, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, transform(raw));
    ok++;
    if (ok % 25 === 0) console.log(`  已抓 ${ok}/${PAGES.length}`);
  } catch (e) {
    failed.push({ route, error: e.message });
  }
}

const queue = [...PAGES];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await grab(queue.shift());
  }),
);

console.log(`\n完成：成功 ${ok} / 失败 ${failed.length} → ${OUT}`);
if (failed.length) {
  console.log("失败清单（前 15 条）：");
  for (const f of failed.slice(0, 15)) console.log(`  ${f.route}  ${f.error}`);
  writeFileSync(path.join(path.dirname(listFile), "_failed.json"), JSON.stringify(failed, null, 2));
}

// 熔断（守门员审计 ym303 #1）：核心页/主题页任何失败、或详情页失败率 >50%（真站部分挂掉的形态），
// 退出码 1 → sync-mirror.sh 走 build_fail 不发布。items/* 少量 404 属正常（未过 LLM 精选），容忍。
const CORE = new Set(["/", "/all", "/hot", "/leaderboard", "/leaderboard/sources", "/leaderboard/rules", "/topics", "/daily", "/weekly", "/monthly", "/about"]);
const coreFail = failed.filter((f) => CORE.has(f.route) || f.route.startsWith("/topics/"));
const itemFails = failed.filter((f) => f.route.startsWith("/items/"));
const itemTotal = PAGES.filter((p) => p.startsWith("/items/")).length || 1;
if (coreFail.length || itemFails.length / itemTotal > 0.5) {
  console.error(`FUSE: 核心/主题页失败 ${coreFail.length} 条，详情页失败率 ${((itemFails.length / itemTotal) * 100).toFixed(1)}% → 拒绝带病发布`);
  process.exit(1);
}
