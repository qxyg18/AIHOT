// Public method statement for the two boards (weighted v1, docs/leaderboard.md).
// The copy states how rankings are actually computed; it changes only together with the method.
import { SITE } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import type { LbRunInfo, LbSourceTier } from "@aihot/contracts/leaderboard";
import { LB_SOURCE_TIER_LABELS } from "@aihot/contracts/leaderboard";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta } from "../lib/seo";
import { pct } from "../features/leaderboard/format";
import { fullDateTime } from "../lib/format";
import { IconArrowLeft, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

interface RulesDimension {
  key: string;
  name: string;
  weight: number;
  sources: string[];
}

interface RulesBoard {
  key: string;
  name: string;
  mode: string | null;
  dimensions: RulesDimension[];
  tiers: Record<string, string>;
}

interface RulesData {
  run: LbRunInfo;
  boards: RulesBoard[];
}

export async function loader({ request }: { request: Request }) {
  return loadOr404<RulesData>("/api/site/leaderboard/rules", { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "两榜排名怎么算",
    description: `查看 ${SITE.name} 童装品牌榜与全国商业体榜的维度权重、归一方法、防扭曲机制与冷启动标注。`,
    path: "/leaderboard/rules",
    image: "/og/pages/leaderboard.png",
    jsonLd: breadcrumbLd([
      { name: "排行榜", path: "/leaderboard" },
      { name: "排名怎么算", path: "/leaderboard/rules" },
    ]),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=3600" };
}

const STEPS = [
  {
    n: "01",
    title: "先统一实体身份",
    body: "品牌榜与商业体榜的实体来自站点名录（种子文件维护）。各数据源用自己的叫法提及实体时，统一映射到名录条目；名录外的新实体不凭单条消息上榜，先入名录再参排。",
  },
  {
    n: "02",
    title: "每个维度内归一",
    body: "计数类指标（提及、事件）先做对数压缩再归一到 0—100；金额、门店数、层级直接归一。同一维度有多个指标时取均值，指标权重均等，不叠加放大。",
  },
  {
    n: "03",
    title: "按定稿权重加权",
    body: "品牌榜：声量 20% / 业绩 40% / 规模 30% / 扩张 10%。商业体榜：客流 30% / 童装业态亲和 20% / 业绩 30% / 首店快闪 12% / 媒体声量 8%，业绩维度整体缺数时滚给客流。权重为命主定稿，写进算法版本。",
  },
  {
    n: "04",
    title: "缺数计零，独立计权",
    body: "各维度独立计权，分母固定为权重总和：某实体缺一个维度的数据时，该维度计 0 贡献，不把权重摊给其余维度（缺业绩不能靠规模补位），也不猜测；同时给出覆盖度（有效维度权重占比）。覆盖度不足 30% 的实体标「样本不足」，不进正式名次。",
  },
  {
    n: "05",
    title: "数据置信级，随分披露",
    body: "每个维度按数据来源标注置信级：机器源（自动采集）＞研报提取（公开研报/媒体整理）＞人工种子（人工编制档位）。榜单行与实体详情页有角标，读榜时可一并参考数据成色；机器正源接入后同维度自动升档。",
  },
];

const ANTI_GAMING = [
  ["单源封顶", "每个维度内的指标均分该维度权重；同一采集端最多影响它名下的维度（站内引擎=声量+扩张+商场三维度，人工种子=业绩+规模+客流），没有任何单一来源能靠量堆满整张榜。"],
  ["窗口提及门槛", "提及类与事件类指标要求窗口（30 天）内至少 3 条，低于门槛该维度不计分；靠零星公关稿刷不出名次。"],
  ["样本不足标注", "有效维度权重占比不足 30% 的实体不进入正式名次，单独列在「样本不足」区，等数据积累够再参排。"],
  ["分级不进权重", "品牌的 P0/P1/P2 监控分级（站点编辑分层）只用于页面分组展示，不进任何权重计算；戴维贝拉作为名录内品牌正常参排。"],
];

const FAQ = [
  {
    q: "商业体榜的客流数据可靠吗？",
    a: "客流维度的正源是机器自动采集的客流数据。公开面结构化客流榜单暂不可得（赢商网实测不可抓），客流维度现由人工编制的客流层级种子以「人工种子」置信档参排，角标如实披露；地图 POI 人气等机器正源（2026-09-30 已定替代源路线）接入后，该维度自动升为机器源档并覆盖种子值，五维加权结构不变。",
  },
  {
    q: "业绩和规模的数据从哪来？",
    a: "业绩维度取公开研报与媒体整理的概数（商业体=联商网年度盘点口径，标「研报提取」档；品牌=上市财报口径概数），规模/客流层级为人工种子档，均标注待核实。每个实体的覆盖度标签披露其数据完整程度；公告自动抽取接入后人工档将被逐步替换。",
  },
  {
    q: "声量是怎么统计的？",
    a: "站内声量=近 30 天站内采集文章标题对品牌的提及次数（标题级关键词匹配）。热搜命中（DailyHotApi 自部署实例聚合的各平台热搜）与社媒指数（人工补录通道）接入后，声量维度取三个口径的均值。",
  },
  {
    q: "榜单多久更新一次？",
    a: "每天四轮（02:05 / 08:05 / 14:05 / 20:05）。指标数据变化才发布新榜单；数据没变的轮次保持原榜单与原时间。",
  },
  {
    q: "同分怎么排序？",
    a: "综合分相同时按实体名录名（slug）排序，规则预先固定，与排名结果无关。",
  },
  {
    q: "非上市品牌会不会吃亏？",
    a: "缺业绩数据的品牌该维度计 0 贡献（各维度独立计权，不靠规模补位），分数会如实反映数据完整程度；覆盖度标签披露其数据完整度，读榜时请一并参考。人工补录通道（社媒指数、非上市业绩披露）开放给站方随时补充。",
  },
];

const SECTIONS = [
  ["#rules-steps", "五步得出排名"],
  ["#rules-weights", "两榜权重"],
  ["#rules-anti-gaming", "防扭曲机制"],
  ["#rules-faq", "常见问题"],
  ["#rules-details", "计算细节"],
] as const;

/** One question or detail block: a hairline row that opens in place. */
function Disclosure({ summary, children, defaultOpen = false }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure group border-b border-line" open={defaultOpen}>
      <summary className="flex items-center justify-between gap-3 py-4 text-[14px] font-semibold text-ink transition-colors hover:text-accent">
        {summary}
        <span className="shrink-0 text-[18px] font-normal leading-none text-ink-4 transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="max-w-[64em] pb-5 text-[13px] leading-[1.8] text-ink-3">{children}</div>
    </details>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="mono text-[11px] font-semibold tracking-[0.14em] text-accent">{children}</span>;
}

export default function LeaderboardRulesPage() {
  const { run, boards } = useLoaderData<typeof loader>();
  const aside = (
    <>
      <AsideCard title="本页内容" className="hidden lg:block">
        <nav aria-label="本页内容" className="-mx-2 -mb-1">
          {SECTIONS.map(([href, label]) => (
            <a key={href} href={href} className="block rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="当前方法">
        <dl className="space-y-2 text-[12.5px]">
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">方法版本</dt>
            <dd className="mono min-w-0 text-ink-2">{run.methodologyVersion}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">本轮计算</dt>
            <dd className="mono min-w-0 text-ink-2">{fullDateTime(run.generatedAt)}</dd>
          </div>
        </dl>
      </AsideCard>
      <AsideCard title="继续看">
        <nav aria-label="继续看" className="-mx-2 -mb-1">
          {[
            ["/leaderboard", "童装品牌榜"],
            ["/leaderboard/category/mall", "全国商业体榜"],
            ["/leaderboard/sources", "每一份数据来源"],
          ].map(([to, label]) => (
            <Link key={to} to={to!} prefetch="intent" className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
              <IconChevronRight size={14} className="text-ink-4" />
            </Link>
          ))}
        </nav>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <Link to="/leaderboard" className="inline-flex items-center gap-1.5 py-2 text-[13px] text-ink-3 transition-colors hover:text-accent">
        <IconArrowLeft size={14} /> 返回排行榜
      </Link>

      <header className="pt-3">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">排名怎么算</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">童装品牌榜与全国商业体榜的维度权重、归一方法与防扭曲机制，全部公开。</p>
      </header>

      <section className="mt-6 grid items-center gap-5 rounded-panel border border-line-soft bg-bg-sunk px-6 py-7 dark:bg-bg-muted/40 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:px-10 md:py-9 lg:grid-cols-1 xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <p className="mono text-[44px] font-medium leading-none tracking-[-0.04em] text-accent md:text-center md:text-[52px]">0—100</p>
        <div>
          <h2 className="text-[17px] font-bold text-ink">定稿权重，透明计算。</h2>
          <p className="mt-2.5 text-[13px] leading-[1.8] text-ink-3">两榜各维度权重由站方定稿并写进算法版本；每个实体的维度得分在详情页完整可见，加权和可复算。</p>
          <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">加权分是维度内相对位置的合成，不是市场份额或能力差距的百分比；同分按固定规则排序。</p>
        </div>
      </section>

      <ol id="rules-steps" className="mt-8 grid scroll-mt-6 gap-x-10 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {STEPS.map((s) => (
          <li key={s.n} className="border-b border-line py-5">
            <span className="mono text-[11px] text-ink-4">{s.n}</span>
            <h2 className="mt-2 text-[15px] font-bold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">{s.body}</p>
          </li>
        ))}
      </ol>

      <section id="rules-weights" className="mt-12 scroll-mt-6">
        <Eyebrow>BOARD WEIGHTS</Eyebrow>
        <h2 className="mt-2 text-[20px] font-bold text-ink">两榜权重表（本轮在役）。</h2>
        <p className="mt-1.5 max-w-[64em] text-[13px] leading-[1.8] text-ink-3">
          权重正本在算法（方法版本随权重变更升级）；下表由本轮计算结果直接生成，页面写的和算法算的一致。
        </p>
        {boards.map((b) => (
          <div key={b.key} className="mt-5">
            <h3 className="text-[15px] font-bold text-ink">
              {b.name}
              {b.mode === "footfall-only" && <span className="ml-2 rounded-mark bg-bg-sunk px-2 py-0.5 text-[11.5px] font-normal text-ink-3">降级期：客流单源直榜</span>}
            </h3>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5" aria-label={`${b.name}维度权重`}>
              {b.dimensions.map((d) => (
                <li key={d.key} className="card flex flex-col p-4 lg:p-5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[13.5px] font-semibold text-ink">{d.name}</span>
                    <span className="mono text-[20px] font-medium text-ink">{pct(d.weight, 0)}</span>
                  </span>
                  <span className="mt-2.5 text-[11.5px] leading-[1.7] text-ink-4">{d.sources.join(" · ") || "—"}</span>
                  {b.tiers?.[d.key] && (
                    <span className="mt-1 text-[11.5px] leading-[1.7] text-ink-4">置信级：{LB_SOURCE_TIER_LABELS[b.tiers[d.key] as LbSourceTier] ?? b.tiers[d.key]}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section id="rules-anti-gaming" className="mt-12 scroll-mt-6">
        <Eyebrow>ANTI-GAMING</Eyebrow>
        <h2 className="mt-2 text-[20px] font-bold text-ink">防扭曲机制。</h2>
        <div className="mt-3 border-t border-line">
          {ANTI_GAMING.map(([title, body]) => (
            <Disclosure key={title} summary={title} defaultOpen>
              {body}
            </Disclosure>
          ))}
        </div>
      </section>

      <section id="rules-faq" className="mt-12 scroll-mt-6">
        <h2 className="text-[20px] font-bold text-ink">你可能还想知道</h2>
        <div className="mt-3 border-t border-line">
          {FAQ.map((f) => (
            <Disclosure key={f.q} summary={f.q}>
              {f.a}
            </Disclosure>
          ))}
        </div>
      </section>

      <section id="rules-details" className="mt-10 scroll-mt-6 border-t border-line">
        <Disclosure summary="查看计算细节与当前版本">
          <div className="space-y-3">
            <p>
              方法版本：<code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[12px] text-ink-2">{run.methodologyVersion}</code>。加权分计算：每个指标在其所属榜的实体池内归一（计数类先 log1p 压缩），维度分=维度内各指标归一分的均值，实体总分=Σ(维度分×维度权重)÷权重总和（缺数维度计 0 贡献，不摊权重、不交叉补位）。
            </p>
            <p>
              覆盖度=有效维度权重和÷全部维度权重和；展示保留一位小数。窗口提及门槛（3 条）、覆盖度门槛（30%）、商业体榜业绩滚给客流的转移规则、数据置信级分档（机器源＞研报提取＞人工种子，随维度分披露）均为算法内固定常量，变更即升版本并在本页公示。
            </p>
            <p>
              事件词表（扩张/首店快闪）：开店、新开、首店、入驻、开业、新店、新品、联名、快闪、拓店、进场。站内声量引擎统计口径=近 30 天标题级关键词提及；正文级与社媒外站统计随信源扩展升级，升级前如实披露口径边界。
            </p>
            <p>上一代方法（AI 模型榜 Kemeny 共识 v15）的代码保留在系统中未删除，历史榜单可回溯；两榜体系不继承其任何票权结构。</p>
          </div>
        </Disclosure>
      </section>

      <Link to="/leaderboard/sources" className="mt-8 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent hover:text-accent-ink">
        查看每一份数据来源 →
      </Link>
    </ReadingLayout>
  );
}
