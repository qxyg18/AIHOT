import { useLocation } from "react-router";
import { LEADERBOARD_BOARD_LABELS, LEADERBOARD_PUBLIC_BOARDS, LEADERBOARD_SUB_BOARD_PARENT, leaderboardSubBoardFromPath } from "@aihot/contracts/taxonomy";
import { PillTabs } from "../../components/ui/Tabs";
import { boardHref } from "./format";

/** Board switcher. It lives in the shared layout, so the thumb glides between boards. */
export function BoardTabs() {
  const { pathname } = useLocation();
  // rd9：子榜页（/leaderboard/sub/:sub）高亮其父榜，榜间滑块位置不因进子榜而跳回品牌榜。
  const sub = leaderboardSubBoardFromPath(pathname);
  const active = LEADERBOARD_PUBLIC_BOARDS.find((k) => boardHref(k) === pathname) ?? (sub ? LEADERBOARD_SUB_BOARD_PARENT[sub] : "brand");
  return (
    <PillTabs
      layoutId="lb-board"
      label="榜单"
      active={active}
      items={LEADERBOARD_PUBLIC_BOARDS.map((k) => ({ key: k, label: LEADERBOARD_BOARD_LABELS[k], to: boardHref(k) }))}
    />
  );
}
