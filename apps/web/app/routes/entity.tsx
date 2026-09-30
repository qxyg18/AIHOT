// Entity page (zx18): one brand / mall / mall chain / retail channel — its profile facts, its
// current leaderboard rank when it is on a board, and the related site articles. Reached from the
// entity tags and rail cards on article pages.
import { SITE } from "@aihot/industry/site";
import { Link } from "react-router";
import type { Route } from "./+types/entity";
import { loadOr404 } from "../lib/api.server";

export interface EntityPageData {
  type: "brand" | "mall" | "mall-chain" | "channel";
  slug: string;
  name: string;
  summary: string | null;
  facts: Array<{ label: string; value: string }>;
  chainNote: string | null;
  leaderboard: { board: "brand" | "mall"; rank: number; score: number } | null;
  articles: Array<{ id: string; title: string; publishedAt: string | null }>;
  articleCount: number;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  return loadOr404<EntityPageData>(
    `/api/site/entity/${encodeURIComponent(params.type)}/${encodeURIComponent(params.slug)}`,
    { signal: request.signal },
  );
}

export const meta = ({ loaderData }: Route.MetaArgs) => [{ title: `${loaderData?.name ?? "实体"} · ${SITE.name}` }];

const BOARD_LABEL = { brand: "童装品牌榜", mall: "全国商业体榜" } as const;
const TYPE_LABEL = { brand: "品牌", mall: "商业体", "mall-chain": "商业体连锁", channel: "母婴渠道" } as const;

export default function EntityPage({ loaderData: e }: Route.ComponentProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[22px] font-bold text-ink">{e.name}</h1>
        <span className="rounded-full bg-bg-2 px-2.5 py-0.5 text-[12px] text-ink-3">{TYPE_LABEL[e.type]}</span>
        {e.leaderboard && (
          <Link
            to={`/leaderboard?board=${e.leaderboard.board}`}
            className="rounded-full bg-accent-softer px-2.5 py-0.5 text-[12px] font-medium text-accent"
          >
            {BOARD_LABEL[e.leaderboard.board]} 第 {e.leaderboard.rank} 名
          </Link>
        )}
      </div>

      {e.summary && <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{e.summary}</p>}
      {e.chainNote && <p className="mt-2 text-[13px] text-ink-3">{e.chainNote}</p>}

      {(e.facts.length > 0 || e.leaderboard) && (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-tile border border-line bg-surface px-4 py-3.5 sm:grid-cols-3">
          {e.facts.map((f) => (
            <div key={f.label}>
              <dt className="text-[11.5px] text-ink-4">{f.label}</dt>
              <dd className="mt-0.5 text-[13.5px] text-ink">{f.value}</dd>
            </div>
          ))}
          {e.leaderboard && (
            <div>
              <dt className="text-[11.5px] text-ink-4">榜单得分</dt>
              <dd className="mt-0.5 text-[13.5px] text-ink">{Math.round(e.leaderboard.score)}</dd>
            </div>
          )}
        </dl>
      )}

      <h2 className="mt-8 text-[16px] font-semibold text-ink">相关新闻（{e.articleCount}）</h2>
      {e.articles.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-ink-3">暂无相关新闻。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {e.articles.map((a) => (
            <li key={a.id}>
              <Link to={`/items/${a.id}`} prefetch="intent" className="block py-3 transition-colors hover:text-accent">
                <span className="text-[14.5px] leading-snug text-ink">{a.title}</span>
                {a.publishedAt && (
                  <time className="mt-1 block text-[12px] text-ink-4">{a.publishedAt.slice(0, 10)}</time>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-[11.5px] leading-relaxed text-ink-4">档案与标签为公开信息聚合（人工种子与站内新闻口径），仅供个人参考。</p>
    </main>
  );
}
