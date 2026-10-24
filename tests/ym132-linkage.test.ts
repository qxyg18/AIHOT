// ym132 二期两枚关键谓词的持久回归：(a) 研报洞见入队闸覆盖全部编辑类目；(b) 品牌档案重摘要
// 触发精确落在「晚于上次摘要的 approved 信号」上——走真实 upsertCollected 代码路径（触发时为纯净
// 断言：source_hash 不变、不走模型调用；真实摘要由周批在触发后执行）。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { insightEligible } from "@aihot/backend/jobs/content";
import { upsertCollected } from "@aihot/backend/brandprofiles/refresh";
import { upsertMaterial } from "@aihot/backend/content/materials";

const T = tag();
const SRC = `test-ym132-src-${T}`;
const BRAND = `test-ym132-brand-${T}`;
const PROF = `test-ym132-prof-${T}`;
const DRAFT = `test-ym132-draft-${T}`;

after(async () => {
  await sql`DELETE FROM entity_signal_drafts WHERE entity_slug = ${BRAND}`;
  await sql`DELETE FROM brand_profiles WHERE slug = ${BRAND}`;
  await sql`DELETE FROM articles WHERE source_id = ${SRC}`;
  await sql`DELETE FROM sources WHERE id = ${SRC}`;
  await closeDb();
});

test("insight gate: every editorial category passes; non-pass, unknown and null never do", () => {
  for (const c of CATEGORIES) assert.equal(insightEligible("pass", c.key), true, c.key);
  assert.equal(insightEligible("block", "industry"), false);
  assert.equal(insightEligible("pass", "nope"), false);
  assert.equal(insightEligible("pass", null), false);
  assert.equal(insightEligible(null, "industry"), false);
});

test("re-summarise trigger: a newer approved signal re-queues a ready profile; rejected never does", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SRC}, 'ym132 trigger', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.com/${T}`, title: "ym132 trigger",
    bodyText: "trigger body", bodyHtml: "<p>trigger</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO brand_profiles (id, slug, name, status, source_hash, summarized_at)
            VALUES (${PROF}, ${BRAND}, '触发品牌', 'ready', 'h1', now() - interval '2 days')`;
  await sql`INSERT INTO entity_signal_drafts (id, article_id, entity_type, entity_slug, entity_name, kind, value, unit, caliber, quote, status, reviewed_at)
            VALUES (${DRAFT}, ${articleId}, 'brand', ${BRAND}, '触发品牌', 'openings', 5, '家', '新开店数', '触发引文', 'approved', now() - interval '1 day')`;
  const c = { slug: BRAND, name: "触发品牌", wikiUrl: null, baikeUrl: null, evidence: "", sourceText: "same text", sourceHash: "h1" };
  // 源文本未变、行 ready，但有晚于 summarized_at 的 approved 信号 → 需重摘要
  assert.equal(await upsertCollected(c), true);
  // 摘要完成（summarizeRow 置回 ready+summarized_at）→ 不再触发
  await sql`UPDATE brand_profiles SET summarized_at = now(), status = 'ready' WHERE slug = ${BRAND}`;
  assert.equal(await upsertCollected(c), false);
  // 晚于摘要的草稿为 rejected（非 approved）→ 不触发
  await sql`UPDATE entity_signal_drafts SET status = 'rejected' WHERE id = ${DRAFT}`;
  await sql`UPDATE brand_profiles SET summarized_at = now() - interval '2 days', status = 'ready' WHERE slug = ${BRAND}`;
  assert.equal(await upsertCollected(c), false);
});
