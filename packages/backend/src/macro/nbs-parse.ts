// Parsers for the National Bureau of Statistics' monthly retail release (ym770,
// d-radar-macro-monthly-auto = opt-auto). Pure functions over captured HTML: the fetch and the
// write live in nbs.ts, so every page shape is testable without network or a database.
//
// Two shapes matter. An ordinary month page carries a YTD sentence and a current-month sentence
// ("1—9月份…；9月份…") plus the limited-size retail table. The January–February release merges the
// two months: its title is "1—2月份" and there is no standalone February figure, so the combined
// number is the period row (seq 1, label "1–2月"), the same convention the hand seeds use.
import * as cheerio from "cheerio";

export interface Figures {
  value: number;
  yoy: number;
}

export interface NbsRetailRelease {
  year: number;
  /** Last month the release covers: 9 for "1—9月份", 2 for the merged "1—2月份". */
  month: number;
  /** Row anchor in macro_observations: month, except the merged January–February row = 1. */
  seq: number;
  /** Axis label exactly as the page shows it: "9月" / "1–2月". */
  label: string;
  /** Current-month retail (or the combined January–February figure); null only when the page has no standalone month. */
  retail: Figures;
  retailYtd: Figures;
  /** Limited-size retail of clothing, shoes, hats, knitwear and textiles; null when the table row is absent. */
  apparel: Figures | null;
  apparelYtd: Figures | null;
  /** Publication date as yyyy-mm-dd, when the page states one. */
  publishedAt: string | null;
  sourceUrl: string;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const APPAREL_ROW = "服装、鞋帽、针纺织品类";

const squash = (text: string) => text.replace(/\s+/g, "");
const toNum = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** "9月" for a normal month; the merged January–February release keeps the seed's "1–2月" label. */
export function periodFor(month: number): { seq: number; label: string } {
  return month === 2 ? { seq: 1, label: "1–2月" } : { seq: month, label: `${month}月` };
}

export function parseRetailRelease(html: string, sourceUrl: string): NbsRetailRelease {
  const $ = cheerio.load(html);
  $("script, style").remove();
  // The release year lives in the page title as well as in the body headline; read the whole
  // document so a page whose headline markup differs still parses.
  const text = squash($.root().text());

  const ytd = text.match(new RegExp(`1[—–-](\\d{1,2})月份，社会消费品零售总额${NUM}亿元，同比增长${NUM}%`));
  if (!ytd) throw new Error("statistics release: no year-to-date retail sentence");
  const year = Number(text.match(new RegExp(`(\\d{4})年1[—–-](\\d{1,2})月份社会消费品零售总额`))?.[1] ?? NaN);
  const month = Number(ytd[1]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("statistics release: no release year in the title");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`statistics release: bad month ${ytd[1]}`);
  const retailYtdValue = toNum(ytd[2]);
  const retailYtdYoy = toNum(ytd[3]);
  if (retailYtdValue === null || retailYtdYoy === null) throw new Error("statistics release: unreadable year-to-date retail numbers");

  // The merged January–February page has no standalone month sentence; the combined figure is the row.
  let retail: Figures = { value: retailYtdValue, yoy: retailYtdYoy };
  if (month !== 2) {
    const monthLine = text.match(new RegExp(`(?<![—–\\d])${month}月份，社会消费品零售总额${NUM}亿元，同比增长${NUM}%`));
    const value = toNum(monthLine?.[1]);
    const yoy = toNum(monthLine?.[2]);
    if (value === null || yoy === null) throw new Error(`statistics release: no current-month retail sentence for month ${month}`);
    retail = { value, yoy };
  }

  // The table row carries current-month value/yoy then year-to-date value/yoy, in that order.
  let apparel: Figures | null = null;
  let apparelYtd: Figures | null = null;
  $("table tr").each((_i, row) => {
    const cells = $(row).find("td").map((_j, cell) => squash($(cell).text())).get();
    if (cells.length < 5 || !cells[0]!.includes(APPAREL_ROW)) return;
    const value = toNum(cells[1]);
    const yoy = toNum(cells[2]);
    const ytdValue = toNum(cells[3]);
    const ytdYoy = toNum(cells[4]);
    if (value !== null && yoy !== null) apparel = { value, yoy };
    if (ytdValue !== null && ytdYoy !== null) apparelYtd = { value: ytdValue, yoy: ytdYoy };
    return false;
  });

  const published = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const publishedAt = published
    ? `${published[1]}-${published[2]!.padStart(2, "0")}-${published[3]!.padStart(2, "0")}`
    : null;

  return { year, month, ...periodFor(month), retail, retailYtd: { value: retailYtdValue, yoy: retailYtdYoy }, apparel, apparelYtd, publishedAt, sourceUrl };
}

export interface ReleaseLink {
  url: string;
  year: number;
  month: number;
}

const RELEASE_LINK = /^(\d{4})年1[—–-](\d{1,2})月份社会消费品零售总额增长/;

/** Newest retail release on a list page; the page repeats each link, so only the maximum matters. */
export function pickLatestRelease(html: string, baseUrl: string): ReleaseLink | null {
  const $ = cheerio.load(html);
  let best: ReleaseLink | null = null;
  $("a").each((_i, anchor) => {
    const title = squash($(anchor).text());
    const m = title.match(RELEASE_LINK);
    if (!m) return;
    const href = $(anchor).attr("href");
    if (!href) return;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return;
    const rank = year * 100 + month;
    const bestRank = best ? best.year * 100 + best.month : -1;
    if (rank <= bestRank) return;
    try {
      best = { url: new URL(href, baseUrl).toString(), year, month };
    } catch {
      // A malformed href is not a release: skip it rather than fail the whole scan.
    }
  });
  return best;
}
