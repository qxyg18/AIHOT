// zw13 榜单展示策略常量断言：品牌榜展示上限 80（命主 09-30 由 50 改 80）、商业体榜全量上限 1000、
// 来源页快照行上限 30 顺延。read 层截断逻辑靠这些常量驱动，此处锁口径防回退。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOARD_ENTRY_LIMITS, SNAPSHOT_ROWS_LIMIT, boardEntryLimit } from "@aihot/backend/leaderboard/registry";

test("brand board shows up to 80 entries", () => {
  assert.equal(BOARD_ENTRY_LIMITS.brand, 80);
  assert.equal(boardEntryLimit("brand"), 80);
});

test("mall board is full-list visible with a 1000 cap", () => {
  assert.equal(BOARD_ENTRY_LIMITS.mall, 1000);
  assert.equal(boardEntryLimit("mall"), 1000);
});

test("unknown boards fall back to the brand cap", () => {
  assert.equal(boardEntryLimit("whatever"), 80);
});

test("source snapshot rows keep the legacy 30 cap", () => {
  assert.equal(SNAPSHOT_ROWS_LIMIT, 30);
});
