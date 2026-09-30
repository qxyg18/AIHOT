#!/usr/bin/env node
// bili-patrol.mjs — 品牌B站官方号动态巡检（rd3）
// 7 个品牌官方号动态接口（buvid3 cookie 化解 412），新动态经 ingest 推送。
// 幂等：本地 seen 缓存（动态 id_str）；ingest 端 URL 判重兜底。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/myhot-dev";
const STATE_DIR = join(ROOT, ".data", "bili-patrol");
const SEEN_FILE = join(STATE_DIR, "seen.json");
const LOG_FILE = join(STATE_DIR, "patrol.log");

// 2026-09-30 经真实浏览器用户搜索逐个甄别（scripts/bili-official-ids.mjs）
const ACCOUNTS = [
  { mid: "1722730761", brand: "balabala", name: "巴拉巴拉官方" },
  { mid: "88955820", brand: "annaier", name: "安奈儿童装旗舰店" },
  { mid: "405846", brand: "haiziwang", name: "孩子王" },
  { mid: "2020568044", brand: "moodytiger", name: "moodytiger" },
  { mid: "6805175", brand: "davidbella", name: "戴维贝拉" },
  { mid: "1967254800", brand: "taipingniao", name: "太平鸟童装" },
  { mid: "1305575743", brand: "mini-peace", name: "mini-peace" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSeen() { try { return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); } }
function saveSeen(seen) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-5000)));
}
function readToken() {
  const m = /^INGEST_TOKEN=(.+)$/m.exec(readFileSync(join(ROOT, ".env"), "utf8"));
  if (!m) throw new Error("INGEST_TOKEN 未配置");
  return m[1].trim();
}

async function getBuvidCookie() {
  // spi 指纹接口拿 buvid3+buvid4（-352 风控需完整指纹对），再凑 b_nut
  const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" } });
  const j = await r.json().catch(() => null);
  const parts = [];
  if (j && j.data && j.data.b_3 && j.data.b_4) {
    parts.push(`buvid3=${j.data.b_3}`, `buvid4=${j.data.b_4}`);
  }
  const r0 = await fetch("https://www.bilibili.com/", { headers: { "User-Agent": UA } });
  for (const c of (r0.headers.getSetCookie ? r0.headers.getSetCookie() : [])) {
    const kv = c.split(";")[0];
    if (kv.startsWith("b_nut=")) parts.push(kv);
  }
  if (!parts.some((p) => p.startsWith("buvid3="))) throw new Error("buvid3 获取失败");
  return parts.join("; ");
}

// 动态条目 → {title,url,publishedAt}；三种形态：视频(major.archive)/图文(desc+draw)/纯文字(desc)
function toArticle(item) {
  // 实测 2026-10-01：modules 数组可含 null 条目（风控半解除期的真实形态），不过滤会 TypeError
  const mods = (Array.isArray(item.modules) ? item.modules : Object.values(item.modules || {})).filter(Boolean);
  const dyn = (mods.find((m) => m.module_dynamic) || {}).module_dynamic || {};
  const author = (mods.find((m) => m.module_author) || {}).module_author || {};
  const major = dyn.major || {};
  const arc = major.archive;
  const idStr = item.id_str;
  let title = null, url = null;
  if (arc && arc.title) {
    title = arc.title;
    url = `https://www.bilibili.com/video/${arc.bvid}`;
  } else if (dyn.desc && dyn.desc.text && dyn.desc.text.trim()) {
    title = dyn.desc.text.trim().slice(0, 80);
    url = `https://t.bilibili.com/${idStr}`;
  }
  if (!title || !url) return null;
  // 过滤纯转发（无实质内容）
  if (item.orig && !dyn.desc?.text && !arc) return null;
  const pubTs = author.pub_ts || arc?.pubdate || item.id_str?.slice(0, 10);
  return {
    title: `[B站·${author.name || ""}] ${title}`,
    url,
    publishedAt: pubTs && String(pubTs).length === 10 ? new Date(Number(pubTs) * 1000).toISOString() : null,
  };
}

async function pushToIngest(token, acc, arts) {
  if (!arts.length) return { created: 0 };
  const res = await fetch("http://localhost:3000/api/ingest/items", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceId: `bili-${acc.brand}`,
      sourceName: `哔哩哔哩官方号 · ${acc.name}`,
      items: arts.map((a) => ({ ...a, raw: { patrol: { mid: acc.mid, account: acc.name } } })),
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { created: json.created ?? 0, error: res.ok ? null : JSON.stringify(json).slice(0, 150) };
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const token = readToken();
  const cookie = await getBuvidCookie();
  const seen = loadSeen();
  log(`PATROL-START accounts=${ACCOUNTS.length}`);
  for (const acc of ACCOUNTS) {
    try {
      const r = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${acc.mid}`, {
        headers: { "User-Agent": UA, Referer: `https://space.bilibili.com/${acc.mid}`, Accept: "application/json", Cookie: cookie },
      });
      if (r.status !== 200) { log(`ACC-FAIL ${acc.brand} http=${r.status}`); continue; }
      const j = await r.json();
      if (j.code !== 0) { log(`ACC-FAIL ${acc.brand} code=${j.code}`); continue; }
      const items = (j.data && j.data.items) || [];
      const arts = [];
      for (const it of items.slice(0, 12)) {
        if (seen.has(it.id_str)) continue;
        const a = toArticle(it);
        if (a) arts.push({ ...a, id: it.id_str });
      }
      const pushed = await pushToIngest(token, acc, arts);
      log(`ACC ${acc.brand} hits=${items.length} fresh=${arts.length} created=${pushed.created}${pushed.error ? " err=" + pushed.error : ""}`);
      for (const it of items.slice(0, 12)) seen.add(it.id_str);
      saveSeen(seen);
    } catch (e) { log(`ACC-ERROR ${acc.brand} ${String(e).slice(0, 120)}`); }
    await sleep(15000 + Math.random() * 5000);
  }
  log("PATROL-END");
}
main().catch((e) => { log("FATAL " + e); process.exit(1); });
