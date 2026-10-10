// 主编点评（ym44）落进刊面的最后两道确定性关口：点评句里出现身份词典内的他条目主体即整句丢弃
// （宁缺勿错，词典外主体不在校验面）；超长点评截到首句，截不出首句的丢弃。模型回答由本地桩给出，
// 不触及生产数据（writeSoWhat 只经 chatJson 落一条 receipts 行，库名闸挡在 setup.ts）。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { firstSentence, writeSoWhat, type ReportEntry } from "@aihot/backend/reports/compose";
import { stub, tag } from "./setup.ts";

const T = tag();

const entry = (itemId: string, title: string): ReportEntry => ({
  itemId, factId: null, storyPublicId: null, title, summary: "门店动态，无其他主体。",
  sourceName: "测试来源", sourceUrl: `https://example.com/${itemId}`, sourceId: `src-${itemId}`,
  firstParty: false, role: "媒体", score: 60, publishedAt: "2026-09-30T00:00:00.000Z",
});

// 词典内两个互不相干的主体：条目材料里只出现自己（allowed 集合只有一个 id）。
const A = `it${T}a`; // 巴拉巴拉
const B = `it${T}b`; // 戴维贝拉
const C = `it${T}c`; // 巴拉巴拉
const D = `it${T}d`; // 戴维贝拉

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const user = String(body.messages.at(-1)?.content ?? "");
  if (!user.includes(`[it${T}`)) throw new Error(`unexpected LLM request: ${user.slice(0, 80)}`);
  return {
    id: "stub", model: "stub",
    choices: [{ message: { content: JSON.stringify({
      items: [
        { id: A, soWhat: "戴维贝拉受此消息带动股价上行。" }, // 词典内主体越界：张冠李戴，整句丢弃
        { id: B, soWhat: "该系列为国庆档销售直接补位。" }, // 词典外主体不在校验面：照留
        { id: C, soWhat: `巴拉巴拉或加大投放。${"x".repeat(102)}` }, // 超100字：截到首句后照留
        { id: D, soWhat: "x".repeat(110) }, // 超100字且无首句：丢弃
      ],
    }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

after(async () => { await provider.close(); await closeDb(); });

test("a comment naming another lexicon entity is dropped whole; a comment naming none stays", async () => {
  const res = await writeSoWhat(`report:test:${T}:so-what`, [entry(A, `巴拉巴拉在杭州开出一家旗舰店 ${T}`), entry(B, `戴维贝拉发布秋季新品系列 ${T}`)], "deepseek-flash");
  assert.ok(res.comments.every((c) => c.itemId !== A), "巴拉巴拉条目的点评提了戴维贝拉，必须整句丢弃");
  assert.deepEqual(res.comments.map((c) => c.itemId), [B], "只留不提任何词典主体的那句");
  assert.equal(typeof res.receiptId, "number");
});

test("an overlong comment collapses to its first sentence; one without a sentence is dropped", async () => {
  const res = await writeSoWhat(`report:test:${T}:so-what`, [entry(C, `巴拉巴拉双十一大促预热 ${T}`), entry(D, `戴维贝拉小程序上新 ${T}`)], "deepseek-flash");
  assert.deepEqual(res.comments, [{ itemId: C, soWhat: "巴拉巴拉或加大投放。" }], "截到首句且过词典守卫；无首句的那条不留");
});

test("firstSentence: within 100 kept as-is, overlong cut to the first sentence", () => {
  assert.equal(firstSentence("巴拉巴拉开出首家门店。"), "巴拉巴拉开出首家门店。");
  assert.equal(firstSentence(`巴拉巴拉或加大投放。${"x".repeat(102)}`), "巴拉巴拉或加大投放。");
  assert.equal(firstSentence(`${"x".repeat(101)}。尾句`), null, "首句本身就超100字：留不住，丢弃");
  assert.equal(firstSentence("x".repeat(110)), null, "整句没有句读，截不出首句，丢弃");
  assert.equal(firstSentence(""), null);
});
