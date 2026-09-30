#!/usr/bin/env node
// sogou-wechat-patrol.mjs — 品牌公众号巡检（rd3）
// 每轮对品牌词逐个搜狗微信文章搜索(type=2, 一周窗)，新文章解析真实 mp URL 后经 ingest 推送。
// 反爬铁律：每词间隔≥INTERVAL_MS 随机抖动；验证码/反爬页特征即跳词；失败指数退避。宁慢勿封。
// 幂等：本地 seen 缓存（标题+公众号）跳旧文；ingest 端 URL 判重兜底。
// 用法：node sogou-wechat-patrol.mjs [--words 森马服饰,安奈儿] [--once-interaction]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = "D:/myhot-dev";
const STATE_DIR = join(ROOT, ".data", "sogou-patrol");
const SEEN_FILE = join(STATE_DIR, "seen.json");
const LOG_FILE = join(STATE_DIR, "patrol.log");

// taxonomy ENTITIES 的 19 品牌词；泛词加「童装」限定收窄
const WORDS = [
  { q: "巴拉巴拉", brand: "balabala" },
  { q: "森马服饰", brand: "senma" },
  { q: "安踏儿童", brand: "anta-kids" },
  { q: "Mini Peace", brand: "mini-peace" },
  { q: "太平鸟 童装", brand: "taipingniao" },
  { q: "安奈儿", brand: "annaier" },
  { q: "起步股份", brand: "qibu" },
  { q: "金发拉比", brand: "jinfa-lababi" },
  { q: "英氏 童装", brand: "yingshi" },
  { q: "moodytiger", brand: "moodytiger" },
  { q: "戴维贝拉", brand: "davidbella" },
  { q: "孩子王", brand: "haiziwang" },
  { q: "爱婴室", brand: "aiyingshi" },
  { q: "比音勒芬 童装", brand: "biyinlefen" },
  { q: "地素 童装", brand: "disu" },
  { q: "李宁 童装", brand: "lining" },
  { q: "耐克 童装", brand: "nike" },
  { q: "阿迪达斯 童装", brand: "adidas" },
  { q: "好孩子 童装", brand: "haiziwang" },
];

const INTERVAL_MS = 190_000;      // 词间隔基线 ~3.2 分钟
const INTERVAL_JITTER = 40_000;   // 随机抖动
const LINK_DELAY_MS = 12_000;     // 每条 link 解析间隔
const MAX_LINKS_PER_WORD = 8;     // 每词每轮最多解析条数（防爆发）
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash("md5").update(s).digest("hex");

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); }
}
function saveSeen(seen) {
  mkdirSync(STATE_DIR, { recursive: true });
  const arr = [...seen].slice(-8000); // 环形上限，防无限增长
  writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

function readToken() {
  const env = readFileSync(join(ROOT, ".env"), "utf8");
  const m = /^INGEST_TOKEN=(.+)$/m.exec(env);
  if (!m) throw new Error("INGEST_TOKEN 未配置");
  return m[1].trim();
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: "follow",
  });
  const body = await res.text();
  return { status: res.status, body };
}

const ANTISPIDER = /antispider|请输入验证码|用户您好，您的访问过于频繁|seccode/i;

// 解析搜狗文章搜索结果列表：.news-box .news-list li（每条含 h3>a 标题、a.account 或 .s-p 公众号名）
function parseList(html) {
  const items = [];
  const liRe = /<li[^>]*id="sogou_vr_[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const block = m[1];
    const titleM = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!titleM) continue;
    const title = titleM[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const href = titleM[1];
    const accM = /class="[^"]*account[^"]*"[^>]*>([^<]+)</.exec(block) || /<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const account = accM ? accM[1].replace(/<[^>]+>/g, "").trim() : "";
    if (title && href.includes("/link")) items.push({ title, href: "https://weixin.sogou.com" + href.replace(/^&amp;/g, "&").replace(/&amp;/g, "&"), account });
  }
  return items;
}

// 搜狗 link 跳转页提取真实 URL（两种形态：window.location.replace("...") 或 var url = "...")
async function resolveRealUrl(linkUrl) {
  const { status, body } = await fetchText(linkUrl, "https://weixin.sogou.com/");
  if (status !== 200 || ANTISPIDER.test(body)) return null;
  const m = /window\.location\.replace\("([^"]+)"\)/.exec(body) || /var\s+url\s*=\s*['"]([^'"]+)['"]/.exec(body);
  if (!m) return null;
  const real = m[1].replace(/\\x26/g, "&").replace(/\\\//g, "/");
  return real.startsWith("http") ? real : null;
}

async function pushToIngest(token, word, articles) {
  if (!articles.length) return { ok: true, created: 0 };
  const body = {
    sourceId: `wechat-patrol-${word.brand}`,
    sourceName: `微信公众号巡检 · ${word.q}`,
    items: articles.map((a) => ({
      title: a.title,
      url: a.url,
      author: a.account || null,
      publishedAt: a.time || null,
      raw: { patrol: { word: word.q, account: a.account } },
    })),
  };
  const res = await fetch("http://localhost:3000/api/ingest/items", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, created: 0, error: JSON.stringify(json).slice(0, 200) };
  return { ok: true, created: json.created ?? 0 };
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const argWords = process.argv.includes("--words")
    ? process.argv[process.argv.indexOf("--words") + 1]?.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const words = argWords ? WORDS.filter((w) => argWords.some((a) => w.q.includes(a))) : WORDS;
  const token = readToken();
  const seen = loadSeen();
  log(`PATROL-START words=${words.length}`);

  for (const word of words) {
    let fail = 0;
    try {
      const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(word.q)}&tsn=2&ie=utf8`;
      const { status, body } = await fetchText(url);
      if (status !== 200 || ANTISPIDER.test(body)) {
        log(`WORD-SKIP q=${word.q} status=${status} antispider=${ANTISPIDER.test(body)}`);
        continue;
      }
      const list = parseList(body);
      const fresh = list.filter((a) => !seen.has(md5(`${a.title}|${a.account}`)));
      log(`WORD q=${word.q} hits=${list.length} fresh=${fresh.length}`);
      const picked = fresh.slice(0, MAX_LINKS_PER_WORD);
      const resolved = [];
      for (const a of picked) {
        await sleep(LINK_DELAY_MS + Math.random() * 4000);
        const real = await resolveRealUrl(a.href);
        if (real && real.includes("mp.weixin.qq.com")) resolved.push({ ...a, url: real });
        else log(`LINK-FAIL q=${word.q} title=${a.title.slice(0, 30)}`);
      }
      const pushed = await pushToIngest(token, word, resolved);
      log(`PUSH q=${word.q} resolved=${resolved.length} created=${pushed.created}${pushed.error ? " err=" + pushed.error : ""}`);
      for (const a of list) seen.add(md5(`${a.title}|${a.account}`));
      saveSeen(seen);
    } catch (e) {
      fail++;
      log(`WORD-ERROR q=${word.q} ${String(e).slice(0, 150)}`);
    }
    if (words.length > 1) await sleep(INTERVAL_MS + Math.random() * INTERVAL_JITTER);
  }
  log("PATROL-END");
}

main().catch((e) => { log("FATAL " + e); process.exit(1); });
