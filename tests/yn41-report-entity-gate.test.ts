// yn41（48h 审计 M1）：日报实体标签的兜底实时匹配必须与主查询同闸（public × editorial）。
// 主查询按 publications×sources 联表带闸，兜底分支原先是 articles 裸查——标注表暂空的窗口里，
// 源不属编辑口径（hot_signal / isolated）的文章会绕过闸拿到实体标签，与文章页口径不一致。
//
// 判别性验证（红绿双证，全部走 loadReport 真实读面，不复述修复 SQL）：
//   · 改前：hot_signal 源 / isolated 源文章经兜底命中实体词 → 附标签（红，实测 1≠0）
//   · 改后：两类都不附标签（绿）
//   · 阳性对照：public × editorial 文章始终附标签，证明补闸没有误伤正常路径。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadReport } from "@aihot/backend/publication/reports";
import { tag } from "./setup.ts";

const T = tag();
const SRC_ED = `yn41-ed-${T}`;
const SRC_HOT = `yn41-hot-${T}`;
const SRC_ISO = `yn41-iso-${T}`;
const REPORT_KEY = `2098-11-${String(10 + Math.floor(Math.random() * 19))}`;
// 种子词库里的真实品牌：兜底实时匹配需要能命中的词。
const BRAND_WORD = "巴拉巴拉";

let n = 0;
/** 一篇文章（可选 publications 行）。永不写标注行——本卡只测兜底路径。 */
async function article(opts: {
  sourceId: string;
  visibility?: "public" | "summary-only" | "withdrawn";
  withPublication?: boolean;
  title: string;
}): Promise<string> {
  n += 1;
  const id = `${T}a${n}`;
  const at = new Date(Date.now() - n * 60_000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, excerpt, body_text, discovered_at, timeline_at)
            VALUES (${id}, ${opts.sourceId}, ${`yn41-${T}-${n}`}, ${`https://example.com/${T}/${n}`}, ${opts.title}, ${opts.title}, ${opts.title}, ${at}, ${at})`;
  if (opts.withPublication ?? true) {
    // eligible=true：日报条目可用性判据是 public × eligible，与实体闸正交，但同批 id 要先过这一关。
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, visibility, eligible, sort_at)
              VALUES (${id}, ${opts.title}, ${opts.sourceId}, 'news', ${`https://example.com/${T}/${n}`}, ${at}, ${at},
                      ${opts.visibility ?? "public"}, true, ${at})`;
  }
  return id;
}

/** 造一份引用这些条目的日报，返回按 itemId 索引的实体标签数量。 */
async function entitiesByItem(ids: Array<[string, string]>): Promise<Map<string, number>> {
  const content = {
    sections: [{ label: "品牌", items: ids.map(([id, name]) => ({
      itemId: id, title: `${name}-${T}`, summary: `${name}SUM-${T}`,
      sourceUrl: `https://example.com/${T}/${name}`, sourceName: "Test",
    })) }],
    flashes: [],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${REPORT_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
  const report = await loadReport("daily", REPORT_KEY);
  assert.ok(report, "日报必须可读");
  const out = new Map<string, number>();
  for (const i of report!.sections.flatMap((s) => s.items)) {
    if (i.itemId) out.set(i.itemId, (i.entities ?? []).length);
  }
  return out;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC_ED}, 'yn41 editorial', 'rss', 'T1', 'editorial', '2100-01-01'),
                   (${SRC_HOT}, 'yn41 hot signal', 'rss', 'T1', 'hot_signal', '2100-01-01'),
                   (${SRC_ISO}, 'yn41 isolated', 'rss', 'T1', 'isolated', '2100-01-01')`;
});

after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${REPORT_KEY}`;
  await sql`DELETE FROM articles WHERE source_id IN (${SRC_ED}, ${SRC_HOT}, ${SRC_ISO})`;
  await sql`DELETE FROM sources WHERE id IN (${SRC_ED}, ${SRC_HOT}, ${SRC_ISO})`;
  await closeDb();
});

test("日报读面：非编辑源文章不因兜底附实体标签，公开编辑源文章仍附（红绿对拍）", async () => {
  // 三篇都 public × eligible（日报可用性判据），差别只在源口径；标注表刻意留空 → 只能走兜底。
  const open = await article({ sourceId: SRC_ED, title: `${BRAND_WORD} 新增门店` });
  const hot = await article({ sourceId: SRC_HOT, title: `${BRAND_WORD} 热信号报道` });
  const iso = await article({ sourceId: SRC_ISO, title: `${BRAND_WORD} 隔离源报道` });
  await sql`DELETE FROM article_entities WHERE article_id IN (${open}, ${hot}, ${iso})`;

  const got = await entitiesByItem([[open, "OPEN"], [hot, "HOT"], [iso, "ISO"]]);
  assert.ok(got.has(open) && got.has(hot) && got.has(iso), "三条引用都在日报里");
  assert.ok(got.get(open)! > 0, "public×editorial 文章经兜底仍附实体标签（阳性对照）");
  assert.equal(got.get(hot)!, 0, "热信号源文章不得经兜底附实体标签");
  assert.equal(got.get(iso)!, 0, "隔离源文章不得经兜底附实体标签");
});

test("日报读面：撤文与仅摘要文章同样不因兜底附标签（既有闸不被破坏）", async () => {
  const withdrawn = await article({ sourceId: SRC_ED, visibility: "withdrawn", title: `${BRAND_WORD} 撤稿稿` });
  const summaryOnly = await article({ sourceId: SRC_ED, visibility: "summary-only", title: `${BRAND_WORD} 仅摘要稿` });
  await sql`DELETE FROM article_entities WHERE article_id IN (${withdrawn}, ${summaryOnly})`;

  const got = await entitiesByItem([[withdrawn, "WD"], [summaryOnly, "SO"]]);
  assert.equal(got.get(withdrawn) ?? 0, 0, "撤文不得附实体标签");
  assert.equal(got.get(summaryOnly) ?? 0, 0, "仅摘要文章不得附实体标签");
});
