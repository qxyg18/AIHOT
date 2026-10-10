// ym82 信息串联：文章信号提取器纯函数断言（不连库；审核/回填 SQL 路径由端到端实路验证覆盖）。
// ①三类信号句级提取正例（新开店数/业绩亿/门店数与净增口径）；②归属=句内含实体名才归；
// ③干扰面：家长/外币/中文数字不提取；④同句同 kind 只取首数、跨句去重。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFromSentence, extractSignalsForEntity } from "@aihot/backend/entitytags/signals";

test("openings: 新开 N 家门店句提取开店数", () => {
  const out = extractFromSentence("巴拉巴拉今年在全国新开门店120家，加速下沉市场布局");
  const openings = out.filter((s) => s.kind === "openings");
  assert.equal(openings.length, 1);
  assert.equal(openings[0]!.value, 120);
  assert.equal(openings[0]!.unit, "家");
});

test("revenue: 营收 N 亿句提取业绩数字，千分位与千分位小数均可", () => {
  const a = extractFromSentence("森马服饰上半年实现营收32.5亿元，同比增长8%");
  const b = extractFromSentence("某集团去年销售额1,200亿元创历史新高");
  assert.equal(a.filter((s) => s.kind === "revenue")[0]!.value, 32.5);
  assert.equal(b.filter((s) => s.kind === "revenue")[0]!.value, 1200);
});

test("revenue: 外币句不提取（口径混杂防线）", () => {
  const out = extractFromSentence("该品牌北美营收2.3亿美元，海外业务占比提升");
  assert.equal(out.filter((s) => s.kind === "revenue").length, 0);
});

test("stores: 门店总数与净增两种口径", () => {
  const total = extractFromSentence("安奈儿全国门店总数达1,200家");
  const net = extractFromSentence("孩子王三季度门店净增15家");
  const t = total.filter((s) => s.kind === "stores")[0]!;
  const n = net.filter((s) => s.kind === "stores")[0]!;
  assert.equal(t.value, 1200);
  assert.equal(t.caliber, "门店数");
  assert.equal(n.value, 15);
  assert.equal(n.caliber, "净增");
});

test("干扰面：家长/中文数字/无单位数字不提取", () => {
  assert.equal(extractFromSentence("该商场举办亲子活动吸引数百家庭参与").length, 0);
  assert.equal(extractFromSentence("品牌新开数百家门店的传闻不作为结构化信号").length, 0);
  assert.equal(extractFromSentence("门店编号2026的装修升级完成").length, 0);
});

test("归属：数字与实体须同分句（逗号段），跨分句的集团口径不归属", () => {
  const title = "森马集团发布年报";
  const body = "森马服饰新开门店85家。分产品看，2024H1休闲服饰收入为18.1亿元，儿童服饰收入为40.7亿元，海外扩张推进中，其中巴拉巴拉在越南新开7家店并入驻Shopee。";
  const balabala = extractSignalsForEntity(title, "", body, ["巴拉巴拉", "balabala"]);
  // 巴拉巴拉只出现在「新开7家店」分句——集团收入分句不归属它。
  assert.equal(balabala.filter((s) => s.kind === "openings").length, 1);
  assert.equal(balabala.filter((s) => s.kind === "revenue").length, 0);
  const senma = extractSignalsForEntity(title, "", body, ["森马服饰", "森马"]);
  assert.equal(senma.filter((s) => s.kind === "openings").length, 1);
  assert.equal(senma.filter((s) => s.kind === "revenue").length, 0);
});

test("正文句级：门店总数与净增从正文头部句提取", () => {
  const out = extractSignalsForEntity("", "", "财报显示，孩子王前三季度门店净增15家，期末门店总数达1,200家。", ["孩子王"]);
  const stores = out.filter((s) => s.kind === "stores");
  assert.equal(stores.some((s) => s.caliber === "净增" && s.value === 15), true);
  assert.equal(stores.some((s) => s.caliber === "门店数" && s.value === 1200), false);
});

test("去重：同 kind 同值跨句只留一条", () => {
  const out = extractSignalsForEntity(
    "某品牌扩张提速",
    "某品牌新开门店66家。据此前报道，某品牌今年新开门店66家。",
    "",
    ["某品牌"],
  );
  assert.equal(out.filter((s) => s.kind === "openings").length, 1);
});
