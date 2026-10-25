import { SITE, withSubject } from "@aihot/industry/site";
import { Link, data, useLoaderData } from "react-router";
import { useMemo, type ReactNode } from "react";
import type { Route } from "./+types/leaderboard";
import type { LbBoardEntry, LbBoardResponse } from "@aihot/contracts/leaderboard";
import { LB_DIMENSION_LABELS, LB_DIMENSION_ORDER } from "@aihot/contracts/leaderboard";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { BoardTable } from "../features/leaderboard/BoardTable";
import { MainLineFilter } from "../features/leaderboard/MainLineFilter";
import { Podium } from "../features/leaderboard/Podium";
import { SubBoardTabs } from "../features/leaderboard/SubBoardTabs";
import { IconInfo } from "../components/icons";
import { modelHref, shortStamp } from "../features/leaderboard/format";
import { useEntrance } from "../lib/hydration";
import { IntentLink } from "../components/ui/IntentLink";

/** 品牌榜挂主路由 /leaderboard，其余榜走 /leaderboard/category/:key；子榜走 /leaderboard/sub/:sub（leaderboard-sub.tsx）。 */
const CATEGORY_KEYS = new Set(["mall"]);

/** 榜单结构化数据（总榜与子榜 meta 共用；条目按当前名次输出）。 */
export function boardItemList(board: { name: string }, entries: LbBoardEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: board.name,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    numberOfItems: entries.length,
    itemListElement: entries.map((e) => ({ "@type": "ListItem", position: e.rank, name: e.model.name, url: `${siteUrl()}${modelHref(e.model.slug)}` })),
  };
}

/** v4.5 权重条：本轮在役维度权重（run registry 聚合）按权重定稿序拼一行；空=历史 run 无聚合不渲染。 */
function weightLine(key: string, weights: Record<string, number> | undefined): string | null {
  if (!weights) return null;
  const order = LB_DIMENSION_ORDER[key] ?? [];
  const keys = [...order.filter((k) => weights[k] != null), ...Object.keys(weights).filter((k) => !order.includes(k))];
  if (!keys.length) return null;
  return keys.map((k) => `${LB_DIMENSION_LABELS[k] ?? k} ${Math.round((weights[k] ?? 0) * 100)}`).join(" · ");
}

/** 商业体画像（a19）：由榜单全量实体现算的类型/档次/集团/省份分布，口径=人工种子概数；类型分布可点击过滤（rd13）。 */
function MallPortrait({ entries, activeType = null }: { entries: LbBoardEntry[]; activeType?: string | null }) {
  const stats = useMemo(() => {
    const count = (pick: (e: LbBoardEntry) => string | null | undefined) => {
      const map = new Map<string, number>();
      let missing = 0;
      for (const e of entries) {
        const key = pick(e);
        if (!key) missing += 1;
        else map.set(key, (map.get(key) ?? 0) + 1);
      }
      return { rows: [...map.entries()].sort((a, b) => b[1] - a[1]), missing };
    };
    const typeOrder = ["购物中心", "商业街区", "百货", "奥特莱斯"];
    const posOrder = ["高端", "中高端", "中端", "中低端", "低端"];
    const byOrder = (rows: Array<[string, number]>, order: string[]) =>
      [...rows].sort((a, b) => (order.indexOf(a[0]) + 99 * (order.indexOf(a[0]) < 0 ? 1 : 0)) - (order.indexOf(b[0]) + 99 * (order.indexOf(b[0]) < 0 ? 1 : 0)));
    return {
      types: byOrder(count((e) => e.model.profile?.mallType).rows, typeOrder),
      positions: byOrder(count((e) => e.model.profile?.positioning).rows, posOrder),
      groups: count((e) => e.model.profile?.groupCompany),
      provinces: count((e) => e.model.profile?.province),
    };
  }, [entries]);
  const Chip = ({ label, value }: { label: string; value: number }) => (
    <span className="inline-flex items-baseline gap-1.5 rounded-full bg-accent-softer px-2.5 py-1 text-[12px] text-ink-2">
      {label}
      <b className="num text-[12.5px] font-semibold text-ink">{value}</b>
    </span>
  );
  // rd13 类型分布点击过滤：点击=按该类型整榜重查（服务端过滤，名次保持原榜口径）；「全部」与再点同项均清除回总榜。
  const TypeChip = ({ label, value }: { label: string; value: number }) => {
    const active = activeType === label;
    const clears = label === "全部" || active;
    return (
      <IntentLink
        to={clears ? "?" : `?mallType=${encodeURIComponent(label)}`}
        replace
        aria-pressed={active}
        className={`inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors ${
          active ? "bg-accent text-white" : "bg-accent-softer text-ink-2 hover:bg-accent/[0.12] hover:text-ink"
        }`}
      >
        {label}
        <b className={`num text-[12.5px] font-semibold ${active ? "text-white" : "text-ink"}`}>{value}</b>
      </IntentLink>
    );
  };
  const Group = ({ title, children }: { title: string; children: ReactNode }) => (
    <div>
      <p className="text-[11.5px] font-medium text-ink-4">{title}</p>
      <p className="mt-1.5 flex flex-wrap gap-1.5">{children}</p>
    </div>
  );
  return (
    <section className="card mt-3 px-4 py-4 lg:px-[22px]" aria-label="商业体画像">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14.5px] font-semibold text-ink">商业体画像</h2>
        <p className="text-[11.5px] text-ink-4">覆盖 {entries.length} 家 · 人工种子概数，待核实</p>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Group title="类型分布">
          {activeType && <TypeChip label="全部" value={entries.length} />}
          {stats.types.map(([label, value]) => <TypeChip key={label} label={label} value={value} />)}
        </Group>
        <Group title="档次分布">
          {stats.positions.map(([label, value]) => <Chip key={label} label={label} value={value} />)}
        </Group>
        <Group title="头部集团（前五）">
          {stats.groups.rows.slice(0, 5).map(([label, value]) => <Chip key={label} label={label} value={value} />)}
          <Chip label="独立/待核实" value={stats.groups.missing} />
        </Group>
        <Group title={`省份覆盖（前五 · 共 ${stats.provinces.rows.length} 省）`}>
          {stats.provinces.rows.slice(0, 5).map(([label, value]) => <Chip key={label} label={label} value={value} />)}
        </Group>
      </div>
    </section>
  );
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const key = params.key ?? "brand";
  if (params.key !== undefined && !CATEGORY_KEYS.has(params.key)) throw data({ message: "not_found" }, { status: 404 });
  // rd13 展示过滤：品牌榜 hide=（主营隐藏档），商场榜 mallType=（画像类型）；类型过滤时并行取全量份供画像分布口径。
  const url = new URL(request.url);
  const mallType = key === "mall" ? url.searchParams.get("mallType") || null : null;
  const hideMainLines = key === "brand" ? (url.searchParams.get("hide") ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const query = new URLSearchParams();
  if (hideMainLines.length) query.set("hide", hideMainLines.join(","));
  if (mallType) query.set("mallType", mallType);
  const suffix = hideMainLines.length || mallType ? `?${query}` : "";
  const [filtered, full] = await Promise.all([
    loadOr404<LbBoardResponse>(`/api/site/leaderboard/boards/${key}${suffix}`, { signal: request.signal }),
    mallType ? loadOr404<LbBoardResponse>(`/api/site/leaderboard/boards/${key}`, { signal: request.signal }) : Promise.resolve(null),
  ]);
  return { ...filtered, mallType, hideMainLines, fullEntries: full?.entries ?? null };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("页面不存在") }];
  const { board, entries } = loaderData;
  const path = board.key === "brand" ? "/leaderboard" : `/leaderboard/category/${board.key}`;
  return pageMeta({
    title: board.title,
    rawTitle: true,
    description: board.description,
    path,
    image: "/og/pages/leaderboard.png",
    jsonLd: [
      boardItemList(board, entries),
      breadcrumbLd(
        board.key === "brand"
          ? [{ name: "排行榜", path: "/leaderboard" }]
          : [{ name: "排行榜", path: "/leaderboard" }, { name: board.name, path }],
      ),
    ],
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=600" };
}

export default function LeaderboardPage() {
  const { board, entries, run, subBoards, subView, mallType, hideMainLines, fullEntries, poiFoundBrands, poiFoundTotal } = useLoaderData<typeof loader>();
  const entrance = useEntrance();
  const insufficient = entries.filter((e) => e.sampleInsufficient);
  const ranked = entries.filter((e) => !e.sampleInsufficient);
  const footfallOnly = board.key === "mall" && entries.some((e) => e.mode === "footfall-only");
  return (
    <div key={subView?.key ?? board.key} className={entrance ? "animate-fade-up" : undefined}>
      <div className="mt-3 flex flex-col gap-1 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-[13.5px] text-ink-2">{board.description}</p>
        <p className="num text-[12px] text-ink-4">
          {board.sourceCount} 项指标<span className="mx-2">·</span>
          {board.operatorCount} 个来源<span className="mx-2">·</span>
          {shortStamp(run.generatedAt)} 更新
        </p>
      </div>

      <SubBoardTabs boardKey={board.key} subBoards={subBoards} active={subView?.key ?? null} />

      <Podium entries={entries} board={board.key} />

      {board.key === "mall" && !subView && <MallPortrait entries={fullEntries ?? entries} activeType={mallType} />}

      <section className="card mt-3 overflow-hidden" aria-labelledby="lb-board-title">
        <div className="flex items-center justify-between gap-3 px-4 py-3 lg:px-[22px]">
          <h2 id="lb-board-title" className="text-[16px] font-bold text-ink">
            {board.name}
            <span className="mono ml-2 text-[11px] font-normal tracking-wide text-ink-4">TOP {ranked.length}</span>
          </h2>
          {(() => {
            const weights = weightLine(board.key, board.weights);
            return weights ? (
              <span className="num text-right text-[12px] text-ink-4">
                权重：{weights}
                <span className="mx-1.5">·</span>
                <Link to="/leaderboard/rules" className="transition-colors hover:text-accent">排名规则</Link>
              </span>
            ) : (
              <span className="text-right text-[12px] text-ink-4">按公开维度的加权证据排名</span>
            );
          })()}
        </div>
        {board.key === "brand" && !subView && <MainLineFilter active={hideMainLines} />}
        <BoardTable entries={entries} board={board.key} />
        {insufficient.length > 0 && (
          <div className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-ink-4 lg:px-[22px]">
            <span className="font-medium text-ink-3">样本不足（{insufficient.length}）：</span>
            {insufficient.map((e) => e.model.name).join("、")}——有效维度权重占比不足 30%，暂不进入正式名次。
          </div>
        )}
        {board.key === "brand" && !subView && poiFoundBrands.length > 0 && (
          <div className="border-t border-line px-4 py-3 lg:px-[22px]">
            <p className="text-[12px] leading-relaxed text-ink-4">
              <span className="font-medium text-ink-3">POI 发现品牌（{poiFoundTotal}）：</span>
              商业体品类词反推反复扫到、尚未收录进品牌名单的品牌（≥3 店或 ≥2 商场），先行上榜占位不计名次，收编入册后进入正式计分。
              {poiFoundTotal > poiFoundBrands.length && <span>（展示按门店数前 {poiFoundBrands.length} 个）</span>}
            </p>
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {poiFoundBrands.map((b) => (
                <li
                  key={b.name}
                  className="chip inline-flex items-center gap-1.5"
                  title={`高德POI ${b.poiCount} 店 · 覆盖 ${b.mallCount} 商场 / ${b.cityCount} 城`}
                >
                  <span>{b.name}</span>
                  <span className="num rounded-mark bg-bg-sunk px-1.5 py-px text-[10.5px] font-normal text-ink-3">{b.poiCount} 店</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-ink-4 lg:px-[22px]">
          {subView ? (
            <p>
              本页为总榜的带内视图：名次为带内序，加权分与总榜口径完全一致（不重算不折价，计分分母同总榜）；本层 {entries.length} 个实体全量展示（分页）。同分按业绩真值高低排序（推断填充值不参与；业绩同按名录名序），规则预先固定。
            </p>
          ) : (
            <p>{board.key === "brand" ? "品牌榜最多展示 80 个实体" : "商业体榜全量展示（上限 1000 个实体）"}；同分按业绩真值高低排序（v4.5：锚点封顶后回到营收真值定序，推断填充值不参与；业绩同按名录名序），规则预先固定。</p>
          )}
          {footfallOnly && <p>客流正源（赢商人气榜）暂不可抓，本榜为客流单源直榜（人工种子层级）——恢复条件见排名方法页。</p>}
        </div>
      </section>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <section className="card p-5">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
            <IconInfo size={16} className="text-accent" />
            如何看这张榜
          </h2>
          {subView && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{subView.note}</p>}
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{board.howToRead}</p>
          <Link to="/leaderboard/rules" className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            了解计算方法 →
          </Link>
        </section>
        <section className="card p-5">
          <h2 className="text-[14px] font-semibold text-ink">冷启动说明</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            业绩与规模目前来自人工种子概数（公开口径，待核实），页面以覆盖度标签披露每个实体的数据覆盖；站内声量随信源扩展（联商/赢商/华衣等）自动增厚，人工种子将被机器源逐步替换。
          </p>
        </section>
      </div>
    </div>
  );
}
