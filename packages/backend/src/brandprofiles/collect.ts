// Encyclopedia collection for brand profiles (zw14). Two live sources plus the human seed:
//   wiki  — zh.wikipedia.org first, en.wikipedia.org for brands whose English name is the lemma
//           (both through the official MediaWiki API, which answers plain extracts)
//   baike — baike.baidu.com lemma page, best-effort: this host serves an anti-bot wall to
//           datacentre/no-cookie clients, so a miss is recorded and skipped, never an error.
// Whatever was collected is concatenated into source_text with source labels; the human seed row
// (provider/listed/category/stores from lb-brands) is always appended because it is reviewed data.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { BRANDS_FILE } from "../leaderboard/directory.ts";
import { shutdownSignal } from "../jobs/queue.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 12_000;
/** Politeness gap between encyclopedia requests. */
const GAP_MS = 500;

export interface BrandSeed {
  slug: string;
  name: string;
  provider: string | null;
  listed: string | null;
  category: string | null;
  stores: number | null;
  keywords: string[];
}

export interface CollectedProfile {
  slug: string;
  name: string;
  wikiUrl: string | null;
  baikeUrl: string | null;
  evidence: string;
  sourceText: string;
  sourceHash: string;
}

/** The brand list SSOT: database/seeds/lb-brands-2026-10.json. */
export function readBrandSeeds(): BrandSeed[] {
  const dir = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: Array<Record<string, unknown>> };
  return dir.brands.map((b) => ({
    slug: String(b.slug),
    name: String(b.name),
    provider: typeof b.provider === "string" ? b.provider : null,
    listed: typeof b.listed === "string" ? b.listed : null,
    category: typeof b.category === "string" ? b.category : null,
    stores: typeof b.stores === "number" ? b.stores : null,
    keywords: Array.isArray(b.keywords) ? b.keywords.map(String) : [],
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function politeFetch(url: string): Promise<Response | null> {
  if (shutdownSignal.signal.aborted) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), shutdownSignal.signal]),
      headers: { "User-Agent": UA, Accept: "application/json, text/html" },
    });
    return res.ok ? res : null;
  } catch {
    return null; // network error, timeout or host blocked: recorded as "not collected"
  }
}

interface WikiHit {
  url: string;
  extract: string;
}

/** The handful of traditional characters brand and company names actually use; zh wiki titles
 *  are traditional (森馬/安踏體育) while the seeds are simplified. */
const ZH_MAP: Record<string, string> = { 體: "体", 馬: "马", 飾: "饰", 裝: "装", 團: "团", 時: "时", 貝: "贝", 納: "纳", 亞: "亚", 倫: "伦", 麗: "丽", 寶: "宝", 愛: "爱", 羅: "罗", 爾: "尔", 絲: "丝", 維: "维", 約: "约", 尼: "尼", 頓: "顿", 兒: "儿", 學: "学", 華: "华", 龍: "龙", 鳳: "凤", 鳥: "鸟", 鵬: "鹏" };
const normalizeZh = (s: string) => s.replace(/./g, (c) => ZH_MAP[c] ?? c);

/** Search the wiki for the name, then read the intro extract of the best title. A hit counts
 *  only when the search term appears whole in the title or the snippet (after traditional→
 *  simplified normalisation): 巴拉巴拉 once surfaced a basketball player, whose snippet only
 *  ever contains fragments of the name. */
async function wikiLookup(host: string, term: string): Promise<WikiHit | null> {
  const search = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=3&format=json`;
  const res = await politeFetch(search);
  if (!res) return null;
  const hits = (await res.json().catch(() => null)) as { query?: { search?: Array<{ title: string; snippet?: string }> } } | null;
  const list = hits?.query?.search ?? [];
  const nTerm = normalizeZh(term);
  const strip = (s: string) => s.replace(/<[^>]+>/g, "");
  const title = list.find((h) => normalizeZh(h.title).includes(nTerm) || strip(normalizeZh(h.snippet ?? "")).includes(nTerm))?.title;
  if (!title) return null;
  await sleep(GAP_MS);
  const extract = `https://${host}/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const page = await politeFetch(extract);
  if (!page) return null;
  const data = (await page.json().catch(() => null)) as { query?: { pages?: Record<string, { extract?: string; title?: string }> } } | null;
  const first = data ? Object.values(data.query?.pages ?? {})[0] : undefined;
  const text = first?.extract?.trim();
  if (!first || !text) return null;
  const finalTitle = first.title ?? title;
  return { url: `https://${host}/wiki/${encodeURIComponent(finalTitle)}`, extract: text.slice(0, 2400) };
}

/** The lemma page's meta description carries the lead paragraph without the anti-bot wall's markup. */
async function baikeLookup(name: string): Promise<string | null> {
  const res = await politeFetch(`https://baike.baidu.com/item/${encodeURIComponent(name)}`);
  if (!res) return null;
  const html = await res.text().catch(() => null);
  if (!html) return null;
  const $ = cheerio.load(html);
  const description = $('meta[name="description"]').attr("content")?.trim();
  return description && description.length >= 20 ? description.slice(0, 1200) : null;
}

/** Collect one brand: zh wiki → en wiki (by English keyword) → baike, then append the seed facts. */
export async function collectBrand(seed: BrandSeed): Promise<CollectedProfile> {
  const parts: Array<{ source: string; text: string }> = [];
  let wikiUrl: string | null = null;
  let baikeUrl: string | null = null;

  let wiki = await wikiLookup("zh.wikipedia.org", seed.name);
  if (!wiki) {
    // Brands whose lemma is the English name (Mini Peace, PAW IN PAW…) may only exist on en wiki.
    const english = seed.keywords.find((k) => /^[A-Za-z][A-Za-z .&'-]{2,}$/.test(k));
    if (english) wiki = await wikiLookup("en.wikipedia.org", english);
  }
  if (wiki) {
    parts.push({ source: "wiki", text: wiki.extract });
    wikiUrl = wiki.url;
  }
  await sleep(GAP_MS);

  const baikeText = await baikeLookup(seed.name);
  if (baikeText) {
    parts.push({ source: "baike", text: baikeText });
    baikeUrl = `https://baike.baidu.com/item/${encodeURIComponent(seed.name)}`;
  }

  const seedFacts = [
    `品牌名：${seed.name}`,
    seed.provider && `母公司/提供方：${seed.provider}`,
    seed.listed && `上市状态：${seed.listed}`,
    seed.category && `主营品类：${seed.category}`,
    seed.stores && `门店数概数：约${seed.stores}家`,
  ].filter(Boolean).join("；");
  parts.push({ source: "seed", text: seedFacts });

  const evidence = parts.map((p) => p.source).join("+");
  const sourceText = parts.map((p) => `[${p.source}] ${p.text}`).join("\n");
  return {
    slug: seed.slug,
    name: seed.name,
    wikiUrl,
    baikeUrl,
    evidence,
    sourceText,
    sourceHash: createHash("sha256").update(sourceText).digest("hex"),
  };
}
