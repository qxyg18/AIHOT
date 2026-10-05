#!/usr/bin/env node
// doubao-search-patrol.mjs — 豆包搜索（火山 SearchInfinity）信源采集器 · ym300
// 常态词池轮换采集（am/pm 各 5 词：行业2+品牌3）→ 客户端护栏 → 推 ingest，复用雷达判重/精选/归组全链路。
// 护栏：AuthInfoLevel=4 丢弃 → 垃圾形态闸（域名黑名单/形态词/官网裸首页）→ 48h 时效窗（常态）→ 同题通稿只留首条 → seen（Id+URL）去重。
// 配额三层熔断：450 停常态 / 480 全停（--force-override 可越过并记因）/ 自然月重置（quota.json 自记账）。
// 计数口径=保守：每次实际发出的 HTTP 请求都计（失败是否计费官方未证实，宁可高估）。
// 幂等：seen 在 ingest 成功后才落盘；ingest 端 URL 判重兜底；失败不推进位置。
// 用法：node doubao-search-patrol.mjs --round=am|pm [--dry-run] [--max-words=N]
//      node doubao-search-patrol.mjs --purpose=manual|deep --query="..." [--force-override]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/myhot-dev";
const STATE_DIR = join(ROOT, ".data", "doubao-search");
const SEEN_FILE = join(STATE_DIR, "seen.json");
const LOG_FILE = join(STATE_DIR, "patrol.log");
const QUOTA_FILE = join(STATE_DIR, "quota.json");
const QUERIES_FILE = join(STATE_DIR, "queries.json");

const SEARCH_API = "https://open.feedcoopapi.com/search_api/web_search";
const INGEST_URL = "http://localhost:3000/api/ingest/items";
const MONTHLY_CAP = 500; // 控制台免费池（命主 2026-10-04 核实 500 档）
const DAILY_STOP = 450; // 常态采集停线
const HARD_STOP = 480; // 全停线（manual/deep 同停）
const FRESH_MS = 48 * 3600 * 1000;
const TIMEOUT_MS = 30000;
const MAX_RETRY = 1;

const argv = process.argv.slice(2);
const arg = (name) => {
  const m = argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : null;
};
const has = (name) => argv.includes(`--${name}`);
const round = arg("round") || "am";
const dryRun = has("dry-run");
const purpose = arg("purpose") || (dryRun ? "probe" : "daily");
const manualQuery = arg("query");
const forceOverride = has("force-override");
const maxWords = parseInt(arg("max-words") || "99", 10);

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv(key) {
  const m = new RegExp(`^${key}=(.+)$`, "m").exec(readFileSync(join(ROOT, ".env"), "utf8"));
  if (!m) throw new Error(`${key} 未配置`);
  return m[1].trim();
}

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function loadQuota() {
  try {
    const q = JSON.parse(readFileSync(QUOTA_FILE, "utf8"));
    if (q.month === monthKey()) return q;
    log(`QUOTA-ROLLOVER ${q.month}→${monthKey()}（上月 used=${q.used}）`);
  } catch {}
  return { month: monthKey(), used: 0, purposes: { daily: 0, manual: 0, deep: 0, probe: 0, retry: 0 } };
}
const saveQuota = (q) => {
  q.updated_at = new Date().toISOString();
  writeFileSync(QUOTA_FILE, JSON.stringify(q, null, 2));
};
const bumpQuota = (q, p, n) => { q.used += n; q.purposes[p] = (q.purposes[p] || 0) + n; };

function loadSeen() {
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); } catch { return { ids: [], urls: [] }; }
}
const saveSeen = (s) => writeFileSync(SEEN_FILE, JSON.stringify({ ids: [...s.ids].slice(-5000), urls: [...s.urls].slice(-5000) }));

const loadQueries = () => JSON.parse(readFileSync(QUERIES_FILE, "utf8"));

// 常态词选择：按日期确定性轮换（行业 4/天 + 品牌 6/天；品牌池约 9-10 天全覆盖一轮）
function pickDailyWords(q, rnd) {
  const dayIdx = new Date().getDate() - 1;
  const ind = q.industry, brands = q.brands, n = ind.length, m = brands.length;
  if (rnd === "am") {
    return [ind[dayIdx % n], ind[(dayIdx + 1) % n],
            brands[(dayIdx * 6) % m], brands[(dayIdx * 6 + 1) % m], brands[(dayIdx * 6 + 2) % m]];
  }
  return [ind[(dayIdx + 2) % n], ind[(dayIdx + 3) % n],
          brands[(dayIdx * 6 + 3) % m], brands[(dayIdx * 6 + 4) % m], brands[(dayIdx * 6 + 5) % m]];
}

// 单词搜索：重试≤1（网络/5xx/429）；鉴权失败不重试（失败即停口径）
async function searchWord(apiKey, query) {
  let attempts = 0;
  for (let i = 0; i <= MAX_RETRY; i++) {
    attempts++;
    try {
      const res = await fetch(SEARCH_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ Query: query, SearchType: "web", Count: 10 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new Error(`AUTH-FAIL http=${res.status}`);
      const j = await res.json().catch(() => null);
      const err = j && j.ResponseMetadata && j.ResponseMetadata.Error;
      if (!res.ok || err) throw new Error(`API-ERR http=${res.status} ${err ? JSON.stringify(err).slice(0, 120) : ""}`);
      // 编码自检（pitfalls 2026-10-04：OriginQuery 回显位≠查询词即编码事故，弃结果防垃圾入库）
      const echo = j.Result?.SearchContext?.OriginQuery;
      if (echo !== undefined && echo !== query) throw new Error(`ENCODING-MISMATCH echo=${JSON.stringify(echo).slice(0, 40)}`);
      return { rows: (j.Result && j.Result.WebResults) || [], attempts };
    } catch (e) {
      if (String(e.message).startsWith("AUTH-FAIL")) throw e;
      if (i === MAX_RETRY) return { rows: null, attempts, error: String(e.message).slice(0, 120) };
      await sleep(2000);
    }
  }
}

const normTitle = (t) => String(t || "").replace(/\s+/g, "").slice(0, 40);

// 垃圾形态闸（2026-10-05 补：诊断实锤 14/14 篇全是电商/黄页/官网页——通用 web 搜索的品牌词头部结果
// 天然偏这些页面，且其伪新鲜时间戳专穿时效窗）。域名黑名单 + 形态词 + 官网裸首页三道，命中即弃。
// 黑名单维护口径：实锤站必收（京东/途牛/顺企网/丽人服装网），另收头部电商、OTA、黄页大域兜底。
const BAD_HOST_SUFFIXES = [
  // 电商：商品/价格/品牌/店铺页无行业信息量
  "jd.com", "jd.hk", "3.cn", "tmall.com", "taobao.com", "tmall.hk", "1688.com",
  "alibaba.com", "aliexpress.com", "pinduoduo.com", "yangkeduo.com",
  "suning.com", "gome.com.cn", "vip.com", "vipshop.com",
  // 黄页 / B2B 名录：企业介绍/联系方式页
  "11467.com", "makepolo.com", "gongchang.com",
  // OTA / 到店：商场 shopping 页、景点页
  "tuniu.com", "ctrip.com", "qunar.com", "mafengwo.cn", "meituan.com", "dianping.com", "ly.com",
  // 招商加盟 / 软文站（实锤：丽人服装网加盟页）
  "ef43.com.cn",
];
// 形态词：标题/摘要命中即弃。SAFE 先剥除防误伤正经行业词（供应链动态/招商会/加盟展/加盟店开业）。
// 裸词只留正当行业新闻几乎不会出现的销售话术/站点套话。加盟/招商/价格/报价/供应/批发有正当行业
// 用法（白名单域「渠道与加盟」「上游价格」——如「加盟渠道下沉」「出厂报价上调」「招商银行」），
// 改共现词对判定：与转化/售卖词同现才判 junk，宁放勿杀，漏网交 prefilter ⑥ 页面形态兜底（ym357）。
const JUNK_SAFE_WORDS = ["供应链", "招商会", "加盟展", "加盟店"];
const JUNK_WORDS = [
  "多少钱", "求购", "价格表", "品牌介绍", "企业介绍", "公司简介", "官方网站", "联系我们",
  "旗舰店", "优惠券", "限时抢购",
];
const JUNK_PAIRS = [
  ["加盟", ["招商", "条件", "费用", "电话", "热线", "流程", "哪家", "排行", "总部", "金额", "保证金"]],
  ["招商", ["加盟", "代理", "电话", "热线", "诚邀", "手册"]],
  ["价格", ["咨询", "最低", "优惠"]],
  ["报价", ["厂家", "咨询", "电话", "今日", "批发"]],
  ["供应", ["求购", "批发", "厂家", "公司", "信息"]],
  ["批发", ["供应", "厂家", "公司", "价格", "零售"]],
];
function junkReasonOf(r) {
  try {
    const u = new URL(String(r.Url || ""));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname === "/" && !u.search && !u.hash) return "homepage";
    if (BAD_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) return "bad-host";
  } catch {
    return null; // URL 解析不了交给后续护栏，不在这里丢弃
  }
  let text = `${r.Title || ""} ${String(r.Snippet || "").slice(0, 200)}`;
  for (const w of JUNK_SAFE_WORDS) text = text.split(w).join("");
  if (JUNK_WORDS.some((w) => text.includes(w))) return "junk-word";
  return JUNK_PAIRS.some(([a, bs]) => text.includes(a) && bs.some((b) => text.includes(b))) ? "junk-pair" : null;
}

// 护栏（纯函数，seen 走 overlay 由调用方决定落盘时机）
function guardRows(rows, overlay, { freshness }) {
  const byTitle = new Map();
  const kept = [];
  const blocked = [];
  const stats = { l4: 0, junk: 0, junkPair: 0, stale: 0, dupTitle: 0, seen: 0 };
  for (const r of rows) {
    if (r.AuthInfoLevel === 4) { stats.l4++; continue; }
    const junk = junkReasonOf(r);
    if (junk) {
      stats.junk++;
      if (junk === "junk-pair") stats.junkPair++;
      blocked.push({ reason: junk, title: String(r.Title || "").slice(0, 40) });
      continue;
    }
    const ts = r.PublishTime ? Date.parse(r.PublishTime) : NaN;
    if (freshness && (!Number.isFinite(ts) || Date.now() - ts > FRESH_MS)) { stats.stale++; continue; }
    const url = String(r.Url || "");
    if (!url || !r.Title) { stats.stale++; continue; }
    const key = normTitle(r.Title);
    if (key && byTitle.has(key)) { stats.dupTitle++; continue; }
    if (overlay.ids.has(r.Id) || overlay.urls.has(url)) { stats.seen++; continue; }
    byTitle.set(key, true);
    overlay.ids.add(r.Id);
    overlay.urls.add(url);
    kept.push(r);
  }
  return { kept, blocked, stats };
}

const toItem = (r, q) => ({
  title: r.Title,
  url: r.Url,
  publishedAt: r.PublishTime || null,
  author: r.SiteName || "",
  raw: { doubao: { id: r.Id, auth_level: r.AuthInfoLevel, site: r.SiteName, query: q, snippet: String(r.Snippet || "").slice(0, 200) } },
});

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const quota = loadQuota();
  // 三层熔断（先行判定，未外调即退）
  if (quota.used >= HARD_STOP) {
    if (!forceOverride) { log(`QUOTA-HARD-STOP used=${quota.used}>=${HARD_STOP}（--force-override 可越过并须记因）`); return 0; }
    log(`QUOTA-FORCE-OVERRIDE used=${quota.used}（越过全停线，原因须自查登记）`);
  }
  if (quota.used >= DAILY_STOP && purpose === "daily" && !forceOverride) {
    log(`QUOTA-BREAK-DAILY used=${quota.used}>=${DAILY_STOP} 常态采集熔断（manual 通道可用至 ${HARD_STOP}）`);
    return 0;
  }

  const apiKey = readEnv("DOUBAO_SEARCH_API_KEY");
  const token = readEnv("INGEST_TOKEN");
  const queries = loadQueries();
  const words = manualQuery ? [manualQuery] : pickDailyWords(queries, round).slice(0, maxWords);

  log(`PATROL-START round=${round} purpose=${purpose} dry=${dryRun} words=${words.length} used=${quota.used}/${MONTHLY_CAP}`);
  const base = loadSeen();
  const overlay = { ids: new Set(base.ids), urls: new Set(base.urls) };
  const keptAll = [];

  try {
    for (const w of words) {
      const r = await searchWord(apiKey, w);
      bumpQuota(quota, purpose, 1); // 主请求计数（保守：发出即计）
      if (r.attempts > 1) bumpQuota(quota, "retry", r.attempts - 1);
      if (!r.rows) { log(`WORD-FAIL ${w} ${r.error || ""}`); continue; }
      const g = guardRows(r.rows, overlay, { freshness: purpose === "daily" });
      log(`WORD ${w} 扫描=${r.rows.length} 护栏后=${g.kept.length}（L4:${g.stats.l4} 形态:${g.stats.junk} 对:${g.stats.junkPair} 旧:${g.stats.stale} 通稿:${g.stats.dupTitle} seen:${g.stats.seen}）`);
      if (dryRun) for (const b of g.blocked.slice(0, 5)) log(`  BLOCKED[${b.reason}] ${b.title}`);
      keptAll.push(...g.kept.map((row) => ({ row, q: w })));
      await sleep(2000);
    }

    if (dryRun) {
      log(`DRY-RUN 未推 ingest、未落 seen；quota used=${quota.used}/${MONTHLY_CAP} purposes=${JSON.stringify(quota.purposes)}`);
      return 0;
    }

    if (keptAll.length) {
      const items = keptAll.map(({ row, q }) => toItem(row, q));
      for (let i = 0; i < items.length; i += 50) {
        const res = await fetch(INGEST_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: "doubao-search", sourceName: "豆包搜索·全网发现", items: items.slice(i, i + 50) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const j = await res.json().catch(() => ({}));
        log(`INGEST batch${i / 50 + 1} http=${res.status} created=${j.created ?? "?"}${res.ok ? "" : " err=" + JSON.stringify(j).slice(0, 120)}`);
        if (!res.ok) throw new Error("INGEST-FAIL");
      }
    } else {
      log("INGEST-SKIP 无新条目");
    }

    saveSeen(overlay); // ingest 成功后才落 seen（失败下轮重扫，ingest URL 判重兜底）
  } finally {
    // ISS-1 销项（shoumen P2）：FATAL 路径（AUTH-FAIL/INGEST-FAIL throw）也保账——
    // 已烧掉的请求计数必须落盘，否则熔断保证在故障态失效、月度对账背漂移
    saveQuota(quota);
  }
  log(`PATROL-END used=${quota.used}/${MONTHLY_CAP}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { log("FATAL " + String(e).slice(0, 200)); process.exit(1); });
