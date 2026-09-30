// Macro market read layer (ka7): the /macro page reads every indicator through here.
// Rows are seeded facts (scripts/seed-macro.ts carries source + caliber per value);
// this layer only groups and orders them, it never computes new numbers.
import { sql } from "../db.ts";

export type MacroGranularity = "month" | "quarter" | "year" | "band";
export type MacroQuality = "published" | "derived" | "estimate";

export interface MacroRow {
  /** Axis label exactly as displayed: "1–2月", "Q3", "2025", "9岁", "17–21岁". */
  period: string;
  /** Sort anchor within the year: month number (1–2月 = 1), quarter 1–4, the year, band order. */
  seq: number;
  year: number;
  value: number;
  quality: MacroQuality;
  /** Same-period growth in percent where officially stated. */
  yoy: number | null;
  /** Per-value source or derivation note. */
  note: string | null;
}

export interface MacroIndicator {
  key: string;
  name: string;
  unit: string;
  granularity: MacroGranularity;
  caliber: string;
  sourceName: string;
  sourceUrls: string[];
  /** Official year-to-date for the corner pill: value, published yoy and its label (e.g. "1–8月累计"). */
  ytd: { value: number; yoy: number; label: string } | null;
  rows: MacroRow[];
}

export interface MacroOverview {
  indicators: Record<string, MacroIndicator>;
  generatedAt: string;
}

const GRANULARITIES = new Set(["month", "quarter", "year", "band"]);

export async function loadMacroOverview(): Promise<MacroOverview> {
  const [indicators, observations] = await Promise.all([
    sql`SELECT key, name, unit, granularity, caliber, source_name, source_urls, ytd_value, ytd_yoy, ytd_label, updated_at
        FROM macro_indicators ORDER BY sort_order`,
    sql`SELECT indicator_key, period, seq, year, value, quality, yoy, note
        FROM macro_observations ORDER BY indicator_key, year, seq`,
  ]);

  const out: Record<string, MacroIndicator> = {};
  for (const i of indicators) {
    const granularity = GRANULARITIES.has(String(i.granularity)) ? (i.granularity as MacroGranularity) : "month";
    out[i.key] = {
      key: i.key,
      name: i.name,
      unit: i.unit,
      granularity,
      caliber: i.caliber,
      sourceName: i.source_name,
      sourceUrls: i.source_urls ?? [],
      ytd: i.ytd_value === null || i.ytd_yoy === null ? null : { value: Number(i.ytd_value), yoy: Number(i.ytd_yoy), label: i.ytd_label ?? "" },
      rows: [],
    };
  }
  for (const o of observations) {
    const ind = out[o.indicator_key];
    if (!ind) continue;
    ind.rows.push({
      period: o.period,
      seq: o.seq,
      year: o.year,
      value: Number(o.value),
      quality: o.quality as MacroQuality,
      yoy: o.yoy === null ? null : Number(o.yoy),
      note: o.note,
    });
  }
  return { indicators: out, generatedAt: new Date().toISOString() };
}
