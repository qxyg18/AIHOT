// 宏观市场 (ka7): the V5 报告阅读版 the owner signed off — 月度速览 + 01–05 编号章节 + 右侧宏观导读.
// All numbers come from /api/site/macro/overview (seeded official series); every derived figure on
// this page (YTD, 环比差, 合计) is computed here from those rows, nothing is hand-written.
import { useLoaderData } from "react-router";
import type { Route } from "./+types/macro";
import { CATEGORY_LABELS, type CategoryKey } from "@aihot/contracts/taxonomy";
import type { MacroIndicator, MacroOverview, MacroRow } from "@aihot/contracts/macro";
import { beijingDate } from "@aihot/contracts/time";
import { apiGet, loadOr404, queryString } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { SITE } from "@aihot/industry/site";
import { AgeBandsChart, AgeSingleChart, AnnualChart, PopulationChart, TrendChart, type TrendSeries } from "../features/macro/MacroCharts";
import { MacroRail, type MacroRailItem } from "../features/macro/MacroRail";

// T14: the row/indicator shapes come from the T01/ym239 frozen shared DTO
// (packages/contracts/src/macro.ts) — no local mirror, web and API consume one contract.
const MACRO_CATEGORIES = ["statistics"] as const;

interface PoolData { items: Array<{ id: string; title: string; timelineAt: string; publishedAt: string | null; category: CategoryKey; source: { name: string } }> }

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60" };
}

export async function loader({ request }: Route.LoaderArgs) {
  const overview = await loadOr404<MacroOverview>("/api/site/macro/overview", { signal: request.signal });
  const pools = await Promise.allSettled(
    MACRO_CATEGORIES.map((c) => apiGet<PoolData>(`/api/site/pool${queryString({ category: c })}`, { signal: request.signal })),
  );
  const seen = new Set<string>();
  const rail: MacroRailItem[] = [];
  for (const r of pools) {
    if (r.status !== "fulfilled") continue;
    for (const it of r.value.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      rail.push({
        id: it.id, title: it.title, sourceName: it.source.name,
        publishedAt: it.publishedAt, timelineAt: it.timelineAt,
        categoryKey: it.category, categoryLabel: CATEGORY_LABELS[it.category] ?? it.category,
      });
    }
  }
  rail.sort((a, b) => (a.timelineAt < b.timelineAt ? 1 : -1));
  return { overview, rail: rail.slice(0, 24), today: beijingDate(new Date().toISOString()) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("宏观市场") }, { name: "robots", content: "noindex" }];
  const k = loaderData.overview.indicators.retail;
  const latest = k?.rows.filter((r) => r.year === Math.max(...k.rows.map((x) => x.year))).at(-1);
  return pageMeta({
    title: "宏观市场",
    description: `童装行业的宏观底座：${latest ? `${latest.period}社零 ${latest.value} 亿元` : "社零、服装、儿童市场与人口"}，五组核心指标与宏观类动态导读。`,
    path: "/macro",
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "宏观市场", path: "/macro" }]),
  });
}

// ── deterministic formatting (no toLocaleString: SSR and hydration must agree) ──────────────
const fmtInt = (v: number) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const fmtYi = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万亿` : `${fmtInt(v)}亿`);
const fmtWan = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(2)}亿` : `${fmtInt(v)}万`);
const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`);

// ── transforms: indicator rows → chart series ──────────────────────────────────────────────
const MONTH_SEQS = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const monthLabel = (seq: number) => (seq === 1 ? "1–2月" : `${seq}月`);

interface TrendView {
  series: TrendSeries; ytd: { value: number; yoy: number; label: string } | null;
  latest: { label: string; value: number; yoy: number | null } | null; prevYoy: number | null;
  unit: string; name: string; caliber: string; sourceName: string; hasPrior: boolean;
}
function toTrend(ind: MacroIndicator | undefined): TrendView | null {
  if (!ind || ind.rows.length === 0) return null;
  const years = [...new Set(ind.rows.map((r) => r.year))].sort();
  const curYear = years[years.length - 1];
  const cur = new Map(ind.rows.filter((r) => r.year === curYear).map((r) => [r.seq, r]));
  const prior = new Map(ind.rows.filter((r) => r.year === curYear - 1).map((r) => [r.seq, r]));
  const seqs = ind.granularity === "quarter" ? [1, 2, 3, 4] : MONTH_SEQS;
  const labelOf = (seq: number) => (ind.granularity === "quarter" ? `Q${seq}` : monthLabel(seq));
  const axis = seqs.map(labelOf);
  const curArr: (number | null)[] = seqs.map((s) => cur.get(s)?.value ?? null);
  const priorArr: (number | null)[] = seqs.map((s) => prior.get(s)?.value ?? null);
  let cutoffIndex: number | null = null;
  for (let i = 0; i < curArr.length; i++) if (curArr[i] != null) cutoffIndex = i;
  const ref: (number | null)[] = curArr.map(() => null);
  if (cutoffIndex != null) {
    ref[cutoffIndex] = curArr[cutoffIndex];
    for (let i = cutoffIndex + 1; i < curArr.length; i++) ref[i] = priorArr[i];
    for (let i = (cutoffIndex ?? 0) + 1; i < priorArr.length; i++) priorArr[i] = null;
  }
  const curRows = seqs.map((s) => cur.get(s)).filter((r) => r != null) as MacroRow[];
  const latestRow = curRows.at(-1) ?? null;
  const prevRow = curRows.length >= 2 ? curRows[curRows.length - 2] : null;
  return {
    series: { axis, cur: curArr, prior: priorArr, ref, cutoffIndex, cutoffLabel: latestRow ? labelOf(latestRow.seq) : "", unit: ind.unit },
    ytd: ind.ytd,
    latest: latestRow ? { label: latestRow.period, value: latestRow.value, yoy: latestRow.yoy } : null,
    prevYoy: prevRow?.yoy ?? null,
    unit: ind.unit, name: ind.name, caliber: ind.caliber, sourceName: ind.sourceName,
    hasPrior: prior.size > 0,
  };
}

function toAnnual(ind: MacroIndicator | undefined) {
  if (!ind || ind.rows.length === 0) return null;
  const rows = [...ind.rows].sort((a, b) => a.year - b.year);
  return { years: rows.map((r) => r.period), values: rows.map((r) => r.value), yoy: rows.map((r) => r.yoy), latest: rows.at(-1)!, unit: ind.unit };
}

// ── derived time facts (T14): years, sample-month counts and unpublished runs all come from the
// rows; the page carries no fixed-calendar prose (no hardcoded "2026年/2025年/9–12月/下半年"). ──
/** Latest year present in an indicator's rows. */
function latestYearOf(ind: MacroIndicator | undefined): number | null {
  if (!ind || ind.rows.length === 0) return null;
  return Math.max(...ind.rows.map((r) => r.year));
}

/** Label of the unpublished tail after the latest published point, e.g. "9月–12月"; null when complete. */
function pendingTail(t: TrendView | null): string | null {
  if (!t || t.series.cutoffIndex == null || t.series.cutoffIndex >= t.series.axis.length - 1) return null;
  return `${t.series.axis[t.series.cutoffIndex + 1]}–${t.series.axis.at(-1)}`;
}

/** Labels of unpublished holes before the latest published point, e.g. ["3月–5月"]; the tail is not a hole. */
function interiorGaps(t: TrendView | null): string[] {
  if (!t || t.series.cutoffIndex == null) return [];
  const gaps: string[] = [];
  let start = -1;
  for (let i = 0; i <= t.series.cutoffIndex; i++) {
    const hole = t.series.cur[i] == null;
    if (hole && start < 0) start = i;
    if (!hole && start >= 0) {
      gaps.push(start === i - 1 ? t.series.axis[start] : `${t.series.axis[start]}–${t.series.axis[i - 1]}`);
      start = -1;
    }
  }
  return gaps;
}

/** How many points of the prior year are actually drawn. */
function priorDrawnCount(t: TrendView | null): number {
  return t ? t.series.prior.filter((v) => v != null).length : 0;
}

// ── page ───────────────────────────────────────────────────────────────────────────────────
export default function MacroPage() {
  const { overview, rail, today } = useLoaderData<typeof loader>();
  const ind = overview.indicators;

  const retail = toTrend(ind.retail);
  const apparel = toTrend(ind.apparel);
  const kidsTrend = ind.kids?.granularity === "quarter" || ind.kids?.granularity === "month" ? toTrend(ind.kids) : null;
  const kidsAnnual = kidsTrend ? null : toAnnual(ind.kids);
  const birth = ind["population-birth"];
  const net = ind["population-net"];
  const popYears = birth ? [...birth.rows].sort((a, b) => a.year - b.year) : [];
  const netByYear = new Map((net?.rows ?? []).map((r) => [r.year, r.value]));
  const ageSingle = [...(ind["age-single"]?.rows ?? [])].sort((a, b) => a.seq - b.seq);
  const ageBands = [...(ind["age-bands"]?.rows ?? [])].sort((a, b) => a.seq - b.seq);
  const ageSummaryRows = ind["age-summary"]?.rows ?? [];
  const ageSummary = new Map(ageSummaryRows.map((r) => [r.period, r.value]));
  const ageSummaryYear = ageSummaryRows.find((r) => r.period === "0–15岁")?.year ?? null;
  const lastBirth = popYears.at(-1);
  const prevBirth = popYears.at(-2);
  const lastNet = lastBirth ? netByYear.get(lastBirth.year) : undefined;
  const birthYoy = lastBirth && prevBirth ? (lastBirth.value / prevBirth.value - 1) * 100 : null;
  const kidsLatest = kidsAnnual?.latest ?? null;
  // Calendar facts derived from the rows themselves (T14): which year the data runs to, which
  // months are still unpublished, how many prior-year points are drawn.
  const retailYear = latestYearOf(ind.retail);
  const apparelYear = latestYearOf(ind.apparel);
  const apparelPriorYear = apparelYear != null ? apparelYear - 1 : null;
  const retailTail = pendingTail(retail);
  const apparelTail = pendingTail(apparel);
  const apparelGaps = interiorGaps(apparel);
  const retailPublishedMonths = retail ? retail.series.cur.filter((v) => v != null).length : 0;
  // How many consecutive years the birth-death balance has been negative, counted from the latest year.
  let netNegStreak = 0;
  for (let i = popYears.length - 1; i >= 0; i--) {
    if ((netByYear.get(popYears[i].year) ?? 0) < 0) netNegStreak++;
    else break;
  }

  const stats: Array<{ label: string; value: string; delta: string | null; down?: boolean; note?: string }> = [
    retail?.latest
      ? { label: `社零 · ${retail.latest.label}`, value: `${fmtInt(retail.latest.value)}`, delta: `${pct(retail.latest.yoy)} 同比`, down: (retail.latest.yoy ?? 0) < 0 }
      : { label: "社零", value: "调研中", delta: null },
    apparel?.ytd
      ? { label: `服装类 · ${apparel.ytd.label}`, value: `${fmtInt(apparel.ytd.value)}`, delta: `${pct(apparel.ytd.yoy)} 同比`, down: apparel.ytd.yoy < 0 }
      : { label: "服装类", value: "调研中", delta: null },
    kidsLatest
      ? { label: `童装市场 · ${kidsLatest.period}年`, value: `${fmtInt(kidsLatest.value)}`, delta: kidsLatest.yoy != null ? `${pct(kidsLatest.yoy)} 同比` : null, down: (kidsLatest.yoy ?? 0) < 0, note: "机构估算" }
      : { label: "童装市场", value: "调研中", delta: null },
    lastBirth
      ? { label: `出生人口 · ${lastBirth.period}年`, value: `${fmtInt(lastBirth.value)}`, delta: `${pct(birthYoy)} 同比`, down: (birthYoy ?? 0) < 0 }
      : { label: "出生人口", value: "调研中", delta: null },
    ageSummary.get("0–15岁") != null
      ? { label: "0–15岁人口", value: fmtWan(ageSummary.get("0–15岁")!), delta: null, note: "统计公报表1" }
      : ageSingle.length > 0
        ? { label: "0–16岁人口", value: fmtWan(ageSingle.reduce((s, r) => s + r.value, 0)), delta: null, note: "分年龄合计" }
        : { label: "0–15岁人口", value: "调研中", delta: null },
  ];

  const heroLead =
    retail?.latest && retail.latest.yoy != null
      ? `${retail.latest.label}社零同比 ${pct(retail.latest.yoy)}${retail.prevYoy != null ? `（上月 ${pct(retail.prevYoy)}）` : ""}`
      : "社零、服装、童装市场与人口";
  const heroMid = apparel?.ytd ? `服装类年内累计 ${pct(apparel.ytd.yoy)}${retail?.ytd ? `，跑赢大盘 ${Math.max(0, apparel.ytd.yoy - retail.ytd.yoy).toFixed(1)}pct` : ""}` : "";
  const heroEnd = lastBirth && lastNet != null ? `${lastBirth.period}年出生 ${fmtInt(lastBirth.value)} 万、人口净${lastNet >= 0 ? "增" : "减"} ${fmtInt(Math.abs(lastNet))} 万` : "";
  const heroTitle = [heroLead, heroMid, heroEnd].filter(Boolean).join("；");

  return (
    <div className="pb-8">
      <header className="pb-4 pt-5 lg:pt-1">
        <p className="mb-2 text-[12.5px] font-bold tracking-[3px] text-accent">宏观市场 · 月度速览</p>
        <h1 className="max-w-[760px] text-[24px] font-extrabold leading-[1.4] tracking-tight text-ink">{heroTitle}。</h1>
        <p className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-4">
          <span>{SITE.name} · 宏观编辑部</span>
          <span>更新 {today}</span>
          <span>数据截至 {retail?.latest && retailYear != null ? `${retailYear}年${retail.latest.label}` : "见各图"}（人口为{lastBirth?.period ?? "最新"}年度）</span>
          <span>本期导读 {rail.length} 篇</span>
        </p>
      </header>

      <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s, i) => (
              <div key={s.label} className={`px-4 py-3 ${i > 0 ? "border-l border-line" : "pl-0"} first:pl-0`}>
                <p className="text-[11.5px] text-ink-4">{s.label}</p>
                <p className="my-0.5 text-[20px] font-bold tabular-nums text-ink">
                  {s.value}
                  {/\d$/.test(s.value) && <small className="ml-0.5 text-[11px] font-medium text-ink-3">{s.label.includes("人口") ? "万" : "亿"}</small>}
                </p>
                <p className={`text-[11.5px] ${s.down ? "text-hot" : s.delta ? "text-ok" : "text-ink-4"}`}>
                  {s.delta ?? s.note ?? ""}
                </p>
              </div>
            ))}
          </div>

          <Section no="01" title={retail?.name ?? "社会消费品零售总额"} sub="当月值 · 亿元 · 1–2月合并 · 国家统计局" pill={retail?.ytd ? ytdPill(retail.ytd) : null}
            chart={retail ? (
              <>
                <TrendChart series={retail.series} />
                <ChartNote
                  left={`${retailTail ? `${retailTail}未发布，` : ""}青色虚线为去年同期走势参考${retail.series.prior.some((v) => v != null) ? "" : "（同期值整理中）"}`}
                  right="来源：国家统计局月度发布"
                />
              </>
            ) : <Pending />}
            read={<ReadCard bullets={retail?.latest ? [
              <>「{retail.latest.label}」社零 <b>{fmtInt(retail.latest.value)} 亿元</b>，同比 {pct(retail.latest.yoy)}{retail.prevYoy != null && retail.latest.yoy != null ? `，较上月${retail.latest.yoy >= retail.prevYoy ? "回升" : "回落"} ${Math.abs(retail.latest.yoy - retail.prevYoy).toFixed(1)}pct` : ""}。</>,
              retail.ytd ? <>{retail.ytd.label} <b>{fmtYi(retail.ytd.value)} · YTD {pct(retail.ytd.yoy)}</b>，年内已发布 {retailPublishedMonths} 个月。</> : null,
              retailTail ? <>{retailTail}走势看青色虚线（去年同期参考），统计局逐月发布后自动替换为实线。</> : null,
            ] : ["数据调研中"]} />}
          />

          <Section no="02" title={apparel?.name ?? "服装类零售额"} sub="限额以上当月值 · 亿元 · 国家统计局" pill={apparel?.ytd ? ytdPill(apparel.ytd) : null}
            chart={apparel ? (
              <>
                <TrendChart series={apparel.series} />
                {apparelGaps.length > 0 && (
                  <p className="mb-1 mt-0.5 rounded-control bg-bg-sunk px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-4">
                    ⓘ {apparelGaps.join("、")}官方未单独披露当月值（只发增速），曲线如实留洞；合计值以官方累计发布口径为准，本页不另补数
                  </p>
                )}
                <ChartNote left={`${apparelTail ? `${apparelTail}青色虚线为` : "青色虚线为"}${apparelPriorYear != null ? apparelPriorYear : "上年"}年原发布值同期参考（存在统计局常规基数修订台阶）`} right="来源：国家统计局月度发布" />
              </>
            ) : <Pending />}
            read={<ReadCard bullets={apparel?.ytd && retail?.ytd ? [
              <>服装类{apparel.ytd.label}累计 <b>{fmtInt(apparel.ytd.value)} 亿元 · YTD {pct(apparel.ytd.yoy)}</b>，{apparel.ytd.yoy >= retail.ytd.yoy ? <>跑赢社零大盘 <b>{(apparel.ytd.yoy - retail.ytd.yoy).toFixed(1)}pct</b></> : <>落后大盘 {(retail.ytd.yoy - apparel.ytd.yoy).toFixed(1)}pct</>}。</>,
              apparel.latest ? <>最新发布月（{apparel.latest.label}）当月 {fmtInt(apparel.latest.value)} 亿元，同比 {pct(apparel.latest.yoy)}；{apparelPriorYear != null ? `${apparelPriorYear}年` : "上年"}同期已画 {priorDrawnCount(apparel)} 个月{apparelTail ? `，其中 ${apparelTail} 为原发布值` : ""}。</> : null,
              <>该口径只统计达到限额标准的单位，增速比绝对值更可信。</>,
            ] : ["数据调研中"]} />}
          />

          <Section no="03" title={ind.kids?.name ?? "童装市场规模"} sub={ind.kids?.caliber ?? "机构估算口径 · 只看趋势"} pill={kidsTrend?.ytd ? ytdPill(kidsTrend.ytd) : null}
            chart={kidsTrend ? (
              <>
                <TrendChart series={kidsTrend.series} />
                <ChartNote left="未发布季度画去年同期作参考（青色虚线）" right={`来源：${ind.kids?.sourceName ?? "机构研报"}`} />
              </>
            ) : kidsAnnual ? (
              <>
                <AnnualChart years={kidsAnnual.years} values={kidsAnnual.values} yoy={kidsAnnual.yoy} unit={kidsAnnual.unit} />
                <ChartNote left="机构估算口径，数值随研报更新" right={`来源：${ind.kids?.sourceName ?? "机构研报"}`} />
              </>
            ) : <Pending />}
            read={<ReadCard bullets={kidsAnnual ? [
              <>最新估算 {kidsAnnual.latest.period}年 <b>{fmtInt(kidsAnnual.latest.value)} 亿元</b>{kidsAnnual.latest.yoy != null ? <>，同比 {pct(kidsAnnual.latest.yoy)}</> : null}。</>,
              <>机构口径互有出入，<b>只看趋势、不锁绝对值</b>。</>,
            ] : ["童装市场规模正在核对机构研报口径，先不展示数字"]} />}
          />

          <Section no="04" title="人口新增与净增" sub={`年度 · 万人 · ${birth?.sourceName ?? "国家统计局年度公报"}`}
            pill={lastBirth && lastNet != null ? <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${lastNet >= 0 ? "bg-ok-soft text-ok" : "bg-hot-soft text-hot"}`}>{lastBirth.period}年净{lastNet >= 0 ? "增" : "减"} {fmtInt(Math.abs(lastNet))}万</span> : null}
            chart={popYears.length > 0 ? (
              <>
                <PopulationChart years={popYears.map((r) => r.period)} birth={popYears.map((r) => r.value)} net={popYears.map((r) => netByYear.get(r.year) ?? null)} />
                <ChartNote left={`净增 = 当年出生 − 当年死亡${lastBirth && lastNet != null ? `（${lastBirth.period}年死亡 ${fmtInt(lastBirth.value - lastNet)} 万）` : ""}`} right="来源：历年统计公报" />
              </>
            ) : <Pending />}
            read={<ReadCard bullets={lastBirth && lastNet != null ? [
              <>{lastBirth.period}年出生 <b>{fmtInt(lastBirth.value)} 万</b>{birthYoy != null ? <>，同比 {pct(birthYoy)}</> : null}。</>,
              <>人口净{lastNet >= 0 ? "增" : "减"} <b>{fmtInt(Math.abs(lastNet))} 万</b>{netNegStreak > 1 ? `，连续 ${netNegStreak} 年为负` : ""}（出生−死亡口径）。</>,
              <>出生人口是童装需求的第一先行指标，0 岁 cohort 直接对应婴幼儿线市场容量。</>,
            ] : ["数据调研中"]} />}
          />

          <Section no="05" title="人口年龄结构分布" sub={ind["age-single"]?.caliber ?? "0–16岁每1岁 · 17岁以上分段"} pill={ageSummary.get("0–15岁") != null ? <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-ok">0–15岁 {fmtWan(ageSummary.get("0–15岁")!)}</span> : null}
            chart={ageSingle.length > 0 || ageBands.length > 0 ? (
              <div className="grid gap-3.5 lg:grid-cols-[11fr_9fr]">
                {ageSingle.length > 0 && <div><p className="mb-1 text-[12px] text-ink-4">0–16 岁 · 逐岁</p><AgeSingleChart labels={ageSingle.map((r) => r.period)} values={ageSingle.map((r) => r.value)} /></div>}
                {ageBands.length > 0 && <div><p className="mb-1 text-[12px] text-ink-4">17 岁以上 · 分段</p><AgeBandsChart labels={ageBands.map((r) => r.period)} values={ageBands.map((r) => r.value)} /></div>}
              </div>
            ) : <Pending />}
            read={<ReadCard bullets={[
              ageSummary.get("0–15岁") != null
                ? <>0–15 岁 <b>{fmtWan(ageSummary.get("0–15岁")!)}</b>{ageSummaryYear != null ? `（${ageSummaryYear} 年统计公报表1）` : "（统计公报表1）"}，童装核心客群基本盘。</>
                : ageSingle.length > 0 ? <>0–16 岁合计约 <b>{fmtWan(ageSingle.reduce((s, r) => s + r.value, 0))}</b>（{ind["age-single"]?.caliber ?? "推算口径"}）。</> : null,
              (() => {
                if (ageSingle.length === 0) return null;
                const peak = ageSingle.reduce((a, b) => (b.value > a.value ? b : a));
                return <>逐岁峰值在 <b>{peak.period}（{fmtInt(peak.value)} 万）</b>，越低龄 cohort 越小，婴幼儿线长期承压。</>;
              })(),
              (() => {
                if (ageBands.length === 0) return null;
                const top = ageBands.reduce((a, b) => (b.value > a.value ? b : a));
                return <>分段最大组为 <b>{top.period} · {fmtWan(top.value)}</b>。</>;
              })(),
            ]} />}
          />

          <p className="mt-5 px-0.5 py-1 text-[11px] leading-[1.8] text-ink-4">
            <b className="text-ink-3">数据说明</b> · 社零/服装类来自国家统计局月度发布（次月中旬更新），1–2月为合并口径；部分同期值为「官方当月值 ÷（1+官方同比）」反推（图表口径注记已标）；人口为年度统计公报；年龄结构口径见图内说明；童装市场规模为机构估算。宏观导读文章来自{SITE.name}童装动态信源的「{CATEGORY_LABELS[MACRO_CATEGORIES[0]]}」（{MACRO_CATEGORIES.join("/")}）类自动归组。
          </p>
        </div>

        <aside className="w-full shrink-0 self-start lg:sticky lg:top-4 lg:w-[316px]">
          <MacroRail items={rail} today={today} />
        </aside>
      </div>
    </div>
  );
}

// ── small presentational helpers ───────────────────────────────────────────────────────────
function ytdPill(ytd: { value: number; yoy: number; label: string }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${ytd.yoy >= 0 ? "bg-ok-soft text-ok" : "bg-hot-soft text-hot"}`}>{ytd.label} {fmtYi(ytd.value)} · YTD {pct(ytd.yoy)}</span>;
}

function Section({ no, title, sub, pill, chart, read }: { no: string; title: string; sub: string; pill: React.ReactNode; chart: React.ReactNode; read: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] font-extrabold tracking-widest text-accent tabular-nums">{no}</span>
        <h2 className="text-[18px] font-extrabold tracking-tight text-ink">{title}</h2>
        <span className="text-[12px] text-ink-4">{sub}</span>
        <span className="ml-auto">{pill}</span>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        <div className="min-w-0 flex-[1.55] rounded-panel border border-line bg-surface px-4 pb-1.5 pt-3">{chart}</div>
        <div className="min-w-0 flex-1">{read}</div>
      </div>
    </section>
  );
}

function ChartNote({ left, right }: { left: string; right: string }) {
  return (
    <p className="mt-0.5 flex flex-wrap justify-between gap-x-3 border-t border-dashed border-line px-0.5 pb-1 pt-1.5 text-[11px] text-ink-4">
      <span>{left}</span>
      <span>{right}</span>
    </p>
  );
}

function ReadCard({ bullets }: { bullets: React.ReactNode[] }) {
  const items = bullets.filter(Boolean);
  return (
    <div className="min-w-0 flex-1 rounded-panel border border-line bg-accent-softer px-4 py-3.5">
      <h3 className="mb-2 text-[12px] font-bold tracking-widest text-accent">本期解读 · 按最新数据生成</h3>
      <ul className="flex flex-col gap-2">
        {items.map((b, i) => (
          <li key={i} className="relative rounded-tile pl-3.5 text-[12.5px] leading-[1.65] text-ink-3 before:absolute before:left-0 before:top-[8px] before:size-[5px] before:rounded-full before:bg-accent">
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pending() {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-1.5 text-ink-4">
      <p className="text-[13px] font-medium">数据调研中</p>
      <p className="text-[11.5px]">该序列的权威来源还在逐项核对，核对完成前不展示数字</p>
    </div>
  );
}
