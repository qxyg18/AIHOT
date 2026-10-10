// 智谱关注（ym437）：解析纯函数（<Update> 块 / ## 活动段 / 定价免费行 / 公告页版本 / sitemap）
// 加上注入文本拉取与解读的完整扫描链——基线出刊（含 GLM-4.7-Flash 实锚）/ 同窗重跑零出刊 /
// 新条目与条目更新 / 基线超限下轮续出 / 解读失败标 pending 下轮补 / 解析失败停页不猜测 /
// sitemap 差分（定点页排除）/ 复核轮写回。全程零网络。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import {
  mdPlain, normalizeDate, parseNewReleases, parsePageVersion, parsePricingFreeRows, parsePromotion, parseSitemap,
} from "@aihot/backend/zhipuwatch/parse";
import { scanZhipuWatch, ZhipuDigestSchema, type DigestOutcome } from "@aihot/backend/zhipuwatch/scan";
import { reviewDueDigests } from "@aihot/backend/zhipuwatch/review";
import { ZHIPU_SITEMAP_URL, ZHIPU_SOURCES } from "@aihot/backend/zhipuwatch/sources";
import { getWatermarks, insertUpdate, saveDigest, type ZhipuUpdateRow } from "@aihot/backend/zhipuwatch/store";

const SRC = Object.fromEntries(ZHIPU_SOURCES.map((s) => [s.key, s.url])) as Record<string, string>;

// ---- 夹具：仿真实页面形态（2026-10-08 实拉快照的缩样） ----

const updateBlock = (label: string, desc: string, body: string) =>
  `<Update label="${label}" description="${desc}">\n  ${body}\n</Update>`;

const releasesMd = (blocks: Array<[string, string, string]>) =>
  "# 模型与产品发布记录\n\n> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.bigmodel.cn/llms.txt\n\n## 公告通知\n\n" +
  blocks.map(([l, d, b]) => updateBlock(l, d, b)).join("\n\n") + "\n";

const promotionMd = (...sections: Array<[string, string]>) =>
  "# 上新活动\n\n" + sections.map(([h, b]) => `## **${h}**\n\n${b}`).join("\n\n") + "\n";

const pricingMd = (rows: string[]) =>
  "# API 定价\n\n## 模型推理\n\n| 模型名称 | 上下文 | 输入单价 | 输出单价 | 缓存存储 | 缓存命中 |\n| - | - | - | - | - | - |\n" +
  rows.join("\n") + "\n";

const sitemapXml = (urls: Array<[string, string]>) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(([u, m]) => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${m}</lastmod>\n  </url>`).join("\n") + "\n</urlset>\n";

const RELEASE_53: [string, string, string] = ["2026-08-26", "GLM-5.3-Flash 原生多模态模型上线", "原生融入视觉能力；总参 320B，激活 18B。"];
const RELEASE_47: [string, string, string] = ["2026-01-19", "GLM-4.7-Flash 免费模型上线", "GLM-4.7-Flash 为 GLM-4.7 的免费版本，输入与输出单价均为免费，上下文 200K。"];
const RELEASE_OLD: [string, string, string] = ["2025-04-14", "一站式 AI 搜索工具全家桶更新升级", "搜索工具更新。"];
const PRICE_FREE_47F = "| GLM-4.7-Flash | 200K | 免费 | 免费 | 限时免费 | 免费 |";
const PRICE_FREE_4F = "| GLM-4-Flash-250414 | 128K | 免费 | 免费 | 限时免费 | 不支持 |";
const PRICE_PAID = "| GLM-5.3 | 1M | 8 | 28 | 限时免费 | 2 | 文本 |";
const OVERVIEW_URL = "https://docs.bigmodel.cn/cn/coding-plan/overview";
const NEW_PROMO_URL = "https://docs.bigmodel.cn/cn/coding-plan/notice/new-promo";

const pages = new Map<string, string>();
const fetchText = async (url: string): Promise<string> => {
  const v = pages.get(url);
  if (v === undefined) throw new Error(`unexpected fetch ${url}`);
  return v;
};

const okDigest = (row: { id: number; title: string }): DigestOutcome => ({
  ok: true,
  digest: { overview: `第 ${row.id} 期概览：${row.title}`, items: [{ title: row.title, plain: "说明" }], adopt: [], caution: [], confidence: 0.9 },
  receiptId: 700_000 + row.id,
  error: null,
});

const rowCount = async (): Promise<number> => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM zhipu_updates`)[0]!.n;
const byTitle = async (title: string): Promise<ZhipuUpdateRow> => {
  const rows = await sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates WHERE title = ${title} ORDER BY id DESC`;
  return rows[0]!;
};

before(async () => {
  await sql`DELETE FROM zhipu_updates`;
  await sql`DELETE FROM settings WHERE key IN ('zhipuwatch.watermarks', 'zhipuwatch.lastrun', 'zhipuwatch.pool', 'zhipu.plan_window', 'zhipuwatch.failstreak')`; // ym438：信号动作会写免费池/窗口键
  pages.set(SRC["new-releases"]!, releasesMd([RELEASE_53, RELEASE_47, RELEASE_OLD]));
  pages.set(SRC["promotion"]!, promotionMd(["活动一：GLM Coding Plan 编码畅享计划", "活动期间，GLM Coding Plan 低至 20 元/月。"], ["活动二：拼好模 · 邀请有礼", "首单 9 折。"]));
  pages.set(SRC["free-night-event"]!, "# 夜间畅用活动\n\n> 本文提及的所有时间均以北京时间（UTC+8）为准\n\n9 月 3 日至 10 月 7 日，每晚 23 点至次日 9 点免费使用 GLM-5.3-Flash。\n");
  pages.set(SRC["plan-usage-revision"]!, "# 老用户权益说明\n\n> 公告发布时间：2026 年 7 月 30 日\n\n2026 年 7 月 30 日 GLM Coding Plan 套餐改版，老用户权益不受影响。\n");
  pages.set(SRC["pricing"]!, pricingMd([PRICE_PAID, PRICE_FREE_47F, PRICE_FREE_4F]));
  pages.set(ZHIPU_SITEMAP_URL, sitemapXml([
    [OVERVIEW_URL, "2026-09-23T00:00:00.000Z"],
    ["https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision", "2026-09-29T00:00:00.000Z"],
    ["https://docs.bigmodel.cn/api-reference/agent-api/对话历史", "2026-09-21T00:00:00.000Z"],
  ]));
});

after(async () => {
  await sql`DELETE FROM zhipu_updates`;
  await sql`DELETE FROM settings WHERE key IN ('zhipuwatch.watermarks', 'zhipuwatch.lastrun', 'zhipuwatch.pool', 'zhipu.plan_window', 'zhipuwatch.failstreak')`; // ym438：信号动作会写免费池/窗口键
  await closeDb();
});

// ---- 解析纯函数 ----

test("parseNewReleases：<Update> 块倒序保留、日期补零；缺块抛错（禁猜测解析）", () => {
  const items = parseNewReleases(releasesMd([["2026-8-19", "GLM-5.3 上线", "正文 A"], ["2026-01-19", "GLM-4.7-Flash 免费模型上线", "正文 B"]]));
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "GLM-5.3 上线");
  assert.equal(items[0]!.publishedAt, "2026-08-19T00:00:00+08:00");
  assert.equal(items[1]!.publishedAt, "2026-01-19T00:00:00+08:00");
  assert.throws(() => parseNewReleases("# 结构改版了\n"), /结构不匹配/);
});

test("parsePricingFreeRows：只认价格列为「免费」的行（限时免费缓存噪声排除）；无免费行抛错", () => {
  const items = parsePricingFreeRows(pricingMd([PRICE_PAID, PRICE_FREE_47F, PRICE_FREE_4F]));
  assert.deepEqual(items.map((i) => i.title), [
    "GLM-4.7-Flash：输入 免费 / 输出 免费",
    "GLM-4-Flash-250414：输入 免费 / 输出 免费",
  ]);
  assert.throws(() => parsePricingFreeRows(pricingMd([PRICE_PAID])), /结构不匹配/);
});

test("parsePromotion / parsePageVersion / parseSitemap / mdPlain 基础形态", () => {
  const promo = parsePromotion(promotionMd(["活动一：编码畅享", "内容一"], ["活动二：邀请有礼", "内容二"]));
  assert.deepEqual(promo.map((p) => p.key), ["活动一：编码畅享", "活动二：邀请有礼"]);
  const page = parsePageVersion("# 夜间畅用活动\n\n9 月 3 日至 10 月 7 日免费使用。\n");
  assert.equal(page.length, 1);
  assert.equal(page[0]!.key, "page");
  assert.throws(() => parsePageVersion("没有标题\n"), /结构不匹配/);
  assert.deepEqual(parseSitemap(sitemapXml([["https://docs.bigmodel.cn/a", "2026-01-01T00:00:00.000Z"]])), [
    { url: "https://docs.bigmodel.cn/a", lastmod: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.throws(() => parseSitemap("<urlset></urlset>"), /结构不匹配/);
  assert.equal(mdPlain("> 引用行\n[**GLM-5.3**](/cn/x)\n正文"), "GLM-5.3\n正文");
  assert.equal(normalizeDate("不是日期"), null);
});

test("strList 宽容归一：对象数组→字符串（生产首扫 MIMO 14/27 次此形态，内容不丢）", () => {
  const parsed = ZhipuDigestSchema.parse({
    overview: "概览",
    items: [{ title: "条目", plain: "说明" }],
    adopt: [{ action: "把免费模型接入路由", reason: "输出全免费" }, "纯字符串条目"],
    caution: [{ note: "活动 10-07 已到期" }],
    confidence: 0.8,
  });
  assert.deepEqual(parsed.adopt, ["把免费模型接入路由——输出全免费", "纯字符串条目"]);
  assert.deepEqual(parsed.caution, ["活动 10-07 已到期"]);
});

// ---- 扫描链（注入拉取与解读） ----

test("首轮基线：5 页出刊（含 GLM-4.7-Flash 实锚），解读写回，sitemap 只记水位", async () => {
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.ok, true);
  assert.deepEqual(s.errors, []);
  assert.equal(s.updates, 9, "3 条发布 + 2 段活动 + 公告页 1 + 套餐改版页 1 + 2 行免费定价");
  assert.equal(s.digested, 9);
  assert.equal(s.pending, 0);
  assert.ok(s.notes.some((n) => n.includes("sitemap 首轮基线")), "sitemap 首轮只记水位");
  const anchor = await byTitle("GLM-4.7-Flash 免费模型上线");
  assert.equal(anchor.kind, "model_release");
  assert.equal(anchor.payload.trigger, "baseline");
  assert.equal(anchor.payload.publishedAt, "2026-01-19T00:00:00+08:00");
  assert.ok(anchor.published_at, "published_at 落库");
  assert.equal(anchor.digest_status, "done");
  assert.equal(anchor.receipt_id, 700_000 + anchor.id);
  assert.equal((await rowCount()), 9);
  const marks = await getWatermarks();
  assert.ok(marks.pages["new-releases"]!.hash, "整页 hash 已记");
  assert.equal(Object.keys(marks.pages["new-releases"]!.items).length, 3);
  assert.equal(marks.sitemap!.lastmods[OVERVIEW_URL], "2026-09-23T00:00:00.000Z");
  assert.equal(marks.sitemap!.lastmods["https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision"], undefined,
    "定点页被 sitemap 排除（不重复出刊）");
});

test("同窗重跑零出刊：水位幂等，不重复出刊不重复解读", async () => {
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.ok, true);
  assert.equal(s.updates, 0);
  assert.equal(s.digested, 0);
  assert.deepEqual(s.notes, []);
  assert.equal(await rowCount(), 9);
});

test("新条目出刊（trigger=new）；条目内容变化出更新刊（trigger=updated）", async () => {
  pages.set(SRC["new-releases"]!, releasesMd([["2026-09-10", "GLM-5.4 上线", "新旗舰。"], RELEASE_53, RELEASE_47, RELEASE_OLD]));
  const s1 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s1.updates, 1);
  assert.equal((await byTitle("GLM-5.4 上线")).payload.trigger, "new");

  pages.set(SRC["new-releases"]!, releasesMd([["2026-09-10", "GLM-5.4 上线", "新旗舰，补充：支持 1M 上下文。"], RELEASE_53, RELEASE_47, RELEASE_OLD]));
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s2.updates, 1, "同标题同日期、内容变了 → 出一条更新刊");
  const updated = await byTitle("GLM-5.4 上线");
  assert.equal(updated.payload.trigger, "updated");
  assert.ok(String(updated.payload.text).includes("1M 上下文"));
});

test("解读失败只标 pending 不阻塞采集，下一轮补解读且不再出刊", async () => {
  pages.set(SRC["new-releases"]!, releasesMd([["2026-09-12", "GLM-5.5 上线", "又一版。"], ["2026-09-10", "GLM-5.4 上线", "新旗舰，补充：支持 1M 上下文。"], RELEASE_53, RELEASE_47, RELEASE_OLD]));
  const s1 = await scanZhipuWatch({ fetchText, digestOne: async () => ({ ok: false, digest: null, receiptId: null, error: "模型熔断" }) });
  assert.equal(s1.updates, 1);
  assert.equal(s1.pending, 1);
  assert.equal((await byTitle("GLM-5.5 上线")).digest_status, "pending");
  const before = await rowCount();
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s2.updates, 0, "水位未动，不出新刊");
  assert.equal(s2.digested, 1, "pending 被补解读");
  assert.equal(await rowCount(), before);
  assert.equal((await byTitle("GLM-5.5 上线")).digest_status, "done");
});

test("页面结构解析不出：该页记错误、水位不动、零猜测条目；恢复后可继续出刊", async () => {
  const hashBefore = (await getWatermarks()).pages["new-releases"]!.hash;
  const rowsBefore = await rowCount();
  pages.set(SRC["new-releases"]!, "# 模型与产品发布记录\n\n页面改版，没有 Update 块了。\n");
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.ok, false);
  assert.ok(s.errors.some((e) => e.startsWith("new-releases:")), "该页错误在列");
  assert.equal(s.updates, 0, "不落猜测条目");
  assert.equal(await rowCount(), rowsBefore);
  assert.equal((await getWatermarks()).pages["new-releases"]!.hash, hashBefore, "水位不动，下轮重试");

  pages.set(SRC["new-releases"]!, releasesMd([["2026-09-20", "GLM-5.6 上线", "恢复后新条目。"], ["2026-09-12", "GLM-5.5 上线", "又一版。"], ["2026-09-10", "GLM-5.4 上线", "新旗舰，补充：支持 1M 上下文。"], RELEASE_53, RELEASE_47, RELEASE_OLD]));
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s2.updates, 1);
  assert.equal((await byTitle("GLM-5.6 上线")).payload.trigger, "new");
});

test("sitemap 差分：存量页 lastmod 变化出更新刊、新页出刊（kind 按 /notice/ 判别）", async () => {
  pages.set(`${OVERVIEW_URL}.md`, "# 套餐概览\n\nLite 49 元/月，Pro 149 元/月。\n");
  pages.set(`${NEW_PROMO_URL}.md`, "# 新活动公告\n\n限时优惠，截止 11 月 30 日。\n");
  pages.set(ZHIPU_SITEMAP_URL, sitemapXml([
    [OVERVIEW_URL, "2026-10-08T00:00:00.000Z"],
    [NEW_PROMO_URL, "2026-10-08T00:00:00.000Z"],
    ["https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision", "2026-09-29T00:00:00.000Z"],
    ["https://docs.bigmodel.cn/api-reference/agent-api/对话历史", "2026-09-21T00:00:00.000Z"],
  ]));
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.updates, 2);
  const newPromo = await byTitle("新活动公告");
  assert.equal(newPromo.kind, "plan_promo");
  assert.equal(newPromo.payload.trigger, "new");
  const overview = await byTitle("套餐概览");
  assert.equal(overview.kind, "other");
  assert.equal(overview.payload.trigger, "updated");
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s2.updates, 0, "sitemap 水位加一后重跑零出刊");
});

test("增量超上限：按上限出刊并记观察，水位冻结下轮续出，最终零重复", async () => {
  const many: Array<[string, string, string]> = Array.from({ length: 13 }, (_, i) => [`2026-10-0${(i % 9) + 1}`, `GLM-批量 ${i + 1} 号上线`, `第 ${i + 1} 条。`]);
  pages.set(SRC["new-releases"]!, releasesMd([...many, ["2026-09-20", "GLM-5.6 上线", "恢复后新条目。"], ["2026-09-12", "GLM-5.5 上线", "又一版。"], ["2026-09-10", "GLM-5.4 上线", "新旗舰，补充：支持 1M 上下文。"], RELEASE_53, RELEASE_47, RELEASE_OLD]));
  const before = await rowCount();
  const s1 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s1.updates, 12, "每轮上限 12");
  assert.ok(s1.notes.some((n) => n.includes("还有 1 条待下轮")), "超限进观察");
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s2.updates, 1, "水位冻结，下轮续出剩余");
  const s3 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s3.updates, 0);
  assert.equal(await rowCount() - before, 13, "13 条不重不漏");
});

test("基线截取：只出最新 N 条、其余只记水位不追历史；水位完整推进，重跑零出刊", async () => {
  // 用 promotion 页构造 15 段（干净水位下走到基线分支）；依据=decisions.md D2（卡面「有料才出刊」+oss 先例）。
  await sql`DELETE FROM settings WHERE key = 'zhipuwatch.watermarks'`;
  await sql`DELETE FROM zhipu_updates WHERE url = ${SRC["promotion"]}`;
  pages.set(SRC["promotion"]!, promotionMd(...Array.from({ length: 15 }, (_, i) => [`活动 ${i + 1} 期`, `内容 ${i + 1}。`] as [string, string])));
  const promoRows = async (): Promise<number> =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM zhipu_updates WHERE url = ${SRC["promotion"]}`)[0]!.n;
  const s1 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(await promoRows(), 12, "基线上限 12");
  assert.ok(s1.notes.some((n) => n.includes("其余 3 条只记水位")), "截取进观察");
  const wm = (await getWatermarks()).pages["promotion"]!;
  assert.ok(wm.hash, "整页 hash 完整推进（不追历史）");
  assert.equal(Object.keys(wm.items).length, 15, "15 段全记水位");
  const s2 = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(await promoRows(), 12, "旧条目不再续出（不追全历史）");
  assert.equal(s2.updates, 0);
});

// ---- 复核轮 ----

test("复核轮：done 未复核行按轮上限全审、结果写回；再跑幂等；失败保持未复核", async () => {
  const unreviewed = async (): Promise<number> =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM zhipu_updates WHERE digest_status = 'done' AND review_status IS NULL`)[0]!.n;
  const due = await unreviewed();
  assert.ok(due >= 1, "有未复核行");
  let total = 0;
  for (let i = 0; i < 5 && (await unreviewed()) > 0; i++) {
    const s = await reviewDueDigests({
      reviewOne: async () => ({ ok: true, review: { verdict: "issues", issues: ["活动已过期却写成正在进行"], confidence: 0.9 }, receiptId: 800_001, error: null }),
    });
    assert.equal(s.failed, 0);
    assert.ok(s.reviewed <= 20, "每轮上限 20（先到先审，其余下轮）");
    total += s.reviewed;
  }
  assert.equal(total, due);
  assert.equal(await unreviewed(), 0);
  const again = await reviewDueDigests({ reviewOne: async () => { throw new Error("不应再审"); } });
  assert.equal(again.reviewed, 0);

  const fresh = await insertUpdate({
    kind: "other", title: "复核失败样本", url: "https://docs.bigmodel.cn/x", publishedAt: null,
    payload: { sourceLabel: "测试", text: "材料" }, dedupKey: "test|复核失败样本",
  });
  await saveDigest(fresh!.id, { overview: "概览", items: [{ title: "条目", plain: "说明" }], adopt: [], caution: [], confidence: 0.9 }, 1);
  const failed = await reviewDueDigests({ reviewOne: async () => ({ ok: false, review: null, receiptId: null, error: "复核模型熔断" }) });
  assert.equal(failed.reviewed, 0);
  assert.equal(failed.failed, 1);
  const row = (await sql<ZhipuUpdateRow[]>`SELECT * FROM zhipu_updates WHERE id = ${fresh!.id}`)[0]!;
  assert.equal(row.review_status, null, "保持未复核，下轮再试");
});
