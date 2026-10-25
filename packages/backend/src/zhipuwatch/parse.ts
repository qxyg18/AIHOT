// 智谱关注信源解析纯函数（页面结构 2026-10-08 实拉核证，见 artifacts/2026-10-08/ym437-zhipu-watch/
// source-snapshots/）。条目 = {key, hash, title, publishedAt, body}：key 是稳定身份（标题/模型名），
// 条目内容改了 key 不变、hash 变 → 出「更新」条目；解析不出即抛错（scan 层停该页记错误，
// 禁猜测解析）。
import { createHash } from "node:crypto";
import { beijingAt, beijingIsoSeconds } from "@aihot/contracts/time";

export interface ParsedItem {
  key: string;
  hash: string;
  title: string;
  publishedAt: string | null;
  body: string;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const BODY_CAP = 1200;

/** 去 Markdown 语法噪声（引用行/链接/加粗），保留事实文本与表格。 */
export function mdPlain(text: string): string {
  return text
    .split("\n")
    .filter((ln) => !ln.trimStart().startsWith(">"))
    .join("\n")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "2026-8-19" / "2026-08-26" → "2026-08-19T00:00:00+08:00"；解析不出返回 null。 */
export function normalizeDate(label: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(label.trim());
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return beijingIsoSeconds(beijingAt(`${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, "00:00"));
}

/** 页面首个 # 标题（sitemap 新页解析亦用）。 */
export function pageTitle(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? collapse(m[1]!) : null;
}

/** 模型与产品发布记录：<Update label="日期" description="标题"> 块（页面已倒序）。 */
export function parseNewReleases(md: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const re = /<Update\s+label="([^"]*)"\s+description="([^"]*)"\s*>([\s\S]*?)<\/Update>/g;
  for (const m of md.matchAll(re)) {
    const title = collapse(m[2]!);
    if (!title) continue;
    const body = mdPlain(m[3]!).slice(0, BODY_CAP);
    items.push({ key: title, hash: sha(body || title), title, publishedAt: normalizeDate(m[1]!), body });
  }
  if (items.length === 0) throw new Error("new-releases 页面结构不匹配：0 个 <Update> 块");
  return items;
}

/** 上新活动：## 段（每段一段活动）。 */
export function parsePromotion(md: string): ParsedItem[] {
  const heads = [...md.matchAll(/^##\s+(.+)$/gm)];
  if (heads.length === 0) throw new Error("promotion 页面结构不匹配：0 个 ## 段");
  return heads.map((h, i) => {
    const start = h.index! + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : md.length;
    const title = collapse(mdPlain(h[1]!));
    const body = mdPlain(md.slice(start, end)).slice(0, BODY_CAP);
    return { key: title, hash: sha(body || title), title, publishedAt: null, body };
  });
}

/** API 定价：表格里输入/输出单价列为「免费」的行（免费模型标注行）。「限时免费」是缓存列噪声，精确匹配排除。 */
export function parsePricingFreeRows(md: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const line of md.split("\n")) {
    const raw = line.trim();
    if (!raw.startsWith("|")) continue;
    const cells = raw.split("|").map((c) => c.trim());
    // cells[0]=''（行首竖线）；[1]=模型名；[2]=上下文/类型；[3]=输入单价；[4]=输出单价
    if (cells.length < 6) continue;
    const model = collapse(cells[1]!);
    if (!model || /^[-\s:]*$/.test(model)) continue; // 表头分隔行
    const inPrice = cells[3]!;
    const outPrice = cells[4]!;
    if (inPrice !== "免费" && outPrice !== "免费") continue;
    const title = `${model}：输入 ${inPrice} / 输出 ${outPrice}`;
    items.push({ key: `${model}|${cells[2] ?? ""}`, hash: sha(raw), title, publishedAt: null, body: `定价表行：${raw}` });
  }
  if (items.length === 0) throw new Error("pricing 页面结构不匹配：0 行免费模型标注");
  return items;
}

/** 单一公告页（夜间畅用/套餐改版等）：整页一个版本条目，改版=新指纹。 */
export function parsePageVersion(md: string): ParsedItem[] {
  const title = pageTitle(md);
  if (!title) throw new Error("公告页结构不匹配：无 # 标题");
  const body = mdPlain(md).slice(0, 2000);
  return [{ key: "page", hash: sha(body), title, publishedAt: null, body }];
}

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

/** sitemap.xml：(loc, lastmod) 全量抽取。 */
export function parseSitemap(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const re = /<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g;
  for (const m of xml.matchAll(re)) out.push({ url: m[1]!.trim(), lastmod: m[2]?.trim() ?? null });
  if (out.length === 0) throw new Error("sitemap 结构不匹配：0 个 <loc>");
  return out;
}
