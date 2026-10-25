import { Link } from "react-router";
import type { SiteBrandCard } from "@aihot/contracts/site";
import { RailSection } from "../../components/ui/Page";
import { modelHref } from "../leaderboard/format";
import { IntentLink } from "../../components/ui/IntentLink";

/** 品牌档案行：有值才拼，点分隔；全空时整行不渲染。 */
function profileLine(b: SiteBrandCard): string | null {
  const parts: string[] = [];
  if (b.profile?.category) parts.push(b.profile.category);
  const year = b.profile?.listed?.match(/(?:19|20)\d{2}/)?.[0];
  if (year) parts.push(`${year} 上市`);
  if (b.profile?.revenueYi != null) parts.push(`年业绩约 ${b.profile.revenueYi} 亿${b.profile.revenueBasis ? `（${b.profile.revenueBasis}）` : ""}`);
  if (b.profile?.stores != null) parts.push(`门店约 ${b.profile.stores} 家`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 文章详情右侧的品牌简介卡：标题命中榜单品牌名录（keywords）时展示，最多 3 张。 */
export function BrandRailCards({ brands }: { brands: SiteBrandCard[] }) {
  if (brands.length === 0) return null;
  return (
    <RailSection title="品牌档案">
      <ul className="space-y-2.5">
        {brands.map((b) => (
          <li key={b.slug}>
            <IntentLink
              to={modelHref(b.slug, "brand")}
              className="block rounded-tile border border-line bg-surface px-3.5 py-3 transition-colors hover:border-accent/45 hover:bg-accent-softer"
            >
              <span className="flex items-baseline justify-between gap-2">
                <strong className="text-[14px] font-semibold text-ink">{b.name}</strong>
                {b.provider && <small className="shrink-0 text-[11.5px] text-ink-4">{b.provider}</small>}
              </span>
              {profileLine(b) && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{profileLine(b)}</p>}
              <span className="mt-1.5 block text-[12px] font-medium text-accent">榜单档案 →</span>
            </IntentLink>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">档案为公开信息概数（人工种子口径），仅供个人参考。</p>
    </RailSection>
  );
}

export interface SiteEntityTag {
  type: "brand" | "mall" | "mall-chain" | "channel";
  slug: string;
  name: string;
}

const TYPE_LABEL: Record<SiteEntityTag["type"], string> = {
  brand: "品牌",
  mall: "商业体",
  "mall-chain": "商业体",
  channel: "母婴渠道",
};

export function entityHref(e: SiteEntityTag): string {
  return `/entity/${e.type}/${encodeURIComponent(e.slug)}`;
}

/** 文章正文上方的实体标签行：点击直达实体页（档案+榜单排名+相关新闻）。 */
export function EntityTagRow({ entities }: { entities: SiteEntityTag[] }) {
  if (entities.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entities.map((e) => (
        <IntentLink key={`${e.type}:${e.slug}`} to={entityHref(e)} className="chip">
          {TYPE_LABEL[e.type]} · {e.name}
        </IntentLink>
      ))}
    </div>
  );
}

export interface SiteMallCard {
  type: SiteEntityTag["type"];
  slug: string;
  name: string;
}

/** 文章详情右侧的商业体/渠道卡：与品牌档案卡同款式。 */
export function MallRailCards({ malls }: { malls: SiteMallCard[] }) {
  if (malls.length === 0) return null;
  // Keep the rail readable: the article page caps the brand cards at 3 too.
  malls = malls.slice(0, 4);
  return (
    <RailSection title="商业体与渠道">
      <ul className="space-y-2.5">
        {malls.map((m) => (
          <li key={`${m.type}:${m.slug}`}>
            <IntentLink
              to={`/entity/${m.type}/${encodeURIComponent(m.slug)}`}
              className="block rounded-tile border border-line bg-surface px-3.5 py-3 transition-colors hover:border-accent/45 hover:bg-accent-softer"
            >
              <span className="flex items-baseline justify-between gap-2">
                <strong className="text-[14px] font-semibold text-ink">{m.name}</strong>
                <small className="shrink-0 text-[11.5px] text-ink-4">{TYPE_LABEL[m.type]}</small>
              </span>
              <span className="mt-1.5 block text-[12px] font-medium text-accent">档案与相关新闻 →</span>
            </IntentLink>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">按新闻中出现的商业体/渠道自动识别，点开看档案与相关报道。</p>
    </RailSection>
  );
}
