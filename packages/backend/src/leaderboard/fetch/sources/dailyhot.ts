// DailyHotApi 热搜哨兵（dailyhot）：自部署实例（github.com/imsyy/DailyHotApi，MIT，Docker）的
// 全网热搜聚合。监控品牌关键词命中热搜→brand-hotsearch 指标（声量维度的加分项）。
// DAILYHOT_API_BASE 未配置时本源停用（fail 留痕=哨兵未激活，不阻断其余源，同 Retail Gazette
// degraded 模式）；自部署实例属可选增强，随 env 注入即激活。
import { readFileSync } from "node:fs";
import path from "node:path";
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { REPO_ROOT } from "../../../config.ts";
import { configurationOf } from "../configuration.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BRANDS_FILE = path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json");
const ROUTES = ["weibo", "zhihu", "baidu", "douyin"];

interface HotItem { title: string }
interface HotResp { code: number; data: HotItem[] }

export const dailyhot: Fetcher = {
  sourceKeys: ["brand-hotsearch"],
  async fetch() {
    const base = process.env.DAILYHOT_API_BASE?.replace(/\/$/, "");
    if (!base) throw new Error("dailyhot: DAILYHOT_API_BASE 未配置，热搜哨兵停用（可选增强，自部署 DailyHotApi 实例后经 env 激活）");

    const brands = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: Array<{ slug: string; name: string; keywords: string[] }> }).brands;
    const counts = new Map<string, number>(brands.map((b) => [b.slug, 0]));
    let hitsTotal = 0;
    const fetchedAt = new Date().toISOString();
    for (const route of ROUTES) {
      const res = await guardedFetch(`${base}/${route}`, { timeoutMs: 15_000 });
      if (res.status !== 200) throw new Error(`dailyhot ${route}: HTTP ${res.status}`);
      const body = JSON.parse(res.text()) as HotResp;
      if (body.code !== 200 || !Array.isArray(body.data)) throw new Error(`dailyhot ${route}: unexpected payload`);
      for (const item of body.data) {
        for (const b of brands) {
          if (b.keywords.some((k) => item.title.toLowerCase().includes(k.toLowerCase()))) {
            counts.set(b.slug, counts.get(b.slug)! + 1);
            hitsTotal++;
          }
        }
      }
    }

    const rows: ParsedRow[] = brands.map((b) => ({
      sourceModelName: b.name,
      keyName: b.slug,
      baseName: b.name,
      configuration: configurationOf([]),
      metricKey: "brand-hotsearch",
      metricName: "热搜命中次数",
      rawScore: counts.get(b.slug) ?? 0,
      metadata: { metricDirection: "HIGHER", hotsearch: true, routes: ROUTES.join(",") },
    }));
    const out: FetchResult = {
      sourceKey: "brand-hotsearch",
      sourceName: "全网热搜哨兵（DailyHotApi）",
      sourceUrl: "https://github.com/imsyy/DailyHotApi",
      license: "MIT · DailyHotApi 自部署实例",
      attributionUrl: "https://github.com/imsyy/DailyHotApi",
      publishedAt: null,
      rows,
      metadata: {
        dataAtKind: "sentinel-poll",
        base,
        routes: ROUTES.join(","),
        hitsTotal,
        articleCount: rows.length,
        fetchedAt,
        sourceOperator: "dailyhot",
        metricCount: 1,
        attribution: "DailyHotApi（自部署）聚合的各平台热搜标题命中统计",
      },
    };
    return [out];
  },
};
