// crawl-full.mjs — 镜像站全站 BFS 抓取（命主 2026-10-04 令：各模块各下级页面与原版全量一致）
// 从核心页出发沿站内链接全量发现页面，抓取已渲染 HTML 剥 JS 落静态目录。
// 用法: node crawl-full.mjs
// 产物: 页面→D:/myhot-dev/mirror-fidelity/<route>/index.html；清单→_work/manifest.json；失败→_work/_failed.json
// 熔断（R2 口径）: 核心 11 页或任一 /topics/* 失败、pool 内 id 404 零容忍、items 404 总量>max(400,种子×30%)、
//   items 非404失败率>50%、全局非404失败率>20%、CSS 失败≥1 或图片字体失败>10 → exit 1（sync 走 build_fail 不发布）
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SRC_BASE || "http://localhost:3000";
const OUT = process.env.OUT_DIR || "D:/myhot-dev/mirror-fidelity";
const WORK = process.env.WORK_DIR || "D:/myhot-dev/scripts/mirror/_work";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const MAX_PAGES = Number(process.env.MAX_PAGES || 4000);

const CORE_SEEDS = ["/", "/all", "/hot", "/leaderboard", "/leaderboard/sources", "/leaderboard/rules", "/topics", "/daily", "/weekly", "/monthly", "/about"];
const CORE_SET = new Set(CORE_SEEDS);

// 文章详情种子双通道（守门员审计 ym306 M1 修法）：pool.json（客户端渲染盲区，BFS 只能发现 ~219/511）
// ∪ article_ids.json（articles 表全量 id，含不在 pool 展示流但详情页仍可访问的已发布文章）
const POOL_FILE = process.env.POOL_FILE || "D:/myhot-dev/scripts/mirror/_work/pool.json";
const IDS_FILE = process.env.IDS_FILE || "D:/myhot-dev/mirror/data/article_ids.json";
const seedIds = new Set();
const poolIds = new Set(); // pool=已证发布的展示流，其 404 不容忍（审计 R2 #1）
if (existsSync(POOL_FILE)) for (const it of JSON.parse(readFileSync(POOL_FILE, "utf8")).items) { seedIds.add(it.id); poolIds.add(it.id); }
if (existsSync(IDS_FILE)) for (const id of JSON.parse(readFileSync(IDS_FILE, "utf8"))) seedIds.add(id);
const ITEM_SEEDS = [...seedIds].map((id) => `/items/${id}`);
const SEEDS = [...CORE_SEEDS, ...ITEM_SEEDS];

// 排除规则：管理/接口/下载/功能页不进镜像
const EXCLUDE_RE = /^\/(api\/|admin|codex-reset|items\/[^/]+\/markdown|og\/|media\/|_)/;
// /all 的 page/category/tag/channel 有限组合走静态化（ym307）；q（搜索，命主令不配）与其余路径的筛选/搜索参数不抓（无限空间）
const BAD_PARAMS = new Set(["q", "tag", "category", "channel", "cursor", "tab", "revision", "take", "ids", "hide", "mallType"]);
// 允许静态化的参数白名单（翻页/榜单切换等有限空间）
const OK_PARAMS = new Set(["page", "board", "month"]);
// 纯展示/客户端标记参数：不影响服务端页面身份，归一化时直接剥离而非整条丢弃
// （2026-10-05 修：榜单实体链接一律带 ?from=brand|mall，原逻辑整条 return null → 60 个实体详情页从未被抓）
const DROP_PARAMS = new Set([...BAD_PARAMS, "from"]);

// ── 客户端渲染页：浏览器快照通道（2026-10-05 修）
// /macro 的 6 个图表是 canvas 客户端绘制，fetch 只能拿到无图骨架（实测 canvas 0→6）。
// 处理：渲染完成 → canvas.toDataURL 内联为 <img> → 再走 transform 剥 JS，静态页即可见。
const RENDER_PAGES = new Set(["/macro"]);
const CHROME_EXE =
  process.env.CHROME_EXE ||
  ["C:/Users/yy/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe"].find((p) => existsSync(p));
let browser = null;
const getBrowser = async () => {
  if (browser) return browser;
  const { chromium } = await import("playwright");
  const opts = { headless: true };
  if (CHROME_EXE) opts.executablePath = CHROME_EXE;
  else opts.channel = "msedge"; // 兜底：本机系统 Edge（verify-mirror.cjs 同通道）
  browser = await chromium.launch(opts);
  return browser;
};
const renderSnap = async (route) => {
  const b = await getBrowser();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  try {
    await p.goto(BASE + route, { waitUntil: "networkidle", timeout: 60000 });
    await p.waitForTimeout(2500); // 等图表绘制完成
    return await p.evaluate(() => {
      document.querySelectorAll("canvas").forEach((c) => {
        try {
          const r = c.getBoundingClientRect();
          const img = document.createElement("img");
          img.src = c.toDataURL("image/png");
          img.alt = c.getAttribute("aria-label") || "图表";
          if (c.className) img.className = c.className;
          img.style.width = Math.round(r.width) + "px";
          img.style.height = Math.round(r.height) + "px";
          c.replaceWith(img);
        } catch {}
      });
      return "<!doctype html>" + document.documentElement.outerHTML;
    });
  } finally {
    await p.close();
  }
};

const fetchText = async (u) => {
  if (RENDER_PAGES.has(u)) {
    const snap = await renderSnap(u).catch((e) => {
      console.warn(`  渲染快照失败，回退 fetch：${u} — ${e.message}`);
      return null;
    });
    if (snap) return snap;
  }
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
const fetchBinary = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

// 与 fetch-fidelity 同一映射规则：/a/b?x=1 → a/b/x-1/index.html
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

// 站内链接规范化 → route；不合格返回 null
function normRoute(href) {
  if (!href || href.startsWith("#") || href.startsWith("//") || href.startsWith("mailto:") || href.startsWith("javascript:")) return null;
  href = href.replace(/&amp;/g, "&"); // HTML 转义还原（&amp;page=2 会被 URLSearchParams 读成 amp;page 键而误杀筛选+翻页组合）
  if (/^https?:\/\//.test(href)) return null; // 外链
  if (!href.startsWith("/")) return null;
  let route = href.split("#")[0];
  if (!route || EXCLUDE_RE.test(route)) return null;
  // 静态文件（favicon/css/图片等）由 grabStaticRefs 处理，不进页面队列
  const lastSeg = route.split("?")[0].split("/").pop();
  if (lastSeg.includes(".")) return null;
  const qi = route.indexOf("?");
  if (qi >= 0) {
    const p = route.slice(0, qi);
    const params = new URLSearchParams(route.slice(qi + 1));
    if (p === "/all" || p === "/all/") {
      // ym307 命主令（2026-10-05）：除搜索外全静态对齐——/all 的 page/category/tag/channel
      // 有限组合全部静态化（BFS 沿 chip 链接自动发现），q（搜索）与其余参数不抓
      const ALL_OK = new Set(["page", "category", "tag", "channel"]);
      for (const k of params.keys()) if (!ALL_OK.has(k)) return null;
      const pairs = [...params.entries()].sort();
      route = p + "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&");
      return route.replace(/\/+$/, "") || "/";
    }
    for (const k of [...params.keys()]) if (DROP_PARAMS.has(k)) params.delete(k); // 展示型参数剥离
    if ([...params.keys()].length === 0) {
      route = p; // 剥离后等价裸路径：/leaderboard/x?from=brand ≡ /leaderboard/x
    } else {
      for (const k of params.keys()) if (!OK_PARAMS.has(k)) return null;
      // 规范化参数顺序（防 page=1&board=x 与 board=x&page=1 双份）
      const pairs = [...params.entries()].sort();
      route = p + "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&");
    }
  }
  return route.replace(/\/+$/, "") || "/";
}

const cssSeen = new Set();
const binSeen = new Set();
let cssFail = 0;
let binFail = 0;
async function grabStaticRefs(raw) {
  const css = [...raw.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const assets = [...raw.matchAll(/<link[^>]*rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  // 页面内引用的站内二进制（图片/字体/媒体）
  const bins = [...raw.matchAll(/(?:src|href)="(\/[^"]+\.(?:png|jpe?g|webp|svg|ico|woff2?|avif|gif))"/g)].map((m) => m[1]);
  for (const href of css) {
    if (cssSeen.has(href)) continue;
    cssSeen.add(href);
    const buf = await fetchBinary(href).catch((e) => console.warn(`  css ${href} 失败 ${e.message}`));
    if (!buf) {
      cssFail++;
      continue;
    }
    const f = path.join(OUT, href.replace(/^\//, ""));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, buf);
  }
  for (const href of [...assets, ...bins]) {
    if (binSeen.has(href)) continue;
    binSeen.add(href);
    const buf = await fetchBinary(href).catch(() => null);
    if (!buf) {
      binFail++;
      continue;
    }
    const f = path.join(OUT, href.replace(/^\//, ""));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, buf);
  }
}

const seen = new Set(SEEDS);
const queue = [...SEEDS];
const saved = [];
const failed = [];

async function grab(route) {
  try {
    const raw = await fetchText(route);
    await grabStaticRefs(raw);
    const rel = routeToFile(route);
    const file = path.join(OUT, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, transform(raw));
    saved.push(route);
    if (saved.length % 50 === 0) console.log(`  已抓 ${saved.length}（队列余 ${queue.length}）`);
    // BFS 发现下级链接（用原始 HTML，transform 会把绝对链接改成 #）
    for (const m of raw.matchAll(/href="([^"]+)"/g)) {
      const r = normRoute(m[1]);
      if (r && !seen.has(r) && seen.size < MAX_PAGES) {
        seen.add(r);
        queue.push(r);
      }
    }
  } catch (e) {
    failed.push({ route, error: e.message });
  }
}

mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
console.log(`BFS 抓取启动：核心 ${CORE_SEEDS.length} + 文章种子 ${ITEM_SEEDS.length}，上限 ${MAX_PAGES}`);

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await grab(queue.shift());
  }),
);

console.log(`\n完成：成功 ${saved.length} / 失败 ${failed.length} / 发现 ${seen.size} → ${OUT}`);
if (browser) await browser.close();
writeFileSync(path.join(WORK, "manifest.json"), JSON.stringify({ routes: saved.sort(), crawledAt: new Date().toISOString() }, null, 2));
if (failed.length) {
  console.log("失败清单（前 20 条）：");
  for (const f of failed.slice(0, 20)) console.log(`  ${f.route}  ${f.error}`);
  writeFileSync(path.join(WORK, "_failed.json"), JSON.stringify(failed, null, 2));
} else {
  writeFileSync(path.join(WORK, "_failed.json"), "[]");
}

// 熔断（ym306 审计 R1+R2 口径）：
//  - 核心页/主题页任何失败 → exit 1
//  - pool 内 id 的 404 不容忍（pool=已证发布的展示流，404 即真站说假话）→ exit 1
//  - items 404 总量闸门 >max(400, 种子×30%) → exit 1（防详情端点整体故障伪装正常，审计 R2 #1）
//  - items 非404失败率>50%、全局非404失败率>20% → exit 1
//  - CSS 抓取失败 ≥1（白版裸站）或图片/字体类失败 >10 → exit 1（审计 R2 #5）
const is404 = (f) => /HTTP 404/.test(f.error);
const coreFail = failed.filter((f) => CORE_SET.has(f.route) || f.route.startsWith("/topics/"));
const item404 = failed.filter((f) => f.route.startsWith("/items/") && is404(f));
const pool404 = item404.filter((f) => poolIds.has(f.route.split("/").pop()));
const itemFails = failed.filter((f) => f.route.startsWith("/items/") && !is404(f));
const itemTotal = saved.filter((r) => r.startsWith("/items/")).length + failed.filter((f) => f.route.startsWith("/items/")).length || 1;
const non404 = failed.filter((f) => !is404(f));
const totalRate = non404.length / (saved.length + failed.length || 1);
const gate404 = Math.max(400, Math.floor(ITEM_SEEDS.length * 0.3));
console.log(`失败构成：404=${failed.filter(is404).length}（闸门 ${gate404}，pool 内 ${pool404.length}） 非404=${non404.length} 静态资源失败 css=${cssFail} bin=${binFail}`);
if (coreFail.length || pool404.length || item404.length > gate404 || itemFails.length / itemTotal > 0.5 || totalRate > 0.2 || cssFail > 0 || binFail > 10) {
  console.error(`FUSE: 核心/主题页=${coreFail.length} pool内404=${pool404.length} items404=${item404.length}/${gate404} 详情非404率=${((itemFails.length / itemTotal) * 100).toFixed(1)}% 全局非404率=${(totalRate * 100).toFixed(1)}% css=${cssFail} bin=${binFail} → 拒绝带病发布`);
  process.exit(1);
}
console.log("CRAWL_OK");
