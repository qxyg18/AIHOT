// yn42（48h 审计 M2）：归档触发器按列名 COPY + entity_signal_drafts 人工审核记录留底。
//
// 两个判别性命题：
//   A. 主表加列后 DELETE 仍工作（0060 前 publications/analyses 是 SELECT OLD.* 位置拷贝，
//      加列会让 COPY 类型错位 → BEFORE DELETE 触发器抛错 → DELETE 整条路径硬失败）。
//   B. 删文章时 entity_signal_drafts 的人工审核记录进留底表（0060 前 ON DELETE CASCADE
//      直接把 approved/rejected + review_note 带走，0045 头注释「recomputable」不成立）。
//
// 红绿取法：把 0060 的迁移文件临时移出再重跑本测试 → A 应抛错、B 应查无留底（红）；
// 0060 在位 → 两条都过（绿）。测试自建样本并在结束时清理。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { tag } from "./setup.ts";

const T = tag();
const SRC = `yn42-src-${T}`;
let articleId = "";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC}, 'yn42 archive', 'rss', 'T1', 'editorial', '2100-01-01')`;
  articleId = `${T}a1`;
  const at = new Date(Date.now() - 60_000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${articleId}, ${SRC}, ${`yn42-${T}-1`}, ${`https://example.com/${T}/1`}, ${`YN42-${T}`}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, visibility, eligible, sort_at)
            VALUES (${articleId}, ${`YN42-${T}`}, ${SRC}, 'news', ${`https://example.com/${T}/1`}, ${at}, ${at}, 'public', true, ${at})`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题${T}`}, ${`摘要${T}`}, '理由', 88, true)`;
  // 一条已人工审核的草稿（approved + review_note）：不可由任何作业重建。
  await sql`INSERT INTO entity_signal_drafts (id, article_id, entity_type, entity_slug, entity_name, kind, value, unit, quote, status, review_note, reviewed_at)
            VALUES (${`${T}d1`}, ${articleId}, 'brand', ${`brand-${T}`}, ${`品牌${T}`}, 'openings', 7, '家', '引文', 'approved', ${`人工复核备注${T}`}, now())`;
});

after(async () => {
  // 归档表 append-only（0048/0060 守卫），清理只能走整表测试隔离：本测试用独立 source id，
  // 残留行只占归档表，不影响其他用例（与既有 0045 测试同法）。
  await sql`DELETE FROM articles WHERE source_id = ${SRC}`.catch(() => undefined);
  await sql`DELETE FROM sources WHERE id = ${SRC}`.catch(() => undefined);
  await closeDb();
});

test("A 主表加列后 DELETE 仍工作：publications/analyses 归档按列名拷贝（0060 判别）", async () => {
  // 加一列到 publications（模拟未来 ALTER ADD COLUMN）——位置 COPY 在此后必然错位。
  await sql`ALTER TABLE publications ADD COLUMN IF NOT EXISTS yn42_probe_col text`;
  await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS yn42_probe_col text`;
  try {
    // 三表各删一行：任何一处触发器错位都会让 DELETE 抛错。
    await sql`DELETE FROM analyses WHERE article_id = ${articleId}`;
    await sql`DELETE FROM publications WHERE article_id = ${articleId}`;
    await sql`DELETE FROM articles WHERE id = ${articleId}`;

    const [a] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses_archived WHERE article_id = ${articleId}`;
    const [p] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM publications_archived
      WHERE article_id = ${articleId} AND title = ${`YN42-${T}`} AND visibility = 'public'`;
    const [ar] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM articles_archived
      WHERE id = ${articleId} AND title = ${`YN42-${T}`} AND source_id = ${SRC}`;
    assert.equal(a!.n, 1, "analyses 归档行必须完整（按名拷贝）");
    assert.equal(p!.n, 1, "publications 归档行必须完整（按名拷贝，visibility 未错位）");
    assert.equal(ar!.n, 1, "articles 归档行必须完整");
  } finally {
    await sql`ALTER TABLE publications DROP COLUMN IF EXISTS yn42_probe_col`;
    await sql`ALTER TABLE analyses DROP COLUMN IF EXISTS yn42_probe_col`;
  }
});

test("B 删文章时人工审核草稿进留底表（0060 前 CASCADE 会直接带走）", async () => {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM entity_signal_drafts_archived
    WHERE article_id = ${articleId} AND status = 'approved' AND review_note = ${`人工复核备注${T}`}`;
  assert.equal(row!.n, 1, "approved + review_note 必须留在留底表（人工决策不可重建）");

  const [live] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM entity_signal_drafts WHERE article_id = ${articleId}`;
  assert.equal(live!.n, 0, "主表草稿行已随文章删除");
});
