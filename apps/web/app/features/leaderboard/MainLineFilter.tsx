import { Link, useSearchParams } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";

// rd13 品牌榜主营筛选：开关芯片带 hide= 参数整榜重查（服务端过滤防展示截断漏行），名次保持总榜口径。
const LINES = [
  { key: "运动童装", label: "隐藏运动童装" },
  { key: "童鞋", label: "隐藏童鞋" },
];

export function MainLineFilter({ active }: { active: string[] }) {
  const [searchParams] = useSearchParams();
  const toggleHref = (key: string) => {
    const next = new URLSearchParams(searchParams);
    const current = (next.get("hide") ?? "").split(",").filter(Boolean);
    const nextLines = current.includes(key) ? current.filter((line) => line !== key) : [...current, key];
    if (nextLines.length) next.set("hide", nextLines.join(","));
    else next.delete("hide");
    const query = next.toString();
    return query ? `?${query}` : "?";
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3 lg:px-[22px]">
      <span className="text-[12px] text-ink-4">主营筛选</span>
      {LINES.map(({ key, label }) => {
        const on = active.includes(key);
        return (
          <IntentLink
            key={key}
            to={toggleHref(key)}
            replace
            aria-pressed={on}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors ${
              on ? "border-accent bg-accent/[0.06] font-medium text-accent" : "border-line text-ink-3 hover:border-ink-4 hover:text-ink"
            }`}
          >
            {on ? "✓" : ""}
            {label}
          </IntentLink>
        );
      })}
      {active.length > 0 && <span className="text-[12px] text-ink-4">已隐藏勾选主营的品牌，名次保持总榜口径</span>}
    </div>
  );
}
