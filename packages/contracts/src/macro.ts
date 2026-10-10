// 宏观市场的共享读取 DTO（TZR-20261003 T01/ym239 冻结；正本原在 @aihot/backend/macro/read）。
// 网页（apps/web）与 API/后端共用本契约：web 包不 import backend，此前在 routes/macro.tsx
// 内联复制过一份（"Mirrors @aihot/backend/macro/read"），T14 起统一消费本文件。
// 数值都来自已播种的官方序列（scripts/seed-macro.ts），本层只分组排序，绝不计算新数字。

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