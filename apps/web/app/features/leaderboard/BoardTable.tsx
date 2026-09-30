import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { LbBoardEntry } from "@aihot/contracts/leaderboard";
import { LB_CONFIDENCE_LABELS } from "@aihot/contracts/leaderboard";
import { BrandMark } from "./BrandMark";
import { EvidenceBadge, TierChips } from "./Evidence";
import { modelHref } from "./format";

type SortKey = "rank" | "date" | "coverage" | "revenue" | "stores" | "area";

function sortValue(e: LbBoardEntry, key: SortKey): number | null {
  switch (key) {
    case "rank":
      return e.rank;
    case "date": {
      // 创立/开业年份：品牌取种子 founded（kb5），商业体取 openedAt；都没有则退名录发布日期。
      const y = e.model.profile?.openedAt ?? e.model.profile?.founded ?? null;
      return y ? -Number(y) : e.model.releasedAt ? -Date.parse(e.model.releasedAt) : null;
    }
    case "coverage":
      return -(e.coverage * 1000 + e.sourceCount);
    case "revenue":
      return e.model.profile?.revenueYi ?? null;
    case "stores":
      return e.model.profile?.stores ?? null;
    case "area":
      return e.model.profile?.areaWanSqm ?? null;
  }
}

function sorted(entries: LbBoardEntry[], key: SortKey, dir: 1 | -1) {
  return [...entries].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return a.rank - b.rank;
    if (va === null) return 1; // unknown dates and estimates always sink
    if (vb === null) return -1;
    return (va - vb) * dir || a.rank - b.rank;
  });
}

/** The top three sit on a small tinted plate; the rest are plain numbers. */
function Rank({ rank }: { rank: number }) {
  const n = String(rank).padStart(2, "0");
  if (rank <= 3) {
    return <span className="mono inline-flex h-7 w-[26px] items-center justify-center rounded-full bg-accent/[0.06] text-[13px] font-bold text-accent">{n}</span>;
  }
  return <span className="mono text-[13px] text-ink-4">{n}</span>;
}

function SortHeader({ k, children, sort, dir, onSort, align = "left", className = "" }: { k: SortKey; children: ReactNode; sort: SortKey; dir: 1 | -1; onSort: (k: SortKey) => void; align?: "left" | "right"; className?: string }) {
  const active = sort === k;
  return (
    <th scope="col" aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"} className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button type="button" onClick={() => onSort(k)} className={`group/sort inline-flex items-start gap-1 text-left transition-colors hover:text-ink ${active ? "text-accent" : ""}`}>
        <span>{children}</span>
        <span className={`mt-[3px] text-[9px] transition ${active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-40"} ${active && dir === -1 ? "rotate-180" : ""}`} aria-hidden="true">
          ▲
        </span>
      </button>
    </th>
  );
}

/** 创立年份：种子 founded 直显（kb5：上市状态不再占据该列，列语义=品牌诞生时间）。 */
function foundedText(founded: number | null | undefined): string | null {
  return founded != null ? String(founded) : null;
}

// zw13 展示策略：品牌榜每页 15 条翻页；商业体榜全量可见，沿用旧单页密度每页 30 条翻页。
const PAGE_SIZES: Record<string, number> = { brand: 15, mall: 30 };

/** Page numbers to render: first and last always shown, plus a window around the current page. */
function pageSeq(current: number, count: number): Array<number | "…"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const mid = Array.from({ length: 5 }, (_, i) => current - 2 + i).filter((n) => n > 1 && n < count);
  return [1, ...(mid[0] > 2 ? ["…" as const] : []), ...mid, ...(mid[mid.length - 1] < count - 1 ? ["…" as const] : []), count];
}

export function BoardTable({ entries, board }: { entries: LbBoardEntry[]; board: string }) {
  const isBrand = board === "brand";
  const [sort, setSort] = useState<SortKey>("rank");
  const [dir, setDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(1);
  const rows = useMemo(() => sorted(entries, sort, dir), [entries, sort, dir]);
  const pageSize = PAGE_SIZES[board] ?? 30;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = useMemo(() => rows.slice((current - 1) * pageSize, current * pageSize), [rows, current, pageSize]);
  // Re-sorting moves each row from where it was to its new place (FLIP), as rows keep their key.
  const body = useRef<HTMLTableSectionElement>(null);
  const tops = useRef(new Map<string, number>());
  const order = pageRows.map((e) => e.model.slug).join(",");
  useLayoutEffect(() => {
    if (!body.current) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const row of Array.from(body.current.rows)) {
      const key = row.dataset.slug ?? "";
      const prev = tops.current.get(key);
      next.set(key, row.offsetTop);
      if (prev !== undefined && prev !== row.offsetTop && !reduce && row.animate) {
        row.animate([{ transform: `translateY(${prev - row.offsetTop}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
      }
    }
    tops.current = next;
  }, [order]);
  const onSort = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(1);
    }
    setPage(1);
  };
  const text = (v: string | null | undefined) => (v == null || v === "" ? <span className="text-ink-4">—</span> : <span>{v}</span>);
  const numText = (v: number | null | undefined, unitWord = "") =>
    v == null ? <span className="text-ink-4">—</span> : <span className="num">{v.toLocaleString("zh-Hans-CN")}{unitWord}</span>;

  return (
    <>
    <table className="w-full border-collapse text-[14px]">
      <caption className="sr-only">可按列重排的前 {entries.length} 名{isBrand ? "童装品牌" : "商业体"}</caption>
      <thead className="bg-[rgba(28,39,51,0.04)] text-[12px] text-ink-4 dark:bg-white/[0.03]">
        <tr className="border-y border-line">
          <th scope="col" className="w-[44px] py-2.5 pl-4 pr-1 text-left font-medium lg:w-[68px] lg:pl-[22px] lg:pr-3">
            <button type="button" onClick={() => onSort("rank")} className={`transition-colors hover:text-ink ${sort === "rank" ? "text-accent" : ""}`}>
              排名
            </button>
          </th>
          <th scope="col" className="px-2 py-2.5 text-left font-medium lg:px-3">{isBrand ? "品牌" : "商业体名称"}</th>
          {isBrand ? (
            <>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">主营品类</th>
              <th scope="col" className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">价格带 · 年龄段</th>
              <SortHeader k="date" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">创立年份</SortHeader>
            </>
          ) : (
            <>
              <th scope="col" className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">类型/定位</th>
              <th scope="col" className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">所属集团</th>
              <SortHeader k="area" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">面积（万㎡）</SortHeader>
              <SortHeader k="date" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">开业日期</SortHeader>
            </>
          )}
          <SortHeader k="coverage" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">指标覆盖</SortHeader>
          <SortHeader k="revenue" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">年业绩预估（亿元）</SortHeader>
          {isBrand && <SortHeader k="stores" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell">门店规模预估（家）</SortHeader>}
          <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium lg:pl-3 lg:pr-[22px]">
            <button
              type="button"
              onClick={() => onSort("rank")}
              title="共识指数把支持原排名的证据差异换算为 0—100，不是正确率。"
              className={`inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-ink ${sort === "rank" ? "text-accent" : ""}`}
            >
              共识指数 <span className="inline-flex size-3.5 items-center justify-center rounded-full border border-current text-[9px] leading-none">i</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody ref={body}>
        {pageRows.map((e) => (
          <tr key={e.model.slug} data-slug={e.model.slug} className="group relative border-b border-line last:border-b-0 transition-colors hover:bg-accent-softer">
            <td className="py-3 pl-4 pr-1 align-middle lg:pl-[22px] lg:pr-3">
              <Rank rank={e.rank} />
            </td>
            <td className="px-2 py-3 lg:px-3">
              <Link to={modelHref(e.model.slug, board)} prefetch="intent" className="block after:absolute after:inset-0 after:content-['']">
                <span className="flex items-center gap-3">
                  <BrandMark brand={e.model.brand} size={32} />
                  <span className="min-w-0">
                    <strong className="block text-[15px] font-[650] leading-[21px] text-ink transition-colors group-hover:text-accent">{e.model.name}</strong>
                    <small className="block text-[12px] leading-[18px] text-ink-4">{isBrand ? (e.model.provider ?? "—") : [...new Set([e.model.profile?.province, e.model.provider].filter(Boolean))].join(" · ") || "—"}</small>
                  </span>
                </span>
                {/* Phones: the desktop columns as short lines under the whole name block. */}
                <span className="mt-1.5 block text-[12px] leading-[1.7] text-ink-3 lg:hidden">
                  {isBrand ? (
                    <>
                      <span className="block">
                        {e.model.profile?.category ?? "品类待补"}
                        {e.model.profile?.founded != null ? ` · ${e.model.profile.founded} 年创立` : ""}
                      </span>
                      {[e.model.profile?.priceBand, e.model.profile?.ageRange].filter(Boolean).length > 0 && (
                        <span className="block">
                          {[e.model.profile?.priceBand, e.model.profile?.ageRange].filter(Boolean).join(" · ")}
                        </span>
                      )}
                      <span className="block">
                        年业绩 <span className="num">{e.model.profile?.revenueYi != null ? `约 ${e.model.profile.revenueYi} 亿` : "—"}</span>{e.model.profile?.revenueBasis ? <span className="text-[11px] text-ink-4">（{e.model.profile.revenueBasis}）</span> : null} · 门店 <span className="num">{e.model.profile?.stores != null ? `约 ${e.model.profile.stores} 家` : "—"}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block">
                        {[e.model.profile?.mallType, e.model.profile?.positioning, e.model.profile?.groupCompany].filter(Boolean).join(" · ") || "档案待补"}
                      </span>
                      <span className="block">
                        开业 <span className="num">{e.model.profile?.openedAt ?? "—"}</span> · 面积 <span className="num">{e.model.profile?.areaWanSqm != null ? `约 ${e.model.profile.areaWanSqm} 万㎡` : "—"}</span>
                      </span>
                      <span className="block">
                        年业绩 <span className="num">{e.model.profile?.revenueYi != null ? `约 ${e.model.profile.revenueYi} 亿` : "—"}</span>
                      </span>
                    </>
                  )}
                </span>
                {/* rd4 置信级角标：该实体在役维度的数据来源档位。 */}
                <span className="mt-1 block lg:hidden">
                  <TierChips tiers={e.dimensionTiers} dims={Object.keys(e.dimensions ?? {}).filter((k) => e.dimensions?.[k] != null)} />
                </span>
              </Link>
            </td>
            {isBrand ? (
              <>
                <td className="px-3 py-3 text-[12.5px] text-ink-2">{text(e.model.profile?.category)}</td>
                <td className="hidden px-3 py-3 text-[12.5px] text-ink-2 lg:table-cell">{text([e.model.profile?.priceBand, e.model.profile?.ageRange].filter(Boolean).join(" · ") || null)}</td>
                <td className="mono hidden px-3 py-3 text-[12px] text-ink-3 lg:table-cell">{text(foundedText(e.model.profile?.founded))}</td>
              </>
            ) : (
              <>
                <td className="hidden px-3 py-3 text-[12.5px] text-ink-2 lg:table-cell">
                  {e.model.profile?.mallType || e.model.profile?.positioning
                    ? [e.model.profile?.mallType, e.model.profile?.positioning].filter(Boolean).join(" · ")
                    : <span className="text-ink-4">—</span>}
                </td>
                <td className="hidden px-3 py-3 text-[12px] text-ink-3 lg:table-cell">{text(e.model.profile?.groupCompany)}</td>
                <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{numText(e.model.profile?.areaWanSqm)}</td>
                <td className="mono hidden px-3 py-3 text-[12px] text-ink-3 lg:table-cell">{text(e.model.profile?.openedAt)}</td>
              </>
            )}
            <td className="relative z-10 hidden px-3 py-3 lg:table-cell">
              <span className="num block text-[13px] text-ink-2">{e.sourceCount} 项指标</span>
              <EvidenceBadge confidence={e.confidence} stability={e.stability} rank={e.rank} />
              <TierChips tiers={e.dimensionTiers} dims={Object.keys(e.dimensions ?? {}).filter((k) => e.dimensions?.[k] != null)} />
            </td>
            <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{numText(e.model.profile?.revenueYi)}{e.model.profile?.revenueBasis ? <span className="ml-1 font-normal text-[11px] text-ink-4">（{e.model.profile.revenueBasis}）</span> : null}</td>
            {isBrand && <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{numText(e.model.profile?.stores)}</td>}
            <td className="py-3 pl-2 pr-4 text-right align-middle lg:pl-3 lg:pr-[22px]">
              <strong className={`mono inline-block text-[20px] font-semibold leading-7 tracking-[-0.02em] ${e.rank <= 3 ? "text-accent" : "text-ink"}`} aria-label={`${e.model.name} 共识指数 ${e.score.toFixed(1)}`}>
                {e.score.toFixed(1)}
              </strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {pageCount > 1 && (
      <nav aria-label="榜单分页" className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 lg:px-[22px]">
        <span className="num text-[12px] text-ink-4">共 {rows.length} 个 · 每页 {pageSize} 个 · 第 {current}/{pageCount} 页</span>
        <span className="flex items-center gap-1">
          {(() => {
            const btn = "mono inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-line px-2 text-[12.5px] text-ink-3 transition-colors hover:border-ink-4 hover:text-ink disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-3";
            return (
              <>
                <button type="button" disabled={current === 1} onClick={() => setPage(current - 1)} className={btn}>上一页</button>
                {pageSeq(current, pageCount).map((n, i) =>
                  n === "…" ? (
                    <span key={`gap-${i}`} className="px-0.5 text-[12px] text-ink-4">…</span>
                  ) : (
                    <button
                      type="button"
                      key={n}
                      onClick={() => setPage(n)}
                      disabled={n === current}
                      className={n === current ? `${btn} border-accent bg-accent/[0.06] font-semibold text-accent` : btn}
                    >
                      {n}
                    </button>
                  ),
                )}
                <button type="button" disabled={current === pageCount} onClick={() => setPage(current + 1)} className={btn}>下一页</button>
              </>
            );
          })()}
        </span>
      </nav>
    )}
    </>
  );
}
