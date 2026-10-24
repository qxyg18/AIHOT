// Entity page (zx18): one brand / mall / mall chain / retail channel — its profile facts, its
// current leaderboard rank when it is on a board, and the related site articles. Reached from the
// entity tags and rail cards on article pages.
import { useState } from "react";
import { SITE } from "@aihot/industry/site";
import { Link } from "react-router";
import type { SiteInsight, SiteInsightsResponse } from "@aihot/contracts/site";
import type { Route } from "./+types/entity";
import { loadOr404 } from "../lib/api.server";
import { EntityInsightList } from "../features/item/InsightCards";

export interface CoRow { slug: string; name: string; count: number }

export interface MallDynamic {
  articleId: string;
  title: string;
  publishedAt: string | null;
  kind: "open" | "close";
  word: string;
}

/** Article signals (ym132-③④): approved facts extracted from site coverage, human-reviewed. */
export interface SignalView {
  id: string;
  kind: "openings" | "revenue" | "stores";
  value: number;
  unit: string;
  caliber: string | null;
  quote: string;
  articleId: string;
  articleTitle: string | null;
  at: string;
}

/** Mall standing signals (ym132-③): latest published run's raw in-site counts. */
export interface MallSignalView { key: string; label: string; score: number }

/** Store archive stats (ym118): listed* = Amap hit count, archived* = per-store rows held. */
export interface StoreStatsData {
  listedTotal: number;
  listedByProvince: Array<{ province: string; count: number }>;
  archivedTotal: number;
  mallMatched: number;
  updatedAt: string | null;
}

export interface EntityPageData {
  type: "brand" | "mall" | "mall-chain" | "channel";
  slug: string;
  name: string;
  summary: string | null;
  facts: Array<{ label: string; value: string }>;
  chainNote: string | null;
  leaderboard: { board: "brand" | "mall"; rank: number; score: number } | null;
  articles: Array<{ id: string; title: string; publishedAt: string | null }>;
  articleCount: number;
  coBrands?: { w90: CoRow[]; w365: CoRow[] };
  relatedMalls?: { w90: CoRow[]; w365: CoRow[] };
  storeStats?: StoreStatsData | null;
  dynamics?: MallDynamic[];
  /** ym132-③④：已审核文章信号（brand/mall 同型）。 */
  signals?: SignalView[];
  /** ym132-③：商场站内信号（最新已发布 run 原始计数）。 */
  mallSignals?: MallSignalView[];
  /** ym132-③：商场研报观点（loader 另拉 insights 接口；品牌侧不渲染此区）。 */
  insights?: SiteInsight[];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const data = await loadOr404<EntityPageData>(
    `/api/site/entity/${encodeURIComponent(params.type)}/${encodeURIComponent(params.slug)}`,
    { signal: request.signal },
  );
  // ym132-③：商场档案对称通道——研报观点复用站点洞察接口（同 leaderboard-model 模式；缺数据静默）。
  if (data.type !== "mall") return data;
  const insights = await loadOr404<SiteInsightsResponse>(`/api/site/insights/entity/${encodeURIComponent(params.slug)}`, { signal: request.signal }).catch(() => ({ insights: [] }));
  return { ...data, insights: insights.insights };
}

export const meta = ({ loaderData }: Route.MetaArgs) => [{ title: `${loaderData?.name ?? "实体"} · ${SITE.name}` }];

const BOARD_LABEL = { brand: "童装品牌榜", mall: "全国商业体榜" } as const;
const TYPE_LABEL = { brand: "品牌", mall: "商业体", "mall-chain": "商业体连锁", channel: "母婴渠道" } as const;

/** Co-mention panel (a21): same-article brand×mall signals over two lookback windows. */
function CoPanel({ title, data, targetType, emptyNoun }: { title: string; data?: { w90: CoRow[]; w365: CoRow[] }; targetType: "brand" | "mall"; emptyNoun: string }) {
  const [win, setWin] = useState<"w90" | "w365">("w90");
  if (!data) return null;
  const rows = data[win];
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
        <div className="flex gap-0.5 rounded-full bg-bg-2 p-0.5">
          {(["w90", "w365"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWin(w)}
              className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${win === w ? "bg-surface font-medium text-ink" : "text-ink-3"}`}
            >
              {w === "w90" ? "近90天" : "近365天"}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-3">暂无公开报道共现的{emptyNoun}。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {rows.map((r, i) => (
            <li key={r.slug}>
              <Link to={`/entity/${targetType}/${r.slug}`} prefetch="intent" className="flex items-baseline justify-between gap-3 py-2.5 transition-colors hover:text-accent">
                <span className="flex items-baseline gap-2.5">
                  <span className="w-4 text-[12px] text-ink-4">{i + 1}</span>
                  <span className="text-[14.5px] text-ink">{r.name}</span>
                </span>
                <span className="shrink-0 text-[12.5px] text-ink-3">{r.count} 篇共同报道</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">口径：站内公开报道同篇共现信号，非租户名录，仅供个人参考。</p>
    </section>
  );
}

/** Open/close timeline (a21): headline-level signals only, each entry links to the report. */
function DynamicsPanel({ dynamics }: { dynamics?: MallDynamic[] }) {
  if (!dynamics) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">开闭店动态</h2>
      {dynamics.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-3">近期无公开报道的开闭店动态。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {dynamics.map((d) => (
            <li key={`${d.articleId}-${d.kind}`} className="flex items-baseline gap-2.5 py-2.5">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${d.kind === "open" ? "bg-accent-softer text-accent" : "bg-bg-2 text-ink-3"}`}
              >
                {d.kind === "open" ? "开业" : "闭店"}
              </span>
              <Link to={`/items/${d.articleId}`} prefetch="intent" className="text-[14.5px] leading-snug text-ink transition-colors hover:text-accent">
                {d.title}
              </Link>
              {d.publishedAt && <time className="ml-auto shrink-0 text-[12px] text-ink-4">{d.publishedAt.slice(0, 10)}</time>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">口径：标题/摘要中商业体名与开闭店词同现的公开报道信号，非事实核证。</p>
    </section>
  );
}

/** Article signals (ym132-④): approved facts from site coverage — the same face on brand and mall
 *  pages. Kind label + value/unit + caliber, the source sentence, and the article it was read from. */
function SignalPanel({ signals }: { signals?: SignalView[] }) {
  if (!signals || signals.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">文章信号</h2>
      <ul className="mt-3 space-y-2">
        {signals.map((s) => (
          <li key={s.id} className="rounded-tile border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink-4">
              <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[11.5px] text-ink-3">{SIGNAL_LABEL[s.kind]}</span>
              <span className="mono text-[15px] font-semibold text-ink">{s.value.toLocaleString("zh-Hans-CN")}{s.unit}</span>
              {s.caliber && <span>{s.caliber}</span>}
              {s.at && <span className="ml-auto">{s.at.slice(0, 10)} 审核</span>}
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">“{s.quote}”</p>
            <Link to={`/items/${s.articleId}`} prefetch="intent" className="mt-1 inline-flex text-[12px] font-medium text-accent transition-colors hover:text-accent-ink">
              《{s.articleTitle ?? "查看原文"}》
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">口径：站内文章数字经提取器归到本实体、人工审核通过后展示（非官方公报）；重复提取不叠加。</p>
    </section>
  );
}

const SIGNAL_LABEL: Record<SignalView["kind"], string> = { openings: "新开店数", revenue: "业绩数字", stores: "门店数" };

/** Mall standing signals (ym132-③): raw counts from the latest published run's internal signals —
 *  the mirror face of the brand page's store statistics, computed from the same annotation pass. */
function MallSignals({ rows }: { rows?: MallSignalView[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">站内信号</h2>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        {rows.map((r) => (
          <div key={r.key} className="rounded-tile border border-line bg-surface px-3.5 py-3">
            <dt className="text-[11.5px] text-ink-4">{r.label}</dt>
            <dd className="num mt-1 text-[20px] font-semibold text-ink">
              {r.score.toLocaleString("zh-Hans-CN")}
              <span className="ml-1 font-sans text-[11px] font-normal text-ink-4">{r.key === "mall-firststore" ? "起" : "篇"}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">口径：站内公开报道的实体标注计数（近 90 天滚动窗；声量=提及文章数、业态亲和=与童装品牌同文共现、首店快闪=事件词命中），随榜单轮次更新。</p>
    </section>
  );
}

/** Store distribution (ym118): brand-page panel — Amap-collected store totals per province. */
function StorePanel({ stats }: { stats?: StoreStatsData | null }) {
  if (!stats) return null;
  const rows = stats.listedByProvince;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold text-ink">门店分布</h2>
        {rows.length > 0 && (
          <span className="text-[12.5px] text-ink-3">
            门店 {stats.listedTotal.toLocaleString("zh-CN")} 家 · 覆盖 {rows.length} 个省级地区
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-3">暂无门店数据。</p>
      ) : (
        <ul className="mt-3.5 space-y-2">
          {rows.map((r) => (
            <li key={r.province} className="flex items-center gap-3">
              <span className="w-[6.5rem] shrink-0 truncate text-[13px] text-ink-2">{r.province}</span>
              <span
                className="h-2 rounded-full bg-accent-softer"
                style={{ width: `${Math.max(3, Math.round((r.count / max) * 100))}%` }}
                aria-hidden="true"
              />
              <span className="ml-auto shrink-0 text-[12.5px] tabular-nums text-ink-3">{r.count.toLocaleString("zh-CN")} 家</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-4">
        口径：高德地图 POI 检索收录数（非品牌公报口径），按采集城市聚合、随月度采集持续扩充。
        已建门店明细档案 {stats.archivedTotal.toLocaleString("zh-CN")} 家（含省市区县与详细地址，
        其中 {stats.mallMatched.toLocaleString("zh-CN")} 家已识别所在商业体），明细表为门店地址专项页储备数据。
      </p>
    </section>
  );
}

export default function EntityPage({ loaderData: e }: Route.ComponentProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[22px] font-bold text-ink">{e.name}</h1>
        <span className="rounded-full bg-bg-2 px-2.5 py-0.5 text-[12px] text-ink-3">{TYPE_LABEL[e.type]}</span>
        {e.leaderboard && (
          <Link
            to={`/leaderboard?board=${e.leaderboard.board}`}
            className="rounded-full bg-accent-softer px-2.5 py-0.5 text-[12px] font-medium text-accent"
          >
            {BOARD_LABEL[e.leaderboard.board]} 第 {e.leaderboard.rank} 名
          </Link>
        )}
      </div>

      {e.summary && <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{e.summary}</p>}
      {e.chainNote && <p className="mt-2 text-[13px] text-ink-3">{e.chainNote}</p>}

      {(e.facts.length > 0 || e.leaderboard) && (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-tile border border-line bg-surface px-4 py-3.5 sm:grid-cols-3">
          {e.facts.map((f) => (
            <div key={f.label}>
              <dt className="text-[11.5px] text-ink-4">{f.label}</dt>
              <dd className="mt-0.5 text-[13.5px] text-ink">{f.value}</dd>
            </div>
          ))}
          {e.leaderboard && (
            <div>
              <dt className="text-[11.5px] text-ink-4">榜单得分</dt>
              <dd className="mt-0.5 text-[13.5px] text-ink">{Math.round(e.leaderboard.score)}</dd>
            </div>
          )}
        </dl>
      )}

      {e.type === "brand" && <StorePanel stats={e.storeStats} />}
      {e.type === "brand" && <SignalPanel signals={e.signals} />}
      {e.type === "brand" && <CoPanel title="相关商业体" data={e.relatedMalls} targetType="mall" emptyNoun="商业体" />}
      {e.type === "mall" && <SignalPanel signals={e.signals} />}
      {e.type === "mall" && <MallSignals rows={e.mallSignals} />}
      {e.type === "mall" && <CoPanel title="童装品牌关联" data={e.coBrands} targetType="brand" emptyNoun="童装品牌" />}
      {e.type === "mall" && <DynamicsPanel dynamics={e.dynamics} />}
      {e.type === "mall" && <EntityInsightList insights={e.insights ?? []} />}

      <h2 className="mt-8 text-[16px] font-semibold text-ink">相关新闻（{e.articleCount}）</h2>
      {e.articles.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-3">暂无相关新闻。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {e.articles.map((a) => (
            <li key={a.id}>
              <Link to={`/items/${a.id}`} prefetch="intent" className="block py-3 transition-colors hover:text-accent">
                <span className="text-[14.5px] leading-snug text-ink">{a.title}</span>
                {a.publishedAt && (
                  <time className="mt-1 block text-[12px] text-ink-4">{a.publishedAt.slice(0, 10)}</time>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-[11.5px] leading-relaxed text-ink-4">档案与标签为公开信息聚合（人工种子与站内新闻口径），仅供个人参考。</p>
    </main>
  );
}
