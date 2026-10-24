// zw15 品牌简介卡匹配测试：brandCardsForText 按品牌名录 keywords 匹配标题（与声量引擎同口径），最多 3 张。
// 依赖仓库内种子文件（确定性数据）；断言用 slug/长度，不锚种子顺序，免种子重排脆断。
import assert from "node:assert/strict";
import { test } from "node:test";
import { brandCardsForText } from "@aihot/backend/leaderboard/read";

test("hits a brand by its Chinese keyword", () => {
  const cards = brandCardsForText("巴拉巴拉童装秋冬新品发布");
  assert.ok(cards.some((c) => c.slug === "balabala"), "balabala card expected");
  const card = cards.find((c) => c.slug === "balabala")!;
  assert.equal(card.name, "巴拉巴拉");
  assert.equal(card.provider, "森马服饰");
  assert.ok(card.profile && card.profile.category, "seed profile expected for balabala");
});

test("matches case-insensitively on latin keywords", () => {
  const cards = brandCardsForText("Balabala opens new store");
  assert.ok(cards.some((c) => c.slug === "balabala"));
});

test("no hit returns empty", () => {
  assert.deepEqual(brandCardsForText("纺织行业出口数据点评"), []);
});

test("caps the card list at three per item", () => {
  const cards = brandCardsForText("巴拉巴拉、森马、安奈儿、好孩子同台发布");
  assert.ok(cards.length <= 3 && cards.length > 0, `expected 1-3 cards, got ${cards.length}`);
});
