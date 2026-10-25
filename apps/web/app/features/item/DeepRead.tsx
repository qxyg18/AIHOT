import type { SiteDeepRead } from "@aihot/contracts/site";

const ANGLE_LABEL: Record<SiteDeepRead["angle"], string> = {
  history: "结合站内历史",
  analogy: "类比解读",
  direct: "直接解读",
  macro: "大盘解读",
};

/** 深解读（ka4）：给不点开原文的读者的一段大白话——站内历史与档案支撑，写法按依据标注；
 *  无解读（无品牌/商业体/大盘信号）时不渲染，AI 导读保持唯一文案。 */
export function DeepRead({ read }: { read: SiteDeepRead | null }) {
  if (!read) return null;
  return (
    <section className="mt-5 rounded-tile border border-accent/30 bg-accent-softer px-4 py-3.5 lg:px-5">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-accent">
        深解读 · 不点原文也能懂
        <span className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[11px] font-normal text-ink-3">{ANGLE_LABEL[read.angle]}</span>
      </div>
      <p className="mt-1.5 text-[15.5px] leading-[1.85] text-ink-2">{read.interpretation}</p>
      {read.entities.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-4">依据本站历史：{read.entities.map((e) => e.name).join("、")}</p>
      )}
    </section>
  );
}
