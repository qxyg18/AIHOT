// yn66 承接修复：Jina Reader 不配 key 时走匿名免费档（约 20 次/分钟），配了 key 才带付费凭据。
// 这里锁住两条路径的请求头差异，防止以后又把「没有 key」当成错误。
import assert from "node:assert/strict";
import { test } from "node:test";
import { jinaAuthHeaders, parseJinaText } from "@aihot/backend/providers/jina";

test("anonymous Jina requests carry no credentials", () => {
  assert.deepEqual(jinaAuthHeaders(null), {});
});

test("a configured key keeps the bearer header", () => {
  assert.deepEqual(jinaAuthHeaders("jina-key"), { authorization: "Bearer jina-key" });
});

test("the anonymous response shape parses like the keyed one", () => {
  const page = parseJinaText("Title: 示例标题\nURL Source: https://example.org/a\nPublished Time: 2026-10-24\n\nMarkdown Content:\n\n正文内容");
  assert.equal(page.title, "示例标题");
  assert.equal(page.url, "https://example.org/a");
  assert.equal(page.publishedTime, "2026-10-24");
  assert.equal(page.markdown, "正文内容");
});
