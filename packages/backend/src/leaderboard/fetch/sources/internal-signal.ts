// 站内声量引擎（internal-signal）：统计 SIGNAL_WINDOW_DAYS 窗口内站内文章标题对各品牌/商场
// 实体的提及。产五个指标：brand-volume（声量）/brand-expansion（开店·首店·新品事件）/
// mall-media（商场媒体声量）/mall-affinity（童装品牌×商场同题共现）/mall-firststore（首店快闪事件）。
// 名录内实体零提及也出行（0 分）：既保住快照非空校验，也让「样本不足」门槛（<MENTION_MIN）
// 在方法层自然生效。正文级匹配与 LLM 分析联动留给 zw11 信源扩展后的后续批。
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "../../../db.ts";
import { REPO_ROOT } from "../../../config.ts";
import { configurationOf } from "../configuration.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BRANDS_FILE = path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json");
const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");
const WINDOW_DAYS = 30;
/** 扩张/首店快闪的事件词（标题级）。 */
const EXPANSION_RE = /(开\s*店|新开|首店|入驻|开业|新店|新品|联名|快闪|拓店|进场)/;

interface EntitySeed { slug: string; name: string; keywords: string[] }

function mentions(title: string, keywords: string[]): boolean {
  return keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()));
}

function row(name: string, slug: string, metricKey: string, metricName: string, rawScore: number): ParsedRow {
  return {
    sourceModelName: name,
    keyName: slug,
    baseName: name,
    configuration: configurationOf([]),
    metricKey,
    metricName,
    rawScore,
    metadata: { metricDirection: "HIGHER", internalSignal: true },
  };
}

export const internalSignal: Fetcher = {
  sourceKeys: ["brand-volume", "brand-expansion", "mall-media", "mall-affinity", "mall-firststore"],
  async fetch() {
    const brands = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: EntitySeed[] }).brands;
    const malls = (JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls: EntitySeed[] }).malls;
    const titles = await sql<{ title: string }[]>`
      SELECT title FROM articles
      WHERE timeline_at >= now() - (${WINDOW_DAYS} || ' days')::interval
        AND (body_status = 'ok' OR body_status = 'unconfirmed' OR body_status = 'pending' OR body_status = 'none')`;
    const window = titles.map((t) => t.title);

    const brandVolume = new Map<string, number>(brands.map((b) => [b.slug, 0]));
    const brandExpansion = new Map<string, number>(brands.map((b) => [b.slug, 0]));
    const mallMedia = new Map<string, number>(malls.map((m) => [m.slug, 0]));
    const mallAffinity = new Map<string, number>(malls.map((m) => [m.slug, 0]));
    const mallFirststore = new Map<string, number>(malls.map((m) => [m.slug, 0]));

    for (const title of window) {
      const brandHits = brands.filter((b) => mentions(title, b.keywords));
      for (const b of brandHits) {
        brandVolume.set(b.slug, brandVolume.get(b.slug)! + 1);
        if (EXPANSION_RE.test(title)) brandExpansion.set(b.slug, brandExpansion.get(b.slug)! + 1);
      }
      for (const m of malls) {
        if (!mentions(title, m.keywords)) continue;
        mallMedia.set(m.slug, mallMedia.get(m.slug)! + 1);
        if (EXPANSION_RE.test(title)) mallFirststore.set(m.slug, mallFirststore.get(m.slug)! + 1);
        if (brandHits.length) mallAffinity.set(m.slug, mallAffinity.get(m.slug)! + 1);
      }
    }

    const meta = {
      dataAtKind: "internal-window",
      windowDays: WINDOW_DAYS,
      articleCount: window.length,
      sourceOperator: "internal-signal",
      metricCount: 1,
      attribution: "本站采集窗口统计（标题级提及）",
      upstreamPublishedAt: new Date().toISOString().slice(0, 10),
    };
    const mk = (sourceKey: string, sourceName: string, rows: ParsedRow[]) => ({
      sourceKey, sourceName, sourceUrl: "internal://articles/title-mentions", license: "本站自有数据",
      attributionUrl: "", publishedAt: null, rows, metadata: meta,
    });
    const byName = new Map([...brands, ...malls].map((e) => [e.slug, e.name]));
    const pack = (entities: EntitySeed[], counts: Map<string, number>, metricKey: string, metricName: string) =>
      entities.map((e) => row(byName.get(e.slug) ?? e.slug, e.slug, metricKey, metricName, counts.get(e.slug) ?? 0));

    return [
      mk("brand-volume", "站内品牌声量（30天标题提及）", pack(brands, brandVolume, "brand-volume", "站内提及次数")),
      mk("brand-expansion", "品牌扩张事件（开店·首店·新品）", pack(brands, brandExpansion, "brand-expansion", "扩张事件数")),
      mk("mall-media", "商场媒体声量（30天标题提及）", pack(malls, mallMedia, "mall-media", "站内提及次数")),
      mk("mall-affinity", "童装业态亲和（品牌同题共现）", pack(malls, mallAffinity, "mall-affinity", "童装品牌共现次数")),
      mk("mall-firststore", "首店快闪动能（事件）", pack(malls, mallFirststore, "mall-firststore", "首店快闪事件数")),
    ];
  },
};
