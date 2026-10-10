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
  /** T13：本轮计分依据（与 run 同源）；null=历史 run 未落元数据，页面标注历史，静态维度表仅作展示。 */
  basis: { effectiveDimensions: string[]; denominator: number } | null;
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
    body: "提及/事件类计数指标先做对数压缩（log1p）再 min-max 归一到 0—100：数量级差异本身就是信息，头部极值不再把中段挤成 0 分带。营收与门店按定稿断点分层锚点计分（品牌营收 3/5/10/20 亿；门店 200/600 家分段、1000 家及以上满值；商场营收 10/20/50/150/200/250 亿六档（→20/40/60/80/90/100 分、250 亿及以上满分））——绝对口径，与同榜其他实体无关，池底与极值绑架问题在定义上消失；商业体体量（万㎡）按分位分计入客流复合（体量数据覆盖过半才启用，未达线时全维度按档位分计）；客流档位等层级值线性归一。同一维度有多个指标时取均值，指标权重均等，不叠加放大。",
  },
  {
    n: "03",
    title: "缺数先填一层，按定稿权重加权",
    body: "品牌榜：业绩 50% / 规模 30% / 媒体声量 20%（扩张维度已取消）。商业体榜：业绩 50% / 客流 30% / 媒体声量 10% / 童装业态亲和 10%（首店快闪维已取消），业绩维度整体缺数时滚给客流。缺营收的实体先按同条件组（商业体=同客流档、品牌=同门店量级带）取中位数填一层「推断填充」值——不罚零、不冒充实测，真实数据入场自动覆盖。维度分按数据成色折价后进加权：机器源 ×1.0、研报提取 ×0.85、人工种子 ×0.7、推断填充 ×0.5（总分上限随成色如实下压）。全榜无任何实体得分的维度自动滚出权重体系，其权重按比例摊给其余在役维度。权重为命主定稿，写进算法版本。",
  },
  {
    n: "04",
    title: "缺数计零，独立计权",
    body: "各维度独立计权，分母固定为在役权重总和：某实体一个维度既无实测也无填充值时，该维度计 0 贡献，不把权重摊给其余维度（缺业绩不能靠规模补位），也不猜测；同时给出覆盖度（有效维度权重占比）。覆盖度不足 30% 的实体标「样本不足」，不进正式名次。注意区分两层规则：空转滚动是维度级全榜缩放（每个实体同等受益，不改变实体间相对比较），实体级缺数计零是单个实体的让位（改变实体间公平）——两者性质不同，不互替代。",
  },
  {
    n: "05",
    title: "数据置信级，随分披露并折价",
    body: "每个维度按数据来源标注置信级：机器源（自动采集）＞研报提取（公开研报/媒体整理）＞人工种子（人工编制档位）＞推断填充（缺数条件填充）。榜单行与实体详情页有角标，且置信级不只展示、还进入分数（维度分按档位折价后加权，系数见上一步）；机器正源接入后同维度自动升档。商业体营收支持值级成色：联商网年度盘点值标「研报提取」档，项目长图人工估算标「人工」档，逐实体角标披露。",
  },
];

const ANTI_GAMING = [
  ["单源封顶", "每个维度内的指标均分该维度权重；同一采集端最多影响它名下的维度（站内引擎=品牌/商场声量与商场童装业态亲和；人工种子=业绩/规模/客流；首店事件词采集保留但已退出在役维度不参排），没有任何单一来源能靠量堆满整张榜。"],
  ["窗口提及门槛", "提及类与事件类指标要求窗口（90 天）内至少 3 篇，低于门槛该维度不计分；靠零星公关稿刷不出名次。"],
  ["成色折价，低置信不同权", "人工种子与推断填充值按 0.7/0.5 折价计权，研报提取按 0.85——低置信数据不再与机器源同权，采集正循环由此接上：换成硬数据，分数上限自然抬升。"],
  ["样本不足标注", "有效维度权重占比不足 30% 的实体不进入正式名次，单独列在「样本不足」区，等数据积累够再参排。"],
  ["分级不进权重", "品牌的 P0/P1/P2 监控分级（站点编辑分层）只用于页面分组展示，不进任何权重计算；戴维贝拉作为名录内品牌正常参排。"],
];

const FAQ = [
  {
    q: "商业体榜的客流数据可靠吗？",
    a: "客流维度的正源是机器自动采集的客流数据。公开面结构化客流榜单暂不可得（赢商网实测不可抓），客流维度现由人工编制的客流层级种子以「人工种子」置信档参排，并与名录体量（万㎡，客观数据）做复合：有体量值的商业体=档位分×0.6+体量分位分×0.4，体量缺省者回退档位全额；复合在体量数据覆盖过半后才启用（未达线时全维度按档位分计），补数达线自动恢复；角标如实披露，成色折价计权。地图 POI 人气等机器正源（2026-09-30 已定替代源路线）接入后，该维度自动升为机器源档并覆盖种子值，复合结构不变。",
  },
  {
    q: "业绩和规模的数据从哪来？",
    a: "业绩维度取公开研报与媒体整理的概数（品牌=上市财报口径概数；商业体分两档角标披露：联商网年度盘点值=「研报提取」档，项目长图人工估算=「人工」档），规模/客流层级为人工种子档，均标注待核实并按档折价计权。缺营收的实体按同条件组中位数填一层「推断填充」值（角标披露、按 0.5 计权），真实数据入场自动覆盖；每个实体的覆盖度标签披露其数据完整程度；公告自动抽取接入后人工档将被逐步替换。",
  },
  {
    q: "声量是怎么统计的？",
    a: "站内声量=近 90 天站内采集文章的实体标注计数：文章的标题、摘要与正文全文经确定性关键词标注出品牌/商场实体后按文计数（全文级口径，不漏正文提及）。首店/快闪事件仍按标题事件词过滤。热搜命中（DailyHotApi 自部署实例聚合的各平台热搜）与社媒指数（人工补录通道）接入后，声量维度取三个口径的均值。",
  },
  {
    q: "榜单多久更新一次？",
    a: "每天三轮（02:05 / 08:05 / 20:05）。指标数据变化才发布新榜单；数据没变的轮次保持原榜单与原时间。",
  },
  {
    q: "同分怎么排序？",
    a: "综合分相同时，先按业绩概数真值高者在前（分层锚点封顶会让营收不同的实体拿到相同的维度分，如 25 亿与 30 亿都封顶 100 分，此时回到营收真值分先后）；推断填充值不参与定序（填充值是条件组中位数概数，不冒充实测），仅一方有业绩数据时有数据者在前；业绩真值相同或双方均无业绩数据时，按实体名录名（slug）排序。规则预先固定，与排名结果无关（v4.5）。",
  },
  {
    q: "非上市品牌会不会吃亏？",
    a: "缺业绩数据的品牌会先按同门店量级带填一层「推断填充」值（按 0.5 折价计权），不再直接罚零；门店量级也无从判断的品牌该维度计 0 贡献（各维度独立计权，不靠规模补位），分数会如实反映数据完整程度；覆盖度标签披露其数据完整度，读榜时请一并参考。人工补录通道（社媒指数、非上市业绩披露）开放给站方随时补充。",
  },
  {
    q: "榜单还分了子榜（价格带/定位分层），是怎么回事？",
    a: "两榜在总榜之外按种子档案分层提供子榜：品牌榜按价格带分四层（大众/中端/中高端/高端），商业体榜按定位分三层（高端旗舰/家庭主流/大众平替）。子榜是总榜的带内视图——分数与总榜完全一致，不重算不折价，名次为层内序，行内小字披露总榜名次保跨层可比；品牌档案缺价格带的实体暂不落带（总榜仍可见）。大众平替榜即商业体榜第三层=定位「中低端」的商业体，与高端旗舰、家庭主流两层合计覆盖总榜全部实体。",
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
          <p className="mt-2.5 text-[13px] leading-[1.8] text-ink-3">两榜各维度权重由站方定稿并写进算法版本；每个实体的维度得分与数据成色角标在详情页完整可见，按角标折算价系数即可复算加权分。</p>
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
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-4">
              {b.basis ? (
                <>本轮计分分母=在役权重和 {b.basis.denominator}（有效维度：{b.dimensions.filter((d) => b.basis!.effectiveDimensions.includes(d.key)).map((d) => d.name).join("、")}；空转维度已滚出，权重按比例摊给在役维度）。</>
              ) : (
                <>历史轮次未落计分依据元数据，下表为方法定义维度（本轮实际在役与分母以最新方法版本为准）。</>
              )}
            </p>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5" aria-label={`${b.name}维度权重`}>
              {b.dimensions.map((d) => {
                const effective = b.basis?.effectiveDimensions.includes(d.key) ?? null;
                return (
                  <li key={d.key} className={`card flex flex-col p-4 lg:p-5 ${effective === false ? "opacity-60" : ""}`}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[13.5px] font-semibold text-ink">{d.name}</span>
                      <span className="mono text-[20px] font-medium text-ink">{pct(d.weight, 0)}</span>
                    </span>
                    {effective === false && <span className="mt-1 text-[11px] text-ink-4">本轮空转未计分（权重已滚出）</span>}
                    <span className="mt-2.5 text-[11.5px] leading-[1.7] text-ink-4">{d.sources.join(" · ") || "—"}</span>
                    {b.tiers?.[d.key] && (
                      <span className="mt-1 text-[11.5px] leading-[1.7] text-ink-4">置信级：{LB_SOURCE_TIER_LABELS[b.tiers[d.key] as LbSourceTier] ?? b.tiers[d.key]}</span>
                    )}
                  </li>
                );
              })}
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
              方法版本：<code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[12px] text-ink-2">{run.methodologyVersion}</code>。加权分计算：每个指标在其所属榜的实体池内归一（提及/事件类计数先 log1p 压缩再 min-max；营收/门店/商场营收按定稿断点分层锚点绝对计分——营收 3/5/10/20 亿→25/50/75/100 分、20 亿及以上封顶，门店 200/600 家→25/50 分、1000 家及以上满值（此前段线性至 75），商场营收 10/20/50/150/200/250 亿→20/40/60/80/90/100 分、250 亿及以上满分（v4.7 六档连续插值，命主 2026-10-03 定稿）；童装业态亲和按共现品牌数绝对档计分（每有一个榜内品牌+10 分封顶 100，v4.8 命主同日定稿）；商业体体量按分位分计入客流复合，体量覆盖过半才启用），维度分=维度内各指标归一分的均值，实体总分=Σ(维度分×成色系数×维度权重)÷在役权重总和（成色系数：机器源 1.0／研报提取 0.85／人工种子 0.7／推断填充 0.5，按榜单行与详情页角标档位取值；单实体缺数维度计 0 贡献，不摊权重、不交叉补位；全榜空转的维度滚出权重体系、权重按比例摊给其余在役维度）。
            </p>
            <p>
              覆盖度=有效维度权重和÷全部在役权重和；展示保留一位小数。窗口提及门槛（3 篇，声量/媒体类适用；亲和自 v4.8 起按品牌数绝对计分不卡门槛）、覆盖度门槛（30%）、营收/门店/商场营收分层锚点断点（值见上）、总分并列定序（业绩概数真值高者在前——锚点封顶后维度分相同而营收真值有别时据此分先后；推断填充值不参与定序、仅一方有真值时有值者在前；真值同或双方均无按名录名字典序，v4.5）、商业体榜业绩滚给客流的转移规则、空转维度滚动规则、缺营收条件填充（商业体=同客流档／品牌=同门店量级带的中位数，log 空间；同组无真值参考或门店量级缺省者不填充）、客流维体量复合（档位 0.6+体量 0.4，无体量回退档位全额；启用闸=有体量商场占池比≥50%，未达线时全维度按档位分计）、先验亲和分档（商场类型×定位垫底：购物中心×大众/中端/中低端=100、中高端=80、高端=60，百货=50，奥特莱斯/商业街区=40，类型或定位缺省者不垫底；垫底值按推断填充档折价 0.5，每有一个榜内品牌+10 分、10 个品牌及以上满分（v4.8 命主 2026-10-03 定稿，绝对口径；实测有行的实体逐个由实测接管）——先验只在亲和实测行整体缺席时兜底）、数据置信级分档与折价系数（机器源＞研报提取＞人工种子＞推断填充，随维度分披露并进加权；商业体营收值级成色 annual=研报提取档/estimate=人工档，逐实体角标）、商场榜名录全量入池（无任何指标数据的商业体列示于榜尾样本不足区，0 分不计入正式名次，v4.5）均为算法内固定常量，变更即升版本并在本页公示。
            </p>
            <p>
              事件词表（首店快闪）：开店、新开、首店、入驻、开业、新店、新品、联名、快闪、拓店、进场。站内声量引擎统计口径=近 90 天文章实体标注计数（标注面=标题+摘要+正文全文；事件词按标题匹配）；社媒外站统计随信源扩展升级，升级前如实披露口径边界。
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
