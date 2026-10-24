import type { LbSubBoard } from "@aihot/contracts/leaderboard";
import { PillTabs } from "../../components/ui/Tabs";
import { boardHref } from "./format";

/**
 * rd9 带选择器：总榜 + 分层子榜（品牌=价格带四层，商场=定位两层）。
 * 与榜单总榜页、子榜页同列，计数角标=该层实体内数。
 */
export function SubBoardTabs({ boardKey, subBoards, active }: { boardKey: string; subBoards: LbSubBoard[]; active: string | null }) {
  if (!subBoards.length) return null;
  const items = [
    { key: "all", label: "总榜", to: boardHref(boardKey) },
    ...subBoards.map((s) => ({ key: s.key, label: s.short, to: s.href, count: s.count })),
  ];
  return (
    <div className="mt-3">
      <PillTabs layoutId="lb-board-layer" size="sm" label="分层子榜" active={active ?? "all"} items={items} />
    </div>
  );
}