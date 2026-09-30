// 人工补录通道（manual-supplement）：读 database/seeds 的品牌/商场种子文件，把命主维护的人工
// 维度值（业绩/门店数/社媒指数/客流层级）作为一方补录源写快照。命主编辑种子文件后下一轮
// 刷新自动生效——这就是「社媒指数人工补录通道」（zw12 卡面二选一项的保守默认落地）。
// 所有值在文件内注明人工概数口径；页面以覆盖度标签披露，不冒充机器采集。
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../config.ts";
import { configurationOf } from "../configuration.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BRANDS_FILE = path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json");
const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");
const SEED_VERSION = "2026-10";

interface BrandSeed {
  slug: string;
  name: string;
  provider: string;
  listed: string;
  revenue: number | null;
  stores: number | null;
  socialIndex: number | null;
  keywords: string[];
}

interface MallSeed {
  slug: string;
  name: string;
  city: string;
  footfallTier: number;
  revenue: number | null;
  keywords: string[];
}

function row(name: string, slug: string, metricKey: string, metricName: string, rawScore: number, extra: Record<string, unknown> = {}): ParsedRow {
  return {
    sourceModelName: name,
    keyName: slug,
    baseName: name,
    configuration: configurationOf([]),
    metricKey,
    metricName,
    rawScore,
    metadata: { metricDirection: "HIGHER", manualSupplement: true, ...extra },
  };
}

export const manualSupplement: Fetcher = {
  // mall-revenue（商业体销售额）：zw19 起接通——种子值=联商网《全国250+商场2025销售额出炉》
  // 年度盘点（媒体整理，不完全统计口径），有值才产出快照行；剩余空缺由方法层
  // 「业绩缺数滚给客流」条款处理（weighted.ts rollToOnEmpty）。
  sourceKeys: ["brand-revenue", "brand-stores", "brand-social", "mall-footfall", "mall-revenue"],
  async fetch() {
    const brands = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: BrandSeed[] }).brands;
    const malls = (JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls: MallSeed[] }).malls;
    const meta = { dataAtKind: "manual-seed", seedVersion: SEED_VERSION, sourceOperator: "manual-supplement", metricCount: 1, attribution: "命主人工补录（种子文件），页面以覆盖度标签披露" };
    const mk = (sourceKey: string, sourceName: string, rows: ParsedRow[]) => ({
      sourceKey,
      sourceName,
      sourceUrl: "https://example.invalid/manual-supplement",
      license: "内部人工补录",
      attributionUrl: "",
      publishedAt: null,
      rows,
      metadata: { ...meta, seedVersion: SEED_VERSION },
    });
    return [
      mk("brand-revenue", "童装业务营收（人工概数）", brands.filter((b) => b.revenue != null).map((b) => row(b.name, b.slug, "brand-revenue", "童装业务营收（亿元）", b.revenue!, { listed: b.listed }))),
      mk("brand-stores", "门店规模（人工概数档位）", brands.filter((b) => b.stores != null).map((b) => row(b.name, b.slug, "brand-stores", "门店数（家，概数档位）", b.stores!))),
      mk("brand-social", "社媒指数（人工补录通道）", brands.filter((b) => b.socialIndex != null).map((b) => row(b.name, b.slug, "brand-social", "社媒指数", b.socialIndex!))),
      mk("mall-footfall", "商业体客流层级（人工种子）", malls.map((m) => row(m.name, m.slug, "mall-footfall", "客流层级（1-10）", m.footfallTier, { city: m.city }))),
      mk("mall-revenue", "商业体2025销售额（联商盘点）", malls.filter((m) => m.revenue != null).map((m) => row(m.name, m.slug, "mall-revenue", "2025销售额（亿元）", m.revenue!, { city: m.city, dataNote: "联商网2025年度盘点·媒体整理不完全统计" }))),
    ];
  },
};
