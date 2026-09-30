// Seeds the 宏观市场 board (ka7): macro_indicators + macro_observations.
// Every value below was collected by hand from the listed official sources on 2026-09-30.
// quality: published = official number as published; derived = computed from two official
// numbers (prior-year month = current value / (1 + published yoy), cross-checked: the method
// reproduced the official 2025-05 value to 0.03% and the official 1–8月 YTD yoy to 0.1pct).
// Re-runnable upsert: node --env-file=.env scripts/seed-macro.ts
import { closeDb, sql } from "@aihot/backend/db";

type Quality = "published" | "derived" | "estimate";
interface Row { seq: number; period: string; year: number; value: number; yoy: number | null; quality: Quality; note: string }
interface Indicator {
  key: string; name: string; unit: string; granularity: "month" | "quarter" | "year" | "band";
  caliber: string; sourceName: string; sourceUrls: string[]; sortOrder: number;
  ytdValue?: number; ytdYoy?: number; ytdLabel?: string;
  rows: Row[];
}

const STATS_2026_08 = "https://www.stats.gov.cn/sj/zxfb/202609/t20260915_1965311.html";
const STATS_2025_10 = "https://www.stats.gov.cn/sj/zxfb/202511/t20251114_1961852.html";
const STATS_2025_09 = "https://www.stats.gov.cn/sj/zxfb/202510/t20251020_1961606.html";
const STATS_2025_BULLETIN = "https://www.stats.gov.cn/sj/zxfbhjd/202602/t20260228_1962662.html";

// ── 社会消费品零售总额（亿元，当月值，1–2月合并）────────────────────────────────────────
const retail: Indicator = {
  key: "retail", name: "社会消费品零售总额", unit: "亿元", granularity: "month",
  caliber: "当月值，1–2月合并；2025年1–2/3/4/8月为官方数对反推（值÷(1+官方同比)）",
  sourceName: "国家统计局月度发布", sourceUrls: [STATS_2026_08, STATS_2025_09, STATS_2025_10], sortOrder: 1,
  ytdValue: 327569, ytdYoy: 1.1, ytdLabel: "1–8月累计",
  rows: [
    // 2026（已发布月，全部为官方发布值）
    { seq: 1, period: "1–2月", year: 2026, value: 86079, yoy: 2.8, quality: "published", note: "统计局2026-03-16发布（央视网转载）" },
    { seq: 3, period: "3月", year: 2026, value: 41616, yoy: 1.7, quality: "published", note: "统计局2026-04-16发布（新浪财经转载）" },
    { seq: 4, period: "4月", year: 2026, value: 37247, yoy: 0.2, quality: "published", note: "统计局2026-05-18发布（央视网转载）" },
    { seq: 5, period: "5月", year: 2026, value: 41090, yoy: -0.6, quality: "published", note: "统计局2026-06-16发布" },
    { seq: 6, period: "6月", year: 2026, value: 42691, yoy: 1.0, quality: "published", note: "国新办2026年上半年发布会；同比按官方6月值/2025年6月值计" },
    { seq: 7, period: "7月", year: 2026, value: 39022, yoy: 0.6, quality: "published", note: "统计局2026-08-18发布（网易转载）；同比按7月值/2025年7月值计" },
    { seq: 8, period: "8月", year: 2026, value: 39824, yoy: 0.4, quality: "published", note: STATS_2026_08 },
    // 2025（同期）
    { seq: 1, period: "1–2月", year: 2025, value: 83734, yoy: null, quality: "derived", note: "86079÷(1+2.8%)" },
    { seq: 3, period: "3月", year: 2025, value: 40920, yoy: null, quality: "derived", note: "41616÷(1+1.7%)" },
    { seq: 4, period: "4月", year: 2025, value: 37173, yoy: null, quality: "derived", note: "37247÷(1+0.2%)" },
    { seq: 5, period: "5月", year: 2025, value: 41326, yoy: 6.4, quality: "published", note: "统计局2025-06-16发布" },
    { seq: 6, period: "6月", year: 2025, value: 42287, yoy: 4.8, quality: "published", note: "统计局2025-07-15发布（新浪财经转载）" },
    { seq: 7, period: "7月", year: 2025, value: 38780, yoy: 3.7, quality: "published", note: "统计局2025-08-14发布" },
    { seq: 8, period: "8月", year: 2025, value: 39665, yoy: null, quality: "derived", note: "39824÷(1+0.4%)" },
    { seq: 9, period: "9月", year: 2025, value: 41971, yoy: 3.0, quality: "published", note: STATS_2025_09 },
    { seq: 10, period: "10月", year: 2025, value: 46291, yoy: 2.9, quality: "published", note: STATS_2025_10 },
    { seq: 11, period: "11月", year: 2025, value: 43898, yoy: 1.3, quality: "published", note: "统计局2025-12-15发布（财新复盘转述）" },
    { seq: 12, period: "12月", year: 2025, value: 45136, yoy: 0.9, quality: "published", note: "统计局2026-01月度发布（第一财经研究院转述，原文45135.9）" },
  ],
};

// ── 服装、鞋帽、针纺织品类（亿元，限额以上当月值）──────────────────────────────────────
// 2026 已发布月锚点：1-2月/6月为统计局发布页原表值；7月=官方累计差(9,615−8,602)；8月原表。
// 3–5月当月值未取得绝对数（Q1/1-4月仅公布增速），留空待回填，图表披露。
// 2025 同期 = 官方当月值÷(1+官方当月同比) 反推；9–12月未取得，参考线只画到 8月。
const APPAREL_NOTE_2026 = "统计局2026年月度发布原表";
const apparel: Indicator = {
  key: "apparel", name: "服装类零售额", unit: "亿元", granularity: "month",
  caliber: "限额以上单位商品零售·服装鞋帽针纺织品类·当月值；3–5月待回填、2025年9–12月待整理",
  sourceName: "国家统计局月度发布", sourceUrls: [STATS_2026_08, "https://www.stats.gov.cn/sj/zxfb/202607/t20260715_1964127.html"], sortOrder: 2,
  ytdValue: 9615, ytdYoy: 5.1, ytdLabel: "1–8月累计",
  rows: [
    // 2026（官方锚点）
    { seq: 1, period: "1–2月", year: 2026, value: 2831, yoy: 10.4, quality: "published", note: "统计局1—2月发布（+10.4%）" },
    { seq: 6, period: "6月", year: 2026, value: 1285, yoy: 3.9, quality: "published", note: "统计局上半年发布页原表 t20260715_1964127" },
    { seq: 7, period: "7月", year: 2026, value: 893, yoy: -1.0, quality: "derived", note: "官方累计差：1-8月9615−8月1013=1-7月8602，再减1-6月7709；同比为官方-1.0%" },
    { seq: 8, period: "8月", year: 2026, value: 1013, yoy: -0.5, quality: "published", note: STATS_2026_08 },
    // 2025（同期，官方对反推）
    { seq: 1, period: "1–2月", year: 2025, value: 2564, yoy: null, quality: "derived", note: "2831÷(1+10.4%)" },
    { seq: 6, period: "6月", year: 2025, value: 1237, yoy: null, quality: "derived", note: "1285÷(1+3.9%)" },
    { seq: 7, period: "7月", year: 2025, value: 902, yoy: null, quality: "derived", note: "893÷(1−1.0%)" },
    { seq: 8, period: "8月", year: 2025, value: 1018, yoy: null, quality: "derived", note: "1013÷(1−0.5%)" },
  ],
};

// ── 童装市场规模（机构估算，欧睿口径）──────────────────────────────────────────────────
const kids: Indicator = {
  key: "kids", name: "童装市场规模", unit: "亿元", granularity: "year",
  caliber: "欧睿咨询口径（机构预测值，媒体/上市公司公告转引），只看趋势不锁绝对值",
  sourceName: "欧睿咨询（腾讯新闻2025-11《安踏系集体卖童装》等转引）", sourceUrls: [], sortOrder: 3,
  rows: [
    { seq: 2024, period: "2024", year: 2024, value: 4000, yoy: null, quality: "estimate", note: "欧睿：2024年或超4000亿元（下限表述）" },
    { seq: 2025, period: "2025", year: 2025, value: 4738, yoy: null, quality: "estimate", note: "欧睿预计2025年有望达4738亿元；两年口径表述不同，不计算同比" },
  ],
};

// ── 人口（万人，年度）──────────────────────────────────────────────────────────────
const POP_NOTE = "历年国民经济和社会发展统计公报";
const populationBirth: Indicator = {
  key: "population-birth", name: "出生人口", unit: "万人", granularity: "year",
  caliber: "年度出生人口", sourceName: "国家统计局年度统计公报", sourceUrls: [STATS_2025_BULLETIN], sortOrder: 4,
  rows: [
    { seq: 2018, period: "2018", year: 2018, value: 1523, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2019, period: "2019", year: 2019, value: 1465, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2020, period: "2020", year: 2020, value: 1200, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2021, period: "2021", year: 2021, value: 1062, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2022, period: "2022", year: 2022, value: 956, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2023, period: "2023", year: 2023, value: 902, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2024, period: "2024", year: 2024, value: 954, yoy: null, quality: "published", note: POP_NOTE },
    { seq: 2025, period: "2025", year: 2025, value: 792, yoy: -17.0, quality: "published", note: STATS_2025_BULLETIN + "（同比按792/954计）" },
  ],
};

const netRows: Row[] = populationBirth.rows.map((r) => {
  const deaths: Record<number, number> = { 2018: 993, 2019: 998, 2020: 998, 2021: 1014, 2022: 1041, 2023: 1110, 2024: 1093, 2025: 1131 };
  const d = deaths[r.year];
  return { seq: r.year, period: r.period, year: r.year, value: r.value - d, yoy: null, quality: "derived" as const, note: `出生${r.value}−死亡${d}（死亡数历年公报）` };
});
const populationNet: Indicator = {
  key: "population-net", name: "人口净增", unit: "万人", granularity: "year",
  caliber: "净增=当年出生−当年死亡（与公报「年末人口比上年末减少」存在口径差，此处统一用出生-死亡）",
  sourceName: "国家统计局年度统计公报", sourceUrls: [STATS_2025_BULLETIN], sortOrder: 5,
  rows: netRows,
};

// ── 年龄结构 ───────────────────────────────────────────────────────────────────────────
// 0–16 逐岁 = 出生队列推算（2025年末 a 岁 = 2025−a 年出生人口），未计死亡损耗；
// 0–15 岁队列合计 22,168万 较公报 23,015万 低约 3.7%（出生登记漏统与普查口径修正），逐岁形态可信。
const AGE_COHORT: Array<[age: number, born: number, births: number, src: string]> = [
  [16, 2009, 1585, "统计局历年公布（出生率11.95‰）"],
  [15, 2010, 1588, "统计局历年公布"],
  [14, 2011, 1600, "统计局历年公布"],
  [13, 2012, 1635, "统计局历年公布"],
  [12, 2013, 1640, "统计局历年公布"],
  [11, 2014, 1687, "统计局历年公布"],
  [10, 2015, 1655, "统计局历年公布"],
  [9, 2016, 1786, "统计局（全面二孩峰值）"],
  [8, 2017, 1723, "统计局历年公布"],
  [7, 2018, 1523, "2018年统计公报"],
  [6, 2019, 1465, "2019年统计公报"],
  [5, 2020, 1200, "2020年统计公报"],
  [4, 2021, 1062, "2021年统计公报"],
  [3, 2022, 956, "2022年统计公报"],
  [2, 2023, 902, "2023年统计公报"],
  [1, 2024, 954, "2024年统计公报"],
  [0, 2025, 792, "2025年统计公报"],
];
const ageSingle: Indicator = {
  key: "age-single", name: "0–16岁分年龄人口", unit: "万人", granularity: "band",
  caliber: "按历年出生人口推算（a岁=2025−a年出生），未计死亡损耗；0–15岁合计较公报低约3.7%，看逐岁形态",
  sourceName: "历年统计公报出生人口", sourceUrls: [STATS_2025_BULLETIN], sortOrder: 6,
  rows: AGE_COHORT.map(([age, born, births, src]) => ({
    seq: age, period: `${age}岁`, year: 2025, value: births, yoy: null, quality: "derived" as const,
    note: `${born}年出生 ${births}万（${src}）`,
  })),
};

// 17 岁以上细分档（5年/10年）未取得权威分档数——先以两个官方时点的三段结构对照呈现，细分档待接。
const ageBands: Indicator = {
  key: "age-bands", name: "年龄结构分段", unit: "万人", granularity: "band",
  caliber: "两个官方时点对照：2025公报表1 vs 2020七普；17–35/35–60细分档待七普分年龄数据接入",
  sourceName: "国家统计局（2025公报表1 / 七普主要数据）", sourceUrls: [STATS_2025_BULLETIN], sortOrder: 7,
  rows: [
    { seq: 0, period: "0–15岁 · 2025公报", year: 2025, value: 23015, yoy: null, quality: "published", note: "占16.4%；公报注[6] 0-14岁=21276" },
    { seq: 1, period: "0–14岁 · 2020七普", year: 2020, value: 25338, yoy: null, quality: "published", note: "占17.95%" },
    { seq: 2, period: "16–59岁 · 2025公报", year: 2025, value: 85136, yoy: null, quality: "published", note: "占60.6%；公报注[6] 15-59岁=86875" },
    { seq: 3, period: "15–59岁 · 2020七普", year: 2020, value: 89438, yoy: null, quality: "published", note: "占63.35%" },
    { seq: 4, period: "60岁及以上 · 2025公报", year: 2025, value: 32338, yoy: null, quality: "published", note: "占23.0%，其中65+=22365（15.9%）" },
    { seq: 5, period: "60岁及以上 · 2020七普", year: 2020, value: 26402, yoy: null, quality: "published", note: "占18.70%，其中65+=19064" },
  ],
};

const ageSummary: Indicator = {
  key: "age-summary", name: "年龄结构总览", unit: "万人", granularity: "band",
  caliber: "2025年统计公报表1「年末人口数及其构成」",
  sourceName: "国家统计局2025年统计公报", sourceUrls: [STATS_2025_BULLETIN], sortOrder: 8,
  rows: [
    { seq: 0, period: "总人口", year: 2025, value: 140489, yoy: null, quality: "published", note: STATS_2025_BULLETIN },
    { seq: 1, period: "0–15岁", year: 2025, value: 23015, yoy: null, quality: "published", note: "占16.4%" },
    { seq: 2, period: "16–59岁", year: 2025, value: 85136, yoy: null, quality: "published", note: "占60.6%" },
    { seq: 3, period: "60岁及以上", year: 2025, value: 32338, yoy: null, quality: "published", note: "占23.0%" },
    { seq: 4, period: "65岁及以上", year: 2025, value: 22365, yoy: null, quality: "published", note: "占15.9%" },
  ],
};

const ALL: Indicator[] = [retail, apparel, kids, populationBirth, populationNet, ageSingle, ageBands, ageSummary];

let obsCount = 0;
for (const ind of ALL) {
  await sql`
    INSERT INTO macro_indicators (key, name, unit, granularity, caliber, source_name, source_urls, ytd_value, ytd_yoy, ytd_label, sort_order, updated_at)
    VALUES (${ind.key}, ${ind.name}, ${ind.unit}, ${ind.granularity}, ${ind.caliber}, ${ind.sourceName}, ${ind.sourceUrls},
            ${ind.ytdValue ?? null}, ${ind.ytdYoy ?? null}, ${ind.ytdLabel ?? null}, ${ind.sortOrder}, now())
    ON CONFLICT (key) DO UPDATE SET
      name = EXCLUDED.name, unit = EXCLUDED.unit, granularity = EXCLUDED.granularity, caliber = EXCLUDED.caliber,
      source_name = EXCLUDED.source_name, source_urls = EXCLUDED.source_urls,
      ytd_value = EXCLUDED.ytd_value, ytd_yoy = EXCLUDED.ytd_yoy, ytd_label = EXCLUDED.ytd_label,
      sort_order = EXCLUDED.sort_order, updated_at = now()`;
  for (const r of ind.rows) {
    await sql`
      INSERT INTO macro_observations (indicator_key, period, seq, year, value, quality, yoy, note)
      VALUES (${ind.key}, ${r.period}, ${r.seq}, ${r.year}, ${r.value}, ${r.quality}, ${r.yoy}, ${r.note})
      ON CONFLICT (indicator_key, year, seq) DO UPDATE SET
        period = EXCLUDED.period, value = EXCLUDED.value, quality = EXCLUDED.quality,
        yoy = EXCLUDED.yoy, note = EXCLUDED.note`;
    obsCount++;
  }
  console.log(`macro: ${ind.key} — ${ind.rows.length} rows`);
}
console.log(`macro: done, ${obsCount} observations`);
await closeDb();
