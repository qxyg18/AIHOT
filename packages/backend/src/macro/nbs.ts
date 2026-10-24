// Monthly macro refresh from the National Bureau of Statistics (ym770, d-radar-macro-monthly-auto =
// opt-auto). The release page is the single source: it answers both the retail total and the
// limited-size clothing/knitwear line, at current-month and year-to-date granularity.
//
// Two properties keep the automatic chain safe to run daily:
//   * no partial writes — the release is parsed in full before the transaction opens, and every
//     write (two observation rows and the two indicator YTD fields) commits together;
//   * no regression — a page older than what the table already holds is refused, so a replay of an
//     old URL can never push the monthly board backwards.
// Failures throw; the worker records the run as failed and the previous values stay in place.
import { sql, type Db } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { parseRetailRelease, pickLatestRelease, type NbsRetailRelease, type ReleaseLink } from "./nbs-parse.ts";

const INDEX_URL = "https://www.stats.gov.cn/sj/zxfb/";
/** Monthly indicators this job owns; the annual/population series stay hand-seeded. */
const MONTHLY_KEYS = ["retail", "apparel"] as const;

export interface MacroRefreshResult {
  status: "written" | "unchanged" | "stale" | "dry-run";
  release: NbsRetailRelease;
  rowsWritten: number;
  indicatorsUpdated: number;
}

export async function fetchLatestRelease(): Promise<ReleaseLink> {
  const page = await guardedFetch(INDEX_URL, { route: "direct", timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  if (page.status !== 200) throw new Error(`statistics index: HTTP ${page.status}`);
  const link = pickLatestRelease(page.text(), INDEX_URL);
  if (!link) throw new Error("statistics index: no retail release link found");
  return link;
}

const rank = (year: number, seq: number) => year * 100 + seq;

async function currentMax(db: Db, key: string): Promise<number> {
  const [row] = await db<{ m: number | null }[]>`SELECT max(year * 100 + seq) AS m FROM macro_observations WHERE indicator_key = ${key}`;
  return row?.m ?? 0;
}

export async function refreshMacroFromNbs(opts: { dryRun?: boolean; pageUrl?: string } = {}): Promise<MacroRefreshResult> {
  const link = opts.pageUrl ? { url: opts.pageUrl, year: 0, month: 0 } : await fetchLatestRelease();
  const page = await guardedFetch(link.url, { route: "direct", timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  if (page.status !== 200) throw new Error(`statistics release: HTTP ${page.status} for ${link.url}`);
  const release = parseRetailRelease(page.text(), link.url);

  const note = `统计局${release.publishedAt ? ` ${release.publishedAt} ` : ""}发布（自动抓取）`;
  // A dry run is a pure parse check: it deliberately touches no database, so it also works from a
  // machine that cannot reach the live one.
  if (opts.dryRun) return { status: "dry-run", release, rowsWritten: 0, indicatorsUpdated: 0 };

  // Refuse to move backwards: the row identity is (indicator, year, seq), so the newest held row is
  // the yardstick. A same-month replay is allowed to refresh the numbers (revisions happen).
  const held = await Promise.all(MONTHLY_KEYS.map((key) => currentMax(sql, key)));
  if (rank(release.year, release.seq) < Math.max(...held)) {
    return { status: "stale", release, rowsWritten: 0, indicatorsUpdated: 0 };
  }

  const rows: Array<{ key: string; value: number; yoy: number }> = [];
  if (release.apparel) rows.push({ key: "apparel", ...release.apparel });
  rows.push({ key: "retail", ...release.retail });

  return sql.begin(async (tx) => {
    let rowsWritten = 0;
    let indicatorsUpdated = 0;
    for (const row of rows) {
      const [existing] = await tx<{ value: number; yoy: number | null; note: string | null }[]>`
        SELECT value, yoy, note FROM macro_observations
        WHERE indicator_key = ${row.key} AND year = ${release.year} AND seq = ${release.seq}`;
      if (existing && existing.value === row.value && existing.yoy === row.yoy && existing.note === note) continue;
      await tx`
        INSERT INTO macro_observations (indicator_key, period, seq, year, value, quality, yoy, note)
        VALUES (${row.key}, ${release.label}, ${release.seq}, ${release.year}, ${row.value}, 'published', ${row.yoy}, ${note})
        ON CONFLICT (indicator_key, year, seq) DO UPDATE SET
          period = EXCLUDED.period, value = EXCLUDED.value, quality = EXCLUDED.quality,
          yoy = EXCLUDED.yoy, note = EXCLUDED.note`;
      rowsWritten++;
    }

    const ytdFor: Array<{ key: string; ytd: { value: number; yoy: number } }> = [{ key: "retail", ytd: release.retailYtd }];
    if (release.apparelYtd) ytdFor.push({ key: "apparel", ytd: release.apparelYtd });
    for (const { key, ytd } of ytdFor) {
      const [updated] = await tx`
        UPDATE macro_indicators SET ytd_value = ${ytd.value}, ytd_yoy = ${ytd.yoy}, ytd_label = ${`1–${release.month}月累计`},
          source_urls = (SELECT array_agg(DISTINCT u) FROM unnest(source_urls || ${[release.sourceUrl]}::text[]) AS u),
          updated_at = now()
        WHERE key = ${key} AND (ytd_value IS DISTINCT FROM ${ytd.value} OR ytd_yoy IS DISTINCT FROM ${ytd.yoy} OR ytd_label IS DISTINCT FROM ${`1–${release.month}月累计`})
        RETURNING key`;
      if (updated) indicatorsUpdated++;
    }
    return { status: rowsWritten || indicatorsUpdated ? "written" : "unchanged", release, rowsWritten, indicatorsUpdated };
  });
}
