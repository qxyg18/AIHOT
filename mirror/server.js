// 童装雷达镜像站 · 只读服务（C 方案验证版）
// 零 npm 依赖：node:http + node:sqlite。监听 PORT，绑 0.0.0.0，单端口对外。
// 数据源优先 SQLite（data/mirror.db），不可用时回落 data/*.json。
// 内容口径：只发标题、提要（正文前 140 字）、来源与原文链接；正文与后台不出镜像。
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PAGE_SIZE = 50;

const readJson = (f) => JSON.parse(readFileSync(path.join(DATA, f), "utf8"));

async function loadStore() {
  const jsonFallback = () => ({
    kind: "json",
    articles: readJson("articles.json"),
    boards: readJson("boards.json"),
    topics: readJson("topics.json"),
    hot: readJson("hot.json"),
    meta: readJson("meta.json"),
  });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(DATA, "mirror.db"), { readOnly: true });
    const store = {
      kind: "sqlite",
      articles: db.prepare("select * from articles order by published_at desc").all(),
      boards: db.prepare("select * from boards order by board, rank").all(),
      topics: db.prepare("select * from topics order by name").all(),
      hot: db.prepare("select payload from hot order by idx").all().map((r) => JSON.parse(r.payload)),
      meta: Object.fromEntries(db.prepare("select * from meta").all().map((r) => [r.key, r.value])),
    };
    db.close();
    return store;
  } catch (err) {
    console.warn(`[mirror] SQLite 不可用（${err.message}），回落 JSON`);
    return jsonFallback();
  }
}

const store = await loadStore();
const BOARD_LABEL = { brand: "品牌榜", mall: "商业体榜" };

const esc = (s) => {
  if (s == null) return "";
  const str = typeof s === "object" ? JSON.stringify(s) : String(s);
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
};

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--line:#e3e2de;--ink:#1f1e1c;--muted:#6b6a66;--accent:#1d4ed8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 20px}
header h1{margin:0;font-size:17px;font-weight:600;display:inline-block}
header .badge{margin-left:10px;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:1px 8px}
nav{margin-top:10px;display:flex;flex-wrap:wrap;gap:14px;font-size:14px}
nav a{color:var(--muted)}
nav a.on{color:var(--ink);font-weight:600}
main{max-width:960px;margin:0 auto;padding:20px}
.notice{background:#fff8e6;border:1px solid #f0e0b0;border-radius:8px;padding:10px 14px;font-size:13px;color:#6b5a20;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px}
.card h2{margin:0 0 10px;font-size:15px;font-weight:600}
ul.list{list-style:none;margin:0;padding:0}
ul.list li{padding:10px 0;border-top:1px solid var(--line)}
ul.list li:first-child{border-top:0}
.title{font-size:15px;font-weight:500;color:var(--ink)}
.meta{font-size:12px;color:var(--muted);margin-top:3px}
.lead{font-size:13px;color:#444;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.rank{display:inline-block;min-width:24px;color:var(--muted)}
footer{max-width:960px;margin:0 auto;padding:20px;font-size:12px;color:var(--muted)}
.pager{display:flex;gap:12px;margin-top:14px;font-size:14px}
`;

const layout = (title, body, active = "") => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 童装雷达镜像站</title><style>${CSS}</style></head>
<body>
<header>
  <h1>童装雷达</h1><span class="badge">只读镜像</span>
  <nav>
    <a href="/" class="${active === "home" ? "on" : ""}">首页</a>
    <a href="/all" class="${active === "all" ? "on" : ""}">全部动态</a>
    <a href="/hot" class="${active === "hot" ? "on" : ""}">热点榜</a>
    <a href="/leaderboard?board=brand" class="${active === "board" ? "on" : ""}">双榜</a>
    <a href="/topics" class="${active === "topics" ? "on" : ""}">主题</a>
  </nav>
</header>
<main>
<div class="notice">本页为本地情报站的只读镜像，内容按「标题 + 提要 + 原文链接」口径发布，正文与后台不出镜像。数据截止 <b>${esc(store.meta.data_cutoff || "未知")}</b>，导出时点 ${esc(store.meta.generated_at || "未知")}。</div>
${body}
</main>
<footer>童装雷达镜像站 · 数据源 ${store.kind} · 条目 ${store.articles.length} · 生成于 ${esc(store.meta.generated_at || "")}</footer>
</body></html>`;

const articleItem = (a) => `<li>
  <div class="title"><a href="/items/${encodeURIComponent(a.id)}">${esc(a.title)}</a></div>
  <div class="meta">${esc(a.source_name || "")} · ${esc(a.published_at || "")} · <a href="${esc(a.url)}" target="_blank" rel="noopener">原文</a></div>
  ${a.lead_text ? `<div class="lead">${esc(a.lead_text)}…</div>` : ""}
</li>`;

function pageHome() {
  const latest = store.articles.slice(0, 20);
  const boardCounts = store.boards.reduce((acc, b) => ((acc[b.board] = (acc[b.board] || 0) + 1), acc), {});
  const boardRows = ["brand", "mall"]
    .filter((k) => boardCounts[k])
    .map((k) => `<tr><td><a href="/leaderboard?board=${k}">${BOARD_LABEL[k]}</a></td><td class="num">${boardCounts[k]} 条</td></tr>`)
    .join("");
  const hotRows =
    store.hot
      .slice(0, 5)
      .map(
        (h, i) => `<tr><td><span class="rank">${h.rank ?? i + 1}</span></td>
<td><a href="/hot">${esc(h.title)}</a></td>
<td class="num">${h.heat ?? ""}</td>
<td class="num">${h.reportCount ?? ""}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4" style="color:#888">热点榜暂无数据</td></tr>`;

  return layout(
    "首页",
    `<div class="card"><h2>双榜</h2><table><thead><tr><th>榜单</th><th class="num">条数</th></tr></thead><tbody>${boardRows}</tbody></table></div>
<div class="card"><h2>热点榜 TOP5</h2><table><thead><tr><th>#</th><th>标题</th><th class="num">热度</th><th class="num">报道数</th></tr></thead><tbody>${hotRows}</tbody></table></div>
<div class="card"><h2>最新动态</h2><ul class="list">${latest.map(articleItem).join("")}</ul>
<div class="pager"><a href="/all">查看全部 ${store.articles.length} 条 →</a></div></div>`,
    "home",
  );
}

function pageAll(page) {
  const total = store.articles.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(Math.max(1, page), pages);
  const rows = store.articles.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  return layout(
    `全部动态 第 ${cur} 页`,
    `<div class="card"><h2>全部动态</h2><ul class="list">${rows.map(articleItem).join("")}</ul>
<div class="pager">${cur > 1 ? `<a href="/all?page=${cur - 1}">← 上一页</a>` : ""}<span>第 ${cur} / ${pages} 页 · 共 ${total} 条</span>${cur < pages ? `<a href="/all?page=${cur + 1}">下一页 →</a>` : ""}</div></div>`,
    "all",
  );
}

function pageItem(id) {
  const a = store.articles.find((x) => x.id === id);
  if (!a) return null;
  return layout(
    a.title,
    `<div class="card"><h2>${esc(a.title)}</h2>
<div class="meta">${esc(a.source_name || "")} · ${esc(a.published_at || "")}</div>
${a.lead_text ? `<p class="lead">${esc(a.lead_text)}…</p>` : ""}
<div class="pager"><a href="${esc(a.url)}" target="_blank" rel="noopener">前往原文 →</a><a href="/all">返回列表</a></div></div>`,
    "all",
  );
}

function pageHot() {
  const rows = store.hot
    .map(
      (h, i) => `<tr><td><span class="rank">${h.rank ?? i + 1}</span></td>
<td><div class="title">${esc(h.title)}</div><div class="meta">${esc((h.sourceNames || []).join(" · "))} · ${esc(h.latestAt || "")}</div></td>
<td class="num">${h.heat ?? ""}</td><td class="num">${h.reportCount ?? ""}</td><td class="num">${h.trendPct ?? ""}</td></tr>`,
    )
    .join("") || `<tr><td colspan="5" style="color:#888">暂无数据</td></tr>`;
  return layout(
    "热点榜",
    `<div class="card"><h2>热点榜</h2><table><thead><tr><th>#</th><th>事件</th><th class="num">热度</th><th class="num">报道</th><th class="num">趋势%</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    "hot",
  );
}

function pageLeaderboard(board) {
  const key = BOARD_LABEL[board] ? board : "brand";
  const rows = store.boards.filter((b) => b.board === key);
  const body = rows
    .map(
      (b) => `<tr><td><span class="rank">${b.rank}</span></td><td>${esc(b.model_name)}</td>
<td class="num">${b.score == null ? "" : Number(b.score).toFixed(1)}</td><td>${esc(b.confidence || "")}</td>
<td>${esc((b.summary || "").slice(0, 60))}</td></tr>`,
    )
    .join("");
  const tabs = Object.keys(BOARD_LABEL)
    .map((k) => `<a href="/leaderboard?board=${k}" class="${k === key ? "on" : ""}">${BOARD_LABEL[k]}</a>`)
    .join("　");
  return layout(
    BOARD_LABEL[key],
    `<div class="card"><h2>${BOARD_LABEL[key]}（${rows.length} 条）</h2><div class="pager">${tabs}</div>
<table><thead><tr><th>#</th><th>名称</th><th class="num">得分</th><th>置信</th><th>摘要</th></tr></thead><tbody>${body}</tbody></table>
<div class="meta" style="margin-top:10px">榜单代次 ${esc(store.meta.leaderboard_run || "")} · 生成于 ${esc(store.meta.leaderboard_generated_at || "")}</div></div>`,
    "board",
  );
}

function pageTopics() {
  const rows = store.topics
    .map((t) => `<tr><td><a href="/topics/${encodeURIComponent(t.slug)}">${esc(t.name)}</a></td><td>${esc(t.grp)}</td><td>${esc((t.definition || "").slice(0, 70))}</td></tr>`)
    .join("");
  return layout(
    "主题",
    `<div class="card"><h2>主题（${store.topics.length}）</h2><table><thead><tr><th>主题</th><th>分组</th><th>定义</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    "topics",
  );
}

function pageTopic(slug) {
  const t = store.topics.find((x) => x.slug === slug);
  if (!t) return null;
  return layout(
    t.name,
    `<div class="card"><h2>${esc(t.name)}</h2><div class="meta">分组 ${esc(t.grp)}</div>
<p class="lead">${esc(t.definition || "")}</p>
<div class="pager"><a href="/topics">返回主题列表</a></div></div>`,
    "topics",
  );
}

const server = createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error("[mirror] 请求处理失败:", err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`镜像站渲染失败：${err.message}`);
  }
});

function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const seg = url.pathname.split("/").filter(Boolean);
  const send = (html, code = 200) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(html);
  };

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, source: store.kind, articles: store.articles.length }));
  }
  if (url.pathname === "/meta") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(store.meta, null, 2));
  }

  let html = null;
  if (seg.length === 0) html = pageHome();
  else if (seg[0] === "all") html = pageAll(Number(url.searchParams.get("page") || 1));
  else if (seg[0] === "items" && seg[1]) html = pageItem(decodeURIComponent(seg[1]));
  else if (seg[0] === "hot") html = pageHot();
  else if (seg[0] === "leaderboard") html = pageLeaderboard(url.searchParams.get("board") || "brand");
  else if (seg[0] === "topics" && !seg[1]) html = pageTopics();
  else if (seg[0] === "topics" && seg[1]) html = pageTopic(decodeURIComponent(seg[1]));

  if (html) return send(html);
  return send(layout("未找到", `<div class="card"><h2>页面不存在</h2><div class="pager"><a href="/">返回首页</a></div></div>`), 404);
}

server.listen(PORT, HOST, () => {
  console.log(`[mirror] listening on http://${HOST}:${PORT} · source=${store.kind} · articles=${store.articles.length}`);
  console.log(`[mirror] 数据截止 ${store.meta.data_cutoff}，导出时点 ${store.meta.generated_at}`);
});
