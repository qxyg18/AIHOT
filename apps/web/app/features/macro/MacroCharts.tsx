// Client-side ECharts wrappers for the 宏观市场 page (ka7). All numbers arrive as props from the
// server loader; these components only draw. The palette is read from the site's CSS variables so
// the light/dark themes both stay on brand.
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsType } from "echarts/core";
import { useCallback, useEffect, useRef, useState } from "react";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

interface Palette { accent: string; ink3: string; ink4: string; line: string; ok: string; hot: string; amber: string }

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--accent", "#176b75"), ink3: v("--ink-3", "#59656b"), ink4: v("--ink-4", "#657176"),
    line: v("--line", "#dfe4e1"), ok: v("--ok", "#2f7d5c"), hot: v("--hot", "#b3402a"), amber: v("--amber", "#b8873a"),
  };
}

function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(() => ({ accent: "#176b75", ink3: "#59656b", ink4: "#657176", line: "#dfe4e1", ok: "#2f7d5c", hot: "#b3402a", amber: "#b8873a" }));
  useEffect(() => {
    const apply = () => setPalette(readPalette());
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return palette;
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function EChart({ build, height, deps }: { build: (p: Palette) => echarts.EChartsCoreOption; height: string; deps: unknown[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const palette = usePalette();
  const buildRef = useRef(build);
  buildRef.current = build;

  const draw = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(el);
      const chart = chartRef.current;
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(el);
      (chart as unknown as { __ro?: ResizeObserver }).__ro = ro;
    }
    chartRef.current.setOption(buildRef.current(palette), true);
  }, [palette]);

  useEffect(() => {
    draw();
    return () => {
      const chart = chartRef.current;
      const ro = (chart as unknown as { __ro?: ResizeObserver } | null)?.__ro;
      ro?.disconnect();
      chart?.dispose();
      chartRef.current = null;
    };
  }, [draw, ...deps]);

  return <div ref={ref} style={{ height }} className="w-full" aria-hidden />;
}

const baseGrid = { left: 6, right: 14, top: 34, bottom: 2, containLabel: true };
function axisStyle(p: Palette) {
  return {
    axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false as const },
    axisLabel: { color: p.ink3, fontSize: 11.5 },
  };
}

/** 本年 vs 去年同期 + 未发布月同期参考（走势图，月度/季度共用）。 */
export interface TrendSeries {
  axis: string[]; cur: (number | null)[]; prior: (number | null)[]; ref: (number | null)[];
  cutoffIndex: number | null; cutoffLabel: string; unit: string;
}
export function TrendChart({ series }: { series: TrendSeries }) {
  return <EChart height="280px" deps={[series]} build={(p) => ({
    animation: false,
    grid: baseGrid,
    tooltip: { trigger: "axis" },
    legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, itemGap: 18, textStyle: { color: p.ink3, fontSize: 12 } },
    xAxis: { type: "category", data: series.axis, boundaryGap: false, ...axisStyle(p) },
    yAxis: { type: "value", name: series.unit, nameTextStyle: { color: p.ink4 }, splitLine: { lineStyle: { color: p.line } }, ...axisStyle(p) },
    series: [
      { name: "本年", type: "line", smooth: 0.35, symbol: "circle", symbolSize: 6, data: series.cur,
        lineStyle: { width: 2.6, color: p.accent }, itemStyle: { color: p.accent, borderColor: "#fff", borderWidth: 1.5 },
        areaStyle: { color: withAlpha(p.accent, 0.09) },
        ...(series.cutoffIndex === null ? {} : {
          markLine: { silent: true, symbol: ["none", "none"], lineStyle: { type: [3, 3], color: p.line, width: 1 },
            data: [{ xAxis: series.cutoffIndex }],
            label: { show: true, formatter: `数据截至 ${series.cutoffLabel}`, position: "insideEndTop", fontSize: 10, color: p.ink4 } },
        }) },
      { name: "同期参考（未发布月）", type: "line", smooth: 0.35, symbol: "circle", symbolSize: 4, data: series.ref,
        lineStyle: { width: 2.2, color: p.accent, type: [6, 4], opacity: 0.7 }, itemStyle: { color: p.accent } },
      { name: "去年同期", type: "line", smooth: 0.35, symbol: "circle", symbolSize: 4, data: series.prior,
        lineStyle: { width: 1.8, color: "#8fa9ac", type: [5, 4] }, itemStyle: { color: "#8fa9ac" } },
    ],
  })} />;
}

/** 出生（柱）+ 净增（线），万人。 */
export function PopulationChart({ years, birth, net }: { years: string[]; birth: number[]; net: (number | null)[] }) {
  return <EChart height="280px" deps={[years, birth, net]} build={(p) => ({
    animation: false,
    grid: baseGrid,
    tooltip: { trigger: "axis" },
    legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, itemGap: 18, textStyle: { color: p.ink3, fontSize: 12 } },
    xAxis: { type: "category", data: years, ...axisStyle(p) },
    yAxis: { type: "value", name: "万人", nameTextStyle: { color: p.ink4 }, splitLine: { lineStyle: { color: p.line } }, ...axisStyle(p) },
    series: [
      { name: "出生人口", type: "bar", barWidth: "52%", data: birth, itemStyle: { color: p.accent, borderRadius: [3, 3, 0, 0] } },
      { name: "人口净增", type: "line", smooth: 0.3, symbol: "circle", symbolSize: 6, data: net,
        lineStyle: { width: 2.2, color: p.amber }, itemStyle: { color: p.amber } },
    ],
  })} />;
}

/** 年度规模（柱）+ 同比（线），机构估算类指标用。 */
export function AnnualChart({ years, values, yoy, unit }: { years: string[]; values: number[]; yoy: (number | null)[]; unit: string }) {
  return <EChart height="280px" deps={[years, values, yoy]} build={(p) => ({
    animation: false,
    grid: baseGrid,
    tooltip: { trigger: "axis" },
    legend: yoy.some((v) => v !== null) ? { top: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: p.ink3, fontSize: 12 } } : undefined,
    xAxis: { type: "category", data: years, ...axisStyle(p) },
    yAxis: { type: "value", name: unit, nameTextStyle: { color: p.ink4 }, splitLine: { lineStyle: { color: p.line } }, ...axisStyle(p) },
    series: [
      { name: "规模", type: "bar", barWidth: "50%", data: values, itemStyle: { color: p.accent, borderRadius: [3, 3, 0, 0] } },
      ...(yoy.some((v) => v !== null) ? [{ name: "同比 %", type: "line" as const, smooth: 0.3, symbol: "circle", symbolSize: 6, data: yoy,
        lineStyle: { width: 2.2, color: p.amber }, itemStyle: { color: p.amber } }] : []),
    ],
  })} />;
}

/** 0–16 岁逐岁（柱）。 */
export function AgeSingleChart({ labels, values }: { labels: string[]; values: number[] }) {
  return <EChart height="260px" deps={[labels, values]} build={(p) => ({
    animation: false,
    grid: { ...baseGrid, right: 10 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: labels, ...axisStyle(p), axisLabel: { color: p.ink3, fontSize: 10, interval: 1, rotate: 45 } },
    yAxis: { type: "value", name: "万人", nameTextStyle: { color: p.ink4 }, splitLine: { lineStyle: { color: p.line } }, ...axisStyle(p) },
    series: [{ type: "bar", barWidth: "66%", data: values, itemStyle: { color: p.accent, borderRadius: [2, 2, 0, 0] } }],
  })} />;
}

/** 17 岁以上分段（横向条，值标「亿」；横轴数值标签关闭，读数全靠条尾标签）。 */
export function AgeBandsChart({ labels, values }: { labels: string[]; values: number[] }) {
  return <EChart height="280px" deps={[labels, values]} build={(p) => ({
    animation: false,
    grid: { ...baseGrid, right: 62 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "value", ...axisStyle(p), axisLabel: { show: false }, splitLine: { lineStyle: { color: withAlpha(p.line, 0.5) } } },
    yAxis: { type: "category", inverse: true, data: labels, ...axisStyle(p) },
    series: [{ type: "bar", barWidth: "58%", data: values, itemStyle: { color: p.accent, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", fontSize: 10.5, color: p.ink4, formatter: (d: { value: number }) => `${(d.value / 10000).toFixed(1)}亿` } }],
  })} />;
}
