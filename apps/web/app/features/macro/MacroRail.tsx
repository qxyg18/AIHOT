// 宏观导读 rail (ka7): category chips + article list, fed by the /macro loader from the site pool
// (statistics / market / research / policy are the macro-relevant categories of the site taxonomy).
import { useState } from "react";
import { Link } from "react-router";
import { dayLabel } from "../../lib/format";

export interface MacroRailItem {
  id: string;
  title: string;
  sourceName: string;
  publishedAt: string | null;
  timelineAt: string;
  categoryKey: string;
  categoryLabel: string;
}

export function MacroRail({ items, today }: { items: MacroRailItem[]; today: string }) {
  const [active, setActive] = useState("all");
  const cats = [
    { key: "all", label: "全部" },
    ...[...new Set(items.map((i) => i.categoryKey))].map((key) => ({
      key,
      label: items.find((i) => i.categoryKey === key)!.categoryLabel,
    })),
  ];
  const shown = active === "all" ? items : items.filter((i) => i.categoryKey === active);

  return (
    <div className="flex flex-col gap-3.5">
      <section className="rounded-card border border-line bg-surface px-4 py-3.5">
        <h2 className="mb-2.5 flex items-center gap-2 text-[13.5px] font-bold text-ink">
          <span className="h-[13px] w-[3px] rounded-sm bg-accent" aria-hidden />
          宏观导读分类
          <span className="ml-auto text-[11px] font-normal text-ink-4">童装动态 · 宏观类</span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {cats.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActive(c.key)}
              className={`h-7 rounded-full px-3 text-[13px] font-medium transition-colors ${
                active === c.key ? "bg-accent font-semibold text-accent-contrast" : "border border-line-strong bg-surface text-ink-3 hover:border-accent hover:text-accent"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface px-4 py-3.5">
        <h2 className="mb-1 flex items-center gap-2 text-[13.5px] font-bold text-ink">
          <span className="h-[13px] w-[3px] rounded-sm bg-accent" aria-hidden />
          宏观文章导读
          <span className="ml-auto text-[11px] font-normal text-ink-4">{shown.length} 篇 · 近30天</span>
        </h2>
        <ul className="list-none">
          {shown.slice(0, 12).map((n) => (
            <li key={n.id} className="border-t border-line py-2.5 first:border-t-0 first:pt-1.5">
              <Link to={`/items/${n.id}`} className="group block">
                <p className="text-[13px] font-medium leading-[1.5] text-ink group-hover:text-accent">{n.title}</p>
                <p className="mt-0.5 flex gap-2 text-[11px] text-ink-4">
                  <span className="font-semibold text-accent">{n.categoryLabel}</span>
                  <span>{n.sourceName}</span>
                  <span>{dayLabel(n.timelineAt.slice(0, 10), today)}</span>
                </p>
              </Link>
            </li>
          ))}
          {shown.length === 0 && <li className="py-4 text-center text-[12.5px] text-ink-4">暂无该类文章</li>}
        </ul>
        <Link to="/all?category=statistics" className="block border-t border-line pt-2.5 text-center text-[12.5px] font-semibold text-accent">
          查看全部宏观动态 →
        </Link>
      </section>
    </div>
  );
}
