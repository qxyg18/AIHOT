// RFC 9309 robots.txt gate for the admission probe engine (TZR-20261003 T05): a bounded check with a
// per-origin cache. An unreachable or server-broken robots.txt parks (unknown) — it must neither
// promote nor permanently fail a candidate; a missing robots.txt (404/410) allows crawling per the
// RFC. A pass here is never rights evidence: the probe keeps the robots and rights checks apart.
import { guardedFetch } from "../../lib/http-fetch.ts";
import { SITE } from "@aihot/industry/site";

export type RobotsVerdict = "pass" | "fail" | "unknown";

export interface RobotsCheck {
  verdict: RobotsVerdict;
  reason: string;
  origin: string;
  fetchedAt: string;
  /** Sitemap lines the robots.txt declared, for the discovery stage; empty unless the fetch parsed. */
  sitemaps: string[];
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 256 * 1024; // RFC 9309 §2.5 leaves oversized robots.txt at the crawler's discretion; we read a bounded prefix.
const MAX_LINES = 2000;

const cache = new Map<string, RobotsCheck>();

export function resetRobotsCache(): void {
  cache.clear();
}

interface Rule {
  allow: boolean;
  path: string;
}

/** Bounded RFC 9309 subset parse: per-agent Allow/Disallow groups (consecutive user-agent lines share
 *  one rule list, per §2.3.1.2) plus global Sitemap lines. */
function parseRobots(text: string): { groups: Map<string, Rule[]>; sitemaps: string[] } {
  const groups = new Map<string, Rule[]>();
  const sitemaps: string[] = [];
  let names: string[] = [];
  let rules: Rule[] = [];
  let inGroup = false;
  const flush = () => {
    for (const n of names) groups.set(n, rules);
    names = [];
    rules = [];
  };
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (inGroup && names.length > 0 && rules.length > 0) flush(); // a rule line closed the agent block
      names.push(value.toLowerCase());
      continue;
    }
    if (names.length === 0) continue; // lines before any user-agent are ignored per the RFC
    inGroup = true;
    if (field === "allow") rules.push({ allow: true, path: value });
    else if (field === "disallow" && value !== "") rules.push({ allow: false, path: value });
    else if (field === "disallow") rules.push({ allow: true, path: "" }); // "Disallow:" empty = allow everything
    else if (field === "sitemap" && /^https?:\/\//i.test(value) && !sitemaps.includes(value)) sitemaps.push(value);
  }
  flush();
  return { groups, sitemaps };
}

/** Longest-match wins, as in RFC 9309 §2.2.2; among equal lengths Allow beats Disallow. */
function ruleApplies(rules: Rule[], pathname: string): RobotsVerdict {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!pathname.startsWith(r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  if (!best) return "pass";
  return best.allow ? "pass" : "fail";
}

export async function checkRobots(target: string, opts: { now?: Date } = {}): Promise<RobotsCheck> {
  const now = opts.now ?? new Date();
  const origin = new URL(target).origin;
  const hit = cache.get(origin);
  if (hit && now.getTime() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return hit;

  let out: RobotsCheck;
  try {
    const res = await guardedFetch(`${origin}/robots.txt`, { timeoutMs: 15_000, maxBytes: MAX_BYTES });
    if (res.status === 404 || res.status === 410) {
      out = { verdict: "pass", reason: `no robots.txt (HTTP ${res.status}) — allowed by RFC 9309 §4`, origin, fetchedAt: now.toISOString(), sitemaps: [] };
    } else if (res.status === 200) {
      const { groups, sitemaps } = parseRobots(res.text());
      const ua = (SITE.crawlerName ?? "").toLowerCase();
      const rules = groups.get(ua) ?? groups.get("*");
      const verdict = rules ? ruleApplies(rules, new URL(target).pathname) : "pass";
      out = {
        verdict,
        reason: verdict === "pass" ? (rules ? "allowed by matching group rules" : "no applicable group") : "disallowed by matching group rules",
        origin, fetchedAt: now.toISOString(), sitemaps,
      };
    } else if (res.status >= 500) {
      out = { verdict: "unknown", reason: `robots.txt HTTP ${res.status} — park, neither promote nor fail`, origin, fetchedAt: now.toISOString(), sitemaps: [] };
    } else {
      out = { verdict: "unknown", reason: `robots.txt unexpected HTTP ${res.status} — park`, origin, fetchedAt: now.toISOString(), sitemaps: [] };
    }
  } catch (e) {
    out = { verdict: "unknown", reason: `robots.txt unreachable: ${String(e).slice(0, 160)} — park`, origin, fetchedAt: now.toISOString(), sitemaps: [] };
  }
  cache.set(origin, out);
  return out;
}
