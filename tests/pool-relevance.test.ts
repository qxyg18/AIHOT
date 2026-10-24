// Relevance rewrites must keep every term mandatory across direct/body fields, retain the
// title and whole-company boosts, deduplicate company/text matches, and preserve filters,
// release scope, literal LIKE characters, tie ordering and empty-page totals.
//
// [yn92 对位适配声明] 本文件自上游 KKKKhazix/AIHOT 61613d3 原样落仓（含其新增的拆词与
// 词首两组回归用例，均零适配实跑通过）。唯一适配在 company 用例：上游原断言依赖
// 「整司别名扩面」（按公司 topic 的 entity:* 标签把零文本命中候选扩进结果、整司名标题加权，
// 见上游 pool.ts companyOf/entityTag 逻辑），本仓 fork 从未吸收该特性（ym772 上游吸收调研
// 未纳；本地 pool.ts 无对应实现），故该用例按本地现役语义收紧断言——仅文本命中参与
// 相关性、tag-only 候选不入列，其余回归价值（withdrawn 过滤、total 计数、排序确定性）
// 原样保留。适配点仅此一处。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadPool, publicMatchCondition, searchTerms } from "@aihot/backend/publication/pool";

const T = `relevance-${tag()}`;
const now = new Date("2026-01-01T12:00:00Z");
const id = (suffix: string) => `${T}-${suffix}`;
const query = (q: string) => ({ channel: "all" as const, category: null, tag: null, tab: "relevance" as const, q, now });
after(closeDb);
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${T}, ${T}, 'rss', 'T1')`;
});

async function add(suffix: string, direct: string, body: string, options: {
  title?: string; age?: number; channel?: "news" | "x"; category?: string; tags?: string[];
  visibility?: string; eligible?: boolean; future?: boolean; noSearchRow?: boolean;
} = {}) {
  const at = new Date(+now - (options.age ?? 60) * 1000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id(suffix)}, ${T}, ${id(suffix)}, ${`https://example.org/${id(suffix)}`}, ${options.title ?? "neutral"}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, category, tags, url, discovered_at, timeline_at, sort_at,
    selected, eligible, visibility, visible_after, search_text)
    VALUES (${id(suffix)}, ${options.title ?? "neutral"}, ${T}, ${options.channel ?? "news"}, ${options.category ?? "ai-models"}, ${options.tags ?? []},
      ${`https://example.org/${id(suffix)}`}, ${at}, ${at}, ${at}, ${options.future ?? false}, ${options.eligible ?? true},
      ${options.visibility ?? "public"}, ${options.future ? new Date(+now + 60_000) : at}, ${direct})`;
  if (!options.noSearchRow) await sql`INSERT INTO pool_search (article_id, direct, body) VALUES (${id(suffix)}, ${direct}, ${body})`;
}

test("short and multi-term relevance keep cross-field AND and deterministic score ties", async () => {
  await add("title", "zx qy", "zx qy", { title: "ZX QY", age: 100 });
  await add("cross-a", "zx", "qy", { age: 50 });
  await add("cross-z", "zx", "qy", { age: 50 });
  await add("body", "", "zx qy", { age: 1 });
  await add("partial", "zx", "zx", { age: 10 });
  await add("withdrawn", "zx qy", "zx qy", { visibility: "withdrawn" });
  await add("future", "zx qy", "zx qy", { future: true });
  await add("ineligible", "zx qy", "zx qy", { eligible: false });
  const multi = await loadPool(query("zx qy"));
  assert.deepEqual(multi.items.map(item => item.id), ["title", "cross-z", "cross-a", "body"].map(id));
  assert.equal(multi.total, 4);
  const single = await loadPool(query("zx"));
  assert.deepEqual(single.items.map(item => item.id), ["title", "partial", "cross-z", "cross-a", "body"].map(id));
  const beyond = await loadPool({ ...query("zx qy"), page: 2 });
  assert.deepEqual([beyond.items, beyond.total, beyond.pageCount], [[], 4, 1]);
});

test("company relevance retains tag-only candidates, boosts and unique totals", async () => {
  await add("company-both", "openai", "openai", { title: "OpenAI", tags: ["entity:openai"], age: 100 });
  await add("company-tag", "", "", { tags: ["entity:openai"], noSearchRow: true, age: 1 });
  await add("company-text", "openai qy", "openai", { title: "OpenAI", age: 60 });
  await add("company-low", "openai", "", { age: 1 });
  await add("company-withdrawn", "openai", "openai", { tags: ["entity:openai"], visibility: "withdrawn" });
  // [yn92 对位适配] 本地无整司别名扩面：tag-only 候选（company-tag）不参与文本相关性命中，
  // 整司标题加权同样不存在，排序由文本命中面+新近度决定（text age60 > both age100 > low age1）。
  const company = await loadPool(query("OpenAI"));
  assert.deepEqual(company.items.map(item => item.id), ["company-text", "company-both", "company-low"].map(id));
  assert.equal(company.total, 3, "only text-matching candidates count");
  const multi = await loadPool(query("openai qy"));
  assert.deepEqual(multi.items.map(item => item.id), [id("company-text")], "every term stays mandatory");
});

test("relevance retains combined filters and literal LIKE characters", async () => {
  await add("filtered", "uv", "uv", { channel: "x", category: "product", tags: [T] });
  await add("wrong-channel", "uv", "uv", { category: "product", tags: [T] });
  await add("wrong-category", "uv", "uv", { channel: "x", tags: [T] });
  await add("wrong-tag", "uv", "uv", { channel: "x", category: "product" });
  const filtered = await loadPool({ ...query("uv"), channel: "x", category: "product", tag: T });
  assert.deepEqual(filtered.items.map(item => item.id), [id("filtered")]);
  await add("literal", "qx%_\\z", "");
  await add("wildcard-lookalike", "qx-anything-z", "");
  assert.deepEqual((await loadPool(query("qx%_\\z"))).items.map(item => item.id), [id("literal")]);
});

test("search terms split where Han meets a Latin word, not before digits", () => {
  assert.deepEqual(searchTerms("多模态RAG"), ["多模态", "rag"]);
  assert.deepEqual(searchTerms("claude code更新 gpt-5 deepseek v4"), ["claude", "code", "更新", "gpt-5", "deepseek", "v4"]);
  assert.deepEqual(searchTerms("v4版本"), ["v4", "版本"]);
  assert.deepEqual(searchTerms("10月"), ["10月"]);
});

test("public search needs a plain Latin term to start a word in the body", async () => {
  await add("kv-word", "", "a kv pipeline");
  await add("kv-han", "", "多模态kv系统");
  await add("kv-inside", "", "an mkv file");
  await add("kv-direct", "mkv", "");
  const found = async (q: string) => (await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p WHERE p.source_id = ${T} ${publicMatchCondition(searchTerms(q))}`)
    .map(r => r.article_id).sort();
  assert.deepEqual(await found("kv"), ["kv-direct", "kv-han", "kv-word"].map(id).sort());
});
