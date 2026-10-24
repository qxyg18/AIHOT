import { data } from "react-router";
import type { Route } from "./+types/leaderboard-sub";
import type { LbBoardResponse } from "@aihot/contracts/leaderboard";
import { LEADERBOARD_BOARD_LABELS, isLeaderboardSubBoardKey } from "@aihot/contracts/taxonomy";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { boardHref } from "../features/leaderboard/format";
import LeaderboardPage, { boardItemList, headers } from "./leaderboard";

export { headers };

/** rd9 子榜页 /leaderboard/sub/:sub：品牌价格带四层 + 商场定位三层，复用总榜页面组件与缓存口径。 */
export async function loader({ params, request }: Route.LoaderArgs) {
  if (!isLeaderboardSubBoardKey(params.sub)) throw data({ message: "not_found" }, { status: 404 });
  return loadOr404<LbBoardResponse>(`/api/site/leaderboard/subboards/${params.sub}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("页面不存在") }];
  const { board, entries, subView } = loaderData;
  const path = `/leaderboard/sub/${params.sub}`;
  return pageMeta({
    title: board.title,
    rawTitle: true,
    description: board.description,
    path,
    image: "/og/pages/leaderboard.png",
    jsonLd: [
      boardItemList(board, entries),
      breadcrumbLd([
        { name: "排行榜", path: "/leaderboard" },
        { name: LEADERBOARD_BOARD_LABELS[board.key], path: boardHref(board.key) },
        { name: subView?.name ?? board.name, path },
      ]),
    ],
  });
}

export default LeaderboardPage;