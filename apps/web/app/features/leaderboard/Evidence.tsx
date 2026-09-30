import type { LbConfidence, LbSourceTier, LbStability } from "@aihot/contracts/leaderboard";
import { LB_CONFIDENCE_LABELS, LB_DIMENSION_LABELS, LB_SOURCE_TIER_LABELS } from "@aihot/contracts/leaderboard";

const DOT: Record<LbConfidence, string> = {
  HIGH: "bg-ok",
  MEDIUM: "bg-accent",
  LOW: "bg-amber",
};

const TIER_DOT: Record<LbSourceTier, string> = {
  machine: "bg-ok",
  report: "bg-accent",
  seed: "bg-amber",
};

/** rd4 置信级角标：实体的维度 → 数据来源档位（机器源＞研报提取＞人工种子），只展示传入且在役的维度。 */
export function TierChips({ tiers, dims }: { tiers: Record<string, string> | null; dims?: string[] }) {
  if (!tiers) return null;
  const keys = Object.keys(tiers).filter((k) => (dims ? dims.includes(k) : true) && tiers[k]);
  if (!keys.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
      {keys.map((k) => {
        const t = tiers[k] as LbSourceTier;
        return (
          <small key={k} className="inline-flex items-center gap-1 text-[10.5px] leading-[16px] text-ink-4">
            <span className={`size-[5px] shrink-0 rounded-full ${TIER_DOT[t] ?? "bg-ink-4"}`} aria-hidden="true" />
            {LB_DIMENSION_LABELS[k] ?? k}·{LB_SOURCE_TIER_LABELS[t] ?? t}
          </small>
        );
      })}
    </span>
  );
}

function rangeText(s: LbStability): string {
  return s.from === s.to ? `第 ${s.from} 名` : `${s.from}—${s.to} 名`;
}

/** Confidence as a dotted label. On desktop, hovering a sensitive ranking shows its scenario rank range. */
export function EvidenceBadge({ confidence, stability, rank }: { confidence: LbConfidence; stability: LbStability | null; rank: number }) {
  const label = LB_CONFIDENCE_LABELS[confidence];
  const chip = (
    <small className="inline-flex items-center gap-1.5 text-[11px] leading-[17px] text-ink-4">
      <span className={`size-[5px] shrink-0 rounded-full ${DOT[confidence]}`} aria-hidden="true" />
      {label}
    </small>
  );
  if (!stability) return chip;
  const moved = stability.from !== stability.to || stability.unavailable > 0 || stability.incomplete > 0;
  return (
    <span className="group/tip relative inline-flex" tabIndex={moved ? 0 : -1}>
      {chip}
      {moved && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-56 -translate-x-1/2 rounded-tile border border-line bg-raised p-3 text-left text-[12px] leading-relaxed text-ink-2 opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover/tip:opacity-100 group-focus/tip:opacity-100 md:block"
        >
          <span className="block text-[11px] text-ink-4">名次浮动范围</span>
          <span className="num block text-[15px] font-semibold text-ink">{rangeText(stability)}</span>
          <span className="mt-1.5 block text-ink-3">
            在 {stability.scenarios} 个对照情景中重新检查资格后的名次。
            {stability.unavailable > 0 && ` ${stability.unavailable} 个情景下参评证据不足。`}
            不是置信区间。
          </span>
        </span>
      )}
    </span>
  );
}
