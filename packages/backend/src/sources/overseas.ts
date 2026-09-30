// Overseas-source tag guard for the hot list (ym16). The domestic-first rule (events/hot.ts)
// keys on the「海外」tag to discount foreign participants and to require domestic editorial for
// entry; a new overseas source saved without the tag would count as domestic at full weight and
// let foreign takeover of the hot list silently return. The admin create/edit surface therefore
// refuses the save until the tag is added (owner ruling 2026-09-30, option ① ingest-check).
// The lists below are the manifest: onboard newly added overseas outlets here (seeded with the
// four UK retail-press sources of 2026-09-30). Greater-China registries (.hk/.tw/.mo) are
// deliberately not auto-suspect — judge those by hand when onboarding.

/** Registrable domains of known overseas outlets (suffix match on the collected URL host). */
const OVERSEAS_DOMAINS = [
  "drapersonline.com", "theindustry.fashion", "retaildive.com", "retailgazette.co.uk",
  "bbc.co.uk", "bbc.com", "reuters.com", "theguardian.com", "dailymail.co.uk", "ft.com",
  "wsj.com", "nytimes.com", "bloomberg.com", "cnn.com", "economist.com", "apnews.com",
  "wwd.com", "businessoffashion.com", "fashionnetwork.com", "footwearnews.com",
];

/** Distinctive outlet-name tokens, matched case-insensitively (word-boundary for the short ones). */
const OVERSEAS_NAME_TOKENS = [
  "reuters", "bbc", "guardian", "daily mail", "dailymail", "financial times", "wall street journal",
  "new york times", "bloomberg", "retail dive", "retail gazette", "retaildive", "retailgazette",
  "business of fashion", "footwear news", "fashion network", "fashionnetwork", "ap news",
  "economist", "drapers", "theindustry.fashion", "wwd",
];

/** Country-code TLDs no mainland-China outlet registers under. */
const OVERSEAS_TLDS = [
  ".co.uk", ".org.uk", ".ac.uk", ".co.jp", ".or.jp", ".co.kr", ".or.kr",
  ".fr", ".de", ".ru", ".it", ".es", ".nl", ".com.au", ".co.nz", ".com.sg", ".com.my",
];

function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Why a source looks overseas, or null when nothing in the manifest matches its name or URL host. */
export function overseasSuspect(name: string, config: Record<string, unknown>): { reason: string } | null {
  const raw = String(config.feedUrl ?? config.url ?? config.listUrl ?? config.endpoint ?? "");
  let host = "";
  if (raw) {
    try {
      host = new URL(raw.replace(/^https:\/\/r\.jina\.ai\//, "")).hostname.toLowerCase();
    } catch {
      host = ""; // an unparseable address is nobody's evidence
    }
  }
  const domain = OVERSEAS_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
  if (domain) return { reason: `采集域名 ${host} 命中海外信源清单（${domain}）` };
  const tld = OVERSEAS_TLDS.find((t) => host.endsWith(t));
  if (tld) return { reason: `采集域名后缀 ${tld} 属海外注册地` };
  const lower = name.toLowerCase();
  const token = OVERSEAS_NAME_TOKENS.find((w) =>
    w.length > 4 || w.includes(" ") || w.includes(".")
      ? lower.includes(w)
      : new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower));
  if (token) return { reason: `名称命中海外媒体关键词「${token}」` };
  return null;
}

/** Thrown when a save would put an untagged suspect overseas source on the hot list (HTTP 400). */
export class OverseasTagRequired extends Error {
  readonly statusCode = 400;
  constructor(reason: string) {
    super(`疑似海外信源：${reason}。热点榜国内优先规则依赖「海外」标签折算其热度，请补「海外」标签后再保存；若确属国内信源，请核对名称与采集地址是否填写正确。`);
  }
}

/**
 * Refuses enabled participating (non-isolated) sources that look overseas but lack the「海外」tag.
 * Applied on the admin create/edit surface; ingest auto-created sources are isolated and only run
 * through here when an operator promotes them to participating via an edit.
 */
export function assertOverseasTagged(source: {
  name: string;
  config: Record<string, unknown>;
  tags: string[];
  participation_mode: string;
  enabled: boolean;
}): void {
  if (!source.enabled || source.participation_mode === "isolated") return;
  if (source.tags.includes("海外")) return;
  const suspect = overseasSuspect(source.name, source.config);
  if (suspect) throw new OverseasTagRequired(suspect.reason);
}
