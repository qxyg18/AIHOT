// 站内声量引擎（internal-signal）：统计 SIGNAL_WINDOW_DAYS（method/weighted 单一定义，rd7 起 90
// 天）窗口内站内文章的实体标注（article_entities：标题+摘要+正文全文的确定性关键词标注，rd7 起
// 声量走全文级标注而非仅标题）对各品牌/商场实体的提及。产五个指标：brand-volume（声量）/
// brand-expansion（开店·首店·新品事件）/mall-media（商场媒体声量）/mall-affinity（童装品牌×商场
// 同文共现）/mall-firststore（首店快闪事件）。名录内实体零提及也出行（0 分）：既保住快照非空校验，
// 也让「样本不足」门槛（<MENTION_MIN）在方法层自然生效。扩张/首店事件词仍按标题匹配（与 v3 口径
// 一致）；mall-chain 标注经名录 slug 过滤方计入 media/affinity 统计面——当前链级 slug 与商场名录
// 不相交（口径入口保留、实际零增益），待链→门店映射后自动生效。
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "../../../db.ts";
import { REPO_ROOT } from "../../../config.ts";
import { configurationOf } from "../configuration.ts";
import { SIGNAL_WINDOW_DAYS } from "../../method/weighted.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BRANDS_FILE = path.join(REPO_ROOT, "database/seeds/lb-brands-2026-10.json");
const MALLS_FILE = path.join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json");
/** 提及窗口单一定义在 method/weighted（rd7 起 90 天），此处复用防双常量漂移。 */
const WINDOW_DAYS = SIGNAL_WINDOW_DAYS;
/** 扩张/首店快闪的事件词（标题级）。 */
const EXPANSION_RE = /(开\s*店|新开|首店|入驻|开业|新店|新品|联名|快闪|拓店|进场)/;

interface EntitySeed { slug: string; name: string; keywords: string[] }

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
    let brands: EntitySeed[] = [];
    let malls: EntitySeed[] = [];
    try {
      brands = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands?: EntitySeed[] }).brands ?? [];
      malls = (JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls?: EntitySeed[] }).malls ?? [];
    } catch (err) {
      // ym160：种子缺失/损坏降级为空名录（五指标出空包），对齐 read.ts tenancyByMall 守卫；
      // 不入缓存负态，下次 fetch 重试；warn 可观测防静默数据面消失。
      console.warn(`[leaderboard] internal-signal seeds unreadable (${BRANDS_FILE}):`, err instanceof Error ? err.message : err);
    }
    // rd7：全文级标注面（article_entities）替代标题扫描——按文聚合标注实体，再逐文计数。
    // ym160：恢复 ym99 公开闸（read.ts:434 同款）——仅公开可见性×采编参与源的文章计入声量/事件统计。
    // ym842：窗口字段统一发布时间口径 coalesce(published_at,discovered_at)（d-ym160-window-field 拍板乙，
    // entitytags/read.ts 角标同款；与入库时间线 timeline_at 的差值=入库滞后，对拍现势零差异）。
    const annotated = await sql<{ article_id: string; title: string; entity_type: string; entity_slug: string }[]>`
      SELECT ae.article_id, a.title, ae.entity_type, ae.entity_slug
      FROM article_entities ae JOIN articles a ON a.id = ae.article_id
      WHERE coalesce(a.published_at, a.discovered_at) >= now() - (${WINDOW_DAYS} || ' days')::interval
        AND EXISTS (
          SELECT 1 FROM publications p JOIN sources s ON s.id = p.source_id
          WHERE p.article_id = a.id AND p.visibility = 'public' AND s.participation_mode = 'editorial'
        )`;

    const brandSlugs = new Set(brands.map((b) => b.slug));
    const mallSlugs = new Set(malls.map((m) => m.slug));
    const articleTitle = new Map<string, string>();
    const articleBrands = new Map<string, Set<string>>();
    const articleMalls = new Map<string, Set<string>>();
    for (const r of annotated) {
      articleTitle.set(r.article_id, r.title);
      if (r.entity_type === "brand" && brandSlugs.has(r.entity_slug)) {
        if (!articleBrands.has(r.article_id)) articleBrands.set(r.article_id, new Set());
        articleBrands.get(r.article_id)!.add(r.entity_slug);
      }
      if ((r.entity_type === "mall" || r.entity_type === "mall-chain") && mallSlugs.has(r.entity_slug)) {
        if (!articleMalls.has(r.article_id)) articleMalls.set(r.article_id, new Set());
        articleMalls.get(r.article_id)!.add(r.entity_slug);
      }
    }

    const brandVolume = new Map<string, number>(brands.map((b) => [b.slug, 0]));
    const brandExpansion = new Map<string, number>(brands.map((b) => [b.slug, 0]));
    const mallMedia = new Map<string, number>(malls.map((m) => [m.slug, 0]));
    // v4.8（ym155 命主 2026-10-03 直令）：亲和单位改「共现去重品牌数」——每商场收集共现文章的品牌并集，
    // rawScore=集合大小（每有一个榜内品牌+10 分由计分层 affinityBrandScore 承接）。
    const mallAffinityBrands = new Map<string, Set<string>>(malls.map((m) => [m.slug, new Set<string>()]));
    const mallFirststore = new Map<string, number>(malls.map((m) => [m.slug, 0]));

    for (const [articleId, title] of articleTitle) {
      const event = EXPANSION_RE.test(title);
      const brandsIn = articleBrands.get(articleId);
      const mallsIn = articleMalls.get(articleId);
      if (brandsIn) {
        for (const b of brandsIn) {
          brandVolume.set(b, brandVolume.get(b)! + 1);
          if (event) brandExpansion.set(b, brandExpansion.get(b)! + 1);
        }
      }
      if (mallsIn) {
        for (const m of mallsIn) {
          mallMedia.set(m, mallMedia.get(m)! + 1);
          if (event) mallFirststore.set(m, mallFirststore.get(m)! + 1);
          if (brandsIn) for (const b of brandsIn) mallAffinityBrands.get(m)!.add(b);
        }
      }
    }

    const meta = {
      dataAtKind: "internal-window",
      windowDays: WINDOW_DAYS,
      articleCount: articleTitle.size,
      sourceOperator: "internal-signal",
      metricCount: 1,
      attribution: "本站采集窗口统计（article_entities 全文级实体标注；事件词按标题匹配）",
      upstreamPublishedAt: new Date().toISOString().slice(0, 10),
    };
    const mk = (sourceKey: string, sourceName: string, rows: ParsedRow[]) => ({
      sourceKey, sourceName, sourceUrl: "internal://articles/entity-annotations", license: "本站自有数据",
      attributionUrl: "", publishedAt: null, rows, metadata: meta,
    });
    const byName = new Map([...brands, ...malls].map((e) => [e.slug, e.name]));
    const pack = (entities: EntitySeed[], counts: Map<string, number>, metricKey: string, metricName: string) =>
      entities.map((e) => row(byName.get(e.slug) ?? e.slug, e.slug, metricKey, metricName, counts.get(e.slug) ?? 0));

    return [
      mk("brand-volume", "站内品牌声量（90天全文级标注）", pack(brands, brandVolume, "brand-volume", "站内提及文章数")),
      mk("brand-expansion", "品牌扩张事件（开店·首店·新品）", pack(brands, brandExpansion, "brand-expansion", "扩张事件数")),
      mk("mall-media", "商场媒体声量（90天全文级标注）", pack(malls, mallMedia, "mall-media", "站内提及文章数")),
      mk("mall-affinity", "童装业态亲和（共现童装品牌数·去重）",
        pack(malls, new Map([...mallAffinityBrands].map(([k, v]) => [k, v.size])), "mall-affinity", "共现童装品牌数")),

      mk("mall-firststore", "首店快闪动能（事件）", pack(malls, mallFirststore, "mall-firststore", "首店快闪事件数")),
    ];
  },
};
