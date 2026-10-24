import type { SiteInsight } from "@aihot/contracts/site";
import { RailSection } from "../../components/ui/Page";

const KIND_LABEL: Record<SiteInsight["kind"], string> = {
  rating: "评级",
  forecast: "预测",
  performance: "业绩",
  expansion: "扩张",
  product: "产品",
  risk: "风险",
  industry: "行业",
};

const STANCE_COLOR: Record<NonNullable<SiteInsight["stance"]>, string> = {
  positive: "text-emerald-700",
  neutral: "text-ink-4",
  negative: "text-rose-700",
};

/** 文章详情右侧的研报要点卡（ka2）：研报正文里对品牌/商业体/行业的研判观点，数字保留
 *  数值+单位+口径三件套，预测性表述按报告原文口径。 */
export function InsightRailCards({ insights }: { insights: SiteInsight[] }) {
  if (insights.length === 0) return null;
  return (
    <RailSection title="研报要点">
      <ul className="space-y-3">
        {insights.slice(0, 8).map((i, n) => (
          <li key={n} className="border-l-2 border-accent/40 pl-3">
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <span className="rounded bg-bg-sunk px-1.5 py-0.5 font-medium text-ink-3">{KIND_LABEL[i.kind]}</span>
              {i.entityName && <span className="font-semibold text-ink-2">{i.entityName}</span>}
              {i.stance && <span className={STANCE_COLOR[i.stance]}>{i.stance === "positive" ? "看多" : i.stance === "negative" ? "看空" : "中性"}</span>}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{i.statement}</p>
            {i.figures.length > 0 && (
              <p className="mono mt-1 text-[11.5px] leading-relaxed text-ink-3">
                {i.figures.map((f) => `${f.value}${f.unit}·${f.caliber}`).join("；")}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">
        观点与数字提取自研报原文，口径以报告为准；预测类内容为机构观点，不构成事实陈述。
      </p>
    </RailSection>
  );
}

/** 品牌榜单详情页的研报观点模块（ka2）：关于该主体的研报研判，按发布时间倒序。 */
export function EntityInsightList({ insights }: { insights: SiteInsight[] }) {
  if (insights.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[14px] font-semibold text-ink">研报观点</h2>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-4">机构研报中对该主体的研判与数据，口径以各报告为准，仅供交叉参考。</p>
      <ul className="divide-y divide-line-soft">
        {insights.map((i, n) => (
          <li key={n} className="py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <span className="rounded bg-bg-sunk px-1.5 py-0.5 font-medium text-ink-3">{KIND_LABEL[i.kind]}</span>
              {i.stance && <span className={STANCE_COLOR[i.stance]}>{i.stance === "positive" ? "看多" : i.stance === "negative" ? "看空" : "中性"}</span>}
              {i.org && <span className="text-ink-3">{i.org}</span>}
              {i.publishedAt && (
                <time dateTime={i.publishedAt} className="mono text-ink-4">
                  {i.publishedAt.slice(0, 10)}
                </time>
              )}
            </div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{i.statement}</p>
            {i.figures.length > 0 && (
              <p className="mono mt-1 text-[11.5px] leading-relaxed text-ink-3">
                {i.figures.map((f) => `${f.value}${f.unit}·${f.caliber}`).join("；")}
              </p>
            )}
            <a href={i.articleUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] text-ink-4 hover:text-accent">
              来源：{i.articleTitle} ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
