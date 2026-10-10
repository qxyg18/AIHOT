// Same-origin official candidate discovery (TZR-20261003 T05): from an approved official root, find
// free entry points — rel=alternate feeds, robots-declared sitemaps (as section leads; lastmod is a
// discovery lead only and is NEVER a publication date), same-origin news/press sections and explicit
// JSON endpoints. Every URL must stay inside the root's approved origins; discovery only persists
// through upsertCandidate (idempotent, tombstones untouched) and never probes or writes business tables.
import * as cheerio from "cheerio";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { checkRobots } from "./robots.ts";
import { endpointIdentityOf, upsertCandidate, type CandidateKind, type OfficialRootRow } from "./store.ts";

export interface DiscoveredEndpoint {
  url: string;
  kind: CandidateKind;
  discoveredVia: string;
  /** Optional lead note (e.g. sitemap lastmod) — documentation only, never a publication date. */
  note?: string;
}

const NEWS_HINT = /(news|newsroom|press|media|公告|新闻)/i;

function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function bounds(root: OfficialRootRow): (url: string) => boolean {
  const origins = new Set<string>([new URL(root.rootUrl).origin.toLowerCase()]);
  for (const o of root.approvedOrigins) origins.add(o.toLowerCase());
  return (url) => {
    try {
      return origins.has(new URL(url).origin.toLowerCase());
    } catch {
      return false;
    }
  };
}

/** sitemap <url> entries clustered by leading path segment(s) (depth ≤ 2); a section with at least
 *  `minUrls` pages becomes one web_list candidate — the sitemap itself is never a candidate. */
function sectionsFromSitemap(xml: string, inBounds: (u: string) => boolean): Map<string, { count: number; lastmod: string | null }> {
  const counts = new Map<string, { count: number; lastmod: string | null }>();
  const $ = cheerio.load(xml, { xmlMode: true });
  $("urlset > url").each((_, el) => {
    const loc = $(el).children("loc").first().text().trim();
    const lastmod = $(el).children("lastmod").first().text().trim() || null;
    const u = abs(loc, "https://example.invalid");
    if (!u || !inBounds(u)) return;
    const seg = new URL(u).pathname.split("/").filter(Boolean);
    if (seg.length === 0) return;
    const depth = Math.min(2, seg.length - 1);
    const key = new URL(u).origin + "/" + seg.slice(0, Math.max(1, depth)).join("/");
    const prev = counts.get(key) ?? { count: 0, lastmod: null };
    counts.set(key, { count: prev.count + 1, lastmod: prev.lastmod ?? lastmod });
  });
  return counts;
}

export async function discoverOfficialCandidates(
  root: OfficialRootRow,
  opts: { maxEndpoints?: number } = {},
): Promise<DiscoveredEndpoint[]> {
  const max = opts.maxEndpoints ?? 10;
  const inBounds = bounds(root);
  const found = new Map<string, DiscoveredEndpoint>();
  const add = (url: string, kind: CandidateKind, discoveredVia: string, note?: string) => {
    const id = endpointIdentityOf(url);
    if (found.size < max && !found.has(id)) found.set(id, { url, kind, discoveredVia, note });
  };

  let html: string | null = null;
  try {
    const res = await guardedFetch(root.rootUrl, { timeoutMs: 25_000 });
    if (res.status === 200 && /html|xml|text/.test(res.headers.get("content-type") ?? "")) html = res.text();
  } catch {
    // The root being down is health evidence for the probe stage; discovery just finds nothing here.
  }

  if (html) {
    const $ = cheerio.load(html);
    $("link[rel~='alternate']").each((_, el) => {
      const type = ($(el).attr("type") ?? "").toLowerCase();
      const href = abs($(el).attr("href"), root.rootUrl);
      if (!href || !inBounds(href)) return;
      if (type.includes("rss") || type.includes("atom")) add(href, "rss", "html:rel-alternate");
      else if (type.includes("json")) add(href, "json_list", "html:json-endpoint");
    });
    const rootPath = new URL(root.rootUrl).pathname.replace(/\/+$/, "");
    $("a[href]").each((_, el) => {
      if (found.size >= max) return;
      const href = abs($(el).attr("href"), root.rootUrl);
      if (!href || !inBounds(href)) return;
      const u = new URL(href);
      const path = u.pathname.replace(/\/+$/, "");
      if (path === rootPath) return;
      const label = `${$(el).text() ?? ""} ${u.pathname}`;
      if (/\.json$/i.test(u.pathname)) add(href, "json_list", "html:json-endpoint");
      else if (NEWS_HINT.test(label)) add(href, "web_list", "html:same-origin-news-link");
    });
  }

  // robots-declared sitemaps → section leads. lastmod is recorded as a note (a discovery lead),
  // never mapped to any publication date (card: "lastmod is not the publication date").
  const robots = await checkRobots(root.rootUrl);
  for (const sm of robots.sitemaps.slice(0, 4)) {
    if (!inBounds(sm) || found.size >= max) continue;
    try {
      const res = await guardedFetch(sm, { timeoutMs: 25_000, maxBytes: 2 * 1024 * 1024 });
      if (res.status !== 200) continue;
      for (const [section, { count, lastmod }] of sectionsFromSitemap(res.text(), inBounds)) {
        if (found.size >= max) break;
        if (count < 2) continue; // single pages are not sections
        add(
          section,
          "web_list",
          "sitemap:section",
          `pages=${count}${lastmod ? `; sitemap lastmod=${lastmod} (discovery lead only, not a publication date)` : ""}`,
        );
      }
    } catch {
      // An unreachable sitemap yields no sections; nothing to park here (discovery is read-only).
    }
  }

  for (const ep of found.values()) {
    await upsertCandidate({
      endpointIdentity: endpointIdentityOf(ep.url),
      url: ep.url,
      kind: ep.kind,
      rootId: root.id,
      discoveredVia: ep.discoveredVia,
    });
  }
  return [...found.values()];
}
