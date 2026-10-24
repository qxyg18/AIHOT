// 雷达智谱动态联动（ym438）：信号分类与窗口公告解析纯函数（判别面：多窗口/无年份/无时段拒写，
// 非文本家族与低于路由闸不接入）+ 扫描链信号→动作集成（免费池自动接入/窗口自动写/歧义拒写/
// manual 不覆写/同窗重扫零重复动作）+ 窗口两层求值（常量层 ∨ settings 层，摘窗=范围外失效）+
// 连续失败自动摘池（3 轮全失败置 filtered，成功清零）+ ops 日报免费占比行。全程零网络零模型调用。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { classifyItem, contextTokensOf, onboardEligible, parseWindowNotice } from "@aihot/backend/zhipuwatch/signals";
import {
  getZhipuPool, nextFailStreak, onboardZhipuModel, recordZhipuRoundOutcomes, ZHIPU_POOL_DEFAULT, type FailStreak,
} from "@aihot/backend/zhipuwatch/pool";
import { scanZhipuWatch, type DigestOutcome } from "@aihot/backend/zhipuwatch/scan";
import { getWatermarks } from "@aihot/backend/zhipuwatch/store";
import {
  getPlanWindowRule, planActive, planWindowRuleActive, refreshPlanWindow, savePlanWindowRule,
} from "@aihot/backend/lib/windows";
import { collectFindings } from "@aihot/backend/operations/alerts";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const LINK_KEYS = ["zhipuwatch.pool", "zhipuwatch.failstreak", "zhipu.plan_window"];
const TEST_MODEL = "zhipu:glm-z9-flash";

// ---- 夹具：仿真实页面形态（夜间畅用活动=2026-10-08 生产实拉文本缩样） ----

const NOTICE_WINDOW = `# 夜间畅用活动

> 本文提及的所有时间均以北京时间（UTC+8）为准

9 月 3 日至 10 月 7 日，GLM Coding Plan 推出夜间畅用活动，每晚 23 点至次日 9 点，调用套餐中的 GLM-5.3-Flash 免费。

* 活动时间：2026 年 9 月 3 日至 2026 年 10 月 7 日（活动截止时间已从 9 月 20 日延期至 10 月 7 日）。
* 错峰时段（每日 23:00 至次日 09:00）内免费。
`;

const RELEASES_MD = `# 模型与产品发布记录

<Update label="2026-01-19" description="GLM-Z9-Flash 免费模型上线">
  GLM-Z9-Flash 为免费版本，输入与输出单价均为免费，上下文 300K。
</Update>
`;

const pricingMd = (rows: string[]) =>
  "# API 定价\n\n| 模型名称 | 上下文 | 输入单价 | 输出单价 | 缓存存储 | 缓存命中 |\n| - | - | - | - | - | - |\n" +
  rows.join("\n") + "\n";

const PRICE_47F = "| GLM-4.7-Flash | 200K | 免费 | 免费 | 限时免费 | 免费 |";
const PRICE_Z9 = "| GLM-Z9-Flash | 300K | 免费 | 免费 | 限时免费 | 免费 |";
const PRICE_4V = "| GLM-4V-Flash | 4K | 免费 | 免费 | 限时免费 | 不支持 |";
const PRICE_COGVIEW = "| CogView-3-Flash | 图像生成 | 多分辨率 | 免费 | 不支持 |";
const PRICE_4F = "| GLM-4-Flash-250414 | 128K | 免费 | 免费 | 限时免费 | 不支持 |";

const SRC = {
  releases: "https://docs.bigmodel.cn/cn/update/new-releases.md",
  promotion: "https://docs.bigmodel.cn/cn/update/promotion.md",
  notice: "https://docs.bigmodel.cn/cn/coding-plan/notice/event-glm-5.3-flash.md",
  revision: "https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision.md",
  pricing: "https://docs.bigmodel.cn/cn/guide/start/pricing.md",
  sitemap: "https://docs.bigmodel.cn/sitemap.xml",
};

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.bigmodel.cn/cn/coding-plan/overview</loc><lastmod>2026-09-23T00:00:00.000Z</lastmod></url>
</urlset>
`;

const pages = new Map<string, string>();
const fetchText = async (url: string): Promise<string> => {
  const v = pages.get(url);
  if (v === undefined) throw new Error(`unexpected fetch ${url}`);
  return v;
};

const okDigest = (row: { id: number; title: string }): DigestOutcome => ({
  ok: true,
  digest: { overview: `第 ${row.id} 期：${row.title}`, items: [{ title: row.title, plain: "说明" }], adopt: [], caution: [], confidence: 0.9 },
  receiptId: 900_000 + row.id,
  error: null,
});

const byTitle = async (title: string) =>
  (await sql<{ id: number; kind: string; routing_action: Record<string, unknown> | null }[]>`SELECT id, kind, routing_action FROM zhipu_updates WHERE title = ${title} ORDER BY id DESC`)[0]!;

before(async () => {
  await getBoss(); // collectFindings 读 pgboss.job 表
  await sql`DELETE FROM zhipu_updates`;
  await sql`DELETE FROM settings WHERE key IN ('zhipuwatch.watermarks', 'zhipuwatch.lastrun', ${LINK_KEYS[0]}, ${LINK_KEYS[1]}, ${LINK_KEYS[2]})`;
  await sql`DELETE FROM model_watch_models WHERE model_id = ${TEST_MODEL}`;
  await sql`DELETE FROM model_watch_events WHERE model_id = ${TEST_MODEL}`;
  pages.set(SRC.releases, RELEASES_MD);
  pages.set(SRC.promotion, "# 上新活动\n\n## 活动一：拼好模\n\n首单 9 折。\n");
  pages.set(SRC.notice, NOTICE_WINDOW);
  pages.set(SRC.revision, "# 老用户权益说明\n\n2026 年 7 月 30 日套餐改版，老用户权益不受影响。\n");
  pages.set(SRC.pricing, pricingMd([PRICE_47F, PRICE_Z9, PRICE_4V, PRICE_COGVIEW, PRICE_4F]));
  pages.set(SRC.sitemap, sitemapXml);
});

after(async () => {
  await sql`DELETE FROM zhipu_updates`;
  await sql`DELETE FROM settings WHERE key IN ('zhipuwatch.watermarks', 'zhipuwatch.lastrun', ${LINK_KEYS[0]}, ${LINK_KEYS[1]}, ${LINK_KEYS[2]})`;
  await sql`DELETE FROM model_watch_models WHERE model_id = ${TEST_MODEL}`;
  await sql`DELETE FROM model_watch_events WHERE model_id = ${TEST_MODEL}`;
  await stopBoss();
  await closeDb();
});

// ---- 窗口公告解析（判别面） ----

test("parseWindowNotice：全年份区间+无年份复述一致+双时段形 → 解析成立", () => {
  const r = parseWindowNotice(NOTICE_WINDOW);
  assert.equal(r.status, "parsed");
  if (r.status !== "parsed") return;
  assert.deepEqual(r.window, { from: "2026-09-03", to: "2026-10-07", daily: { start: "23:00", end: "09:00" } });
});

test("parseWindowNotice：多窗口/无年份/时段缺失/区间冲突 一律拒写候人工", () => {
  const multi = parseWindowNotice("* 活动时间：2026 年 9 月 3 日至 2026 年 10 月 7 日。\n* 第二阶段：2026 年 10 月 10 日至 2026 年 10 月 20 日。每日 23:00 至次日 09:00。");
  assert.equal(multi.status, "refused");
  assert.ok(multi.status === "refused" && multi.reason.includes("2 个活动日期区间"));

  const noYear = parseWindowNotice("9 月 3 日至 10 月 7 日，每晚 23 点至次日 9 点免费使用。");
  assert.equal(noYear.status, "refused");
  assert.ok(noYear.status === "refused" && noYear.reason.includes("缺年份"));

  const noHours = parseWindowNotice("* 活动时间：2026 年 9 月 3 日至 2026 年 10 月 7 日。");
  assert.equal(noHours.status, "refused");
  assert.ok(noHours.status === "refused" && noHours.reason.includes("每日时段"));

  const conflict = parseWindowNotice("* 活动时间：2026 年 9 月 3 日至 2026 年 10 月 7 日。另有 10 月 1 日至 10 月 31 日场次。每日 23:00 至次日 09:00。");
  assert.equal(conflict.status, "refused");
  assert.ok(conflict.status === "refused" && conflict.reason.includes("不一致"));
});

test("parseWindowNotice：普通公告与促销页不是窗口（not-window，不进人工候裁面）", () => {
  assert.equal(parseWindowNotice("# 老用户权益说明\n\n2026 年 7 月 30 日套餐改版，老用户权益不受影响。").status, "not-window");
  assert.equal(parseWindowNotice("# 新活动公告\n\n限时优惠，截止 11 月 30 日。").status, "not-window");
});

// ---- 信号分类与入选口径 ----

test("classifyItem：定价免费行→免费池候选；发布记录→freeHint；公告页→窗口规则", () => {
  const pricing = classifyItem({ kind: "pricing_change", url: SRC.pricing, title: "GLM-Z9-Flash：输入 免费 / 输出 免费", text: `定价表行：${PRICE_Z9}` });
  assert.deepEqual(pricing, { kind: "free_pool_candidate", model: "GLM-Z9-Flash", context: "300K", contextTokens: 300_000, eligible: true, reason: null });

  const release = classifyItem({ kind: "model_release", url: SRC.releases, title: "GLM-Z9-Flash 免费模型上线", text: "输入与输出单价均为免费" });
  assert.deepEqual(release, { kind: "model_release", freeHint: true });
  const paid = classifyItem({ kind: "model_release", url: SRC.releases, title: "GLM-5.3 旗舰上线", text: "新一代旗舰" });
  assert.deepEqual(paid, { kind: "model_release", freeHint: false });

  const window = classifyItem({ kind: "free_window", url: SRC.notice, title: "夜间畅用活动", text: NOTICE_WINDOW });
  assert.equal(window.kind, "window_rule");
  // sitemap 发现的 /notice/ 公告同样入窗口面；/update/ 之外不入。
  const viaSitemap = classifyItem({ kind: "plan_promo", url: "https://docs.bigmodel.cn/cn/coding-plan/notice/new-window", title: "新窗口", text: NOTICE_WINDOW });
  assert.equal(viaSitemap.kind, "window_rule");
});

test("入选口径：非文本家族/上下文未知/低于路由闸(100K) 不接入；1M/300K/128K 入选", () => {
  assert.equal(contextTokensOf("200K"), 200_000);
  assert.equal(contextTokensOf("1M"), 1_000_000);
  assert.equal(contextTokensOf("—"), null);
  assert.equal(contextTokensOf("图像生成"), null);
  assert.deepEqual(onboardEligible("CogView-3-Flash", null).reason, "非文本对话家族（图像/视频/实时/OCR/TTS/向量名）");
  assert.deepEqual(onboardEligible("GLM-9-Ultra", 300_000).reason, "不在 GLM-Flash 免费家族命名面");
  assert.ok(onboardEligible("GLM-4V-Flash", 4000).reason!.includes("低于路由闸"));
  assert.ok(onboardEligible("GLM-4.6V-Flash", null).reason!.includes("候人工"));
  assert.deepEqual(onboardEligible("GLM-Z1-Flash", 128_000), { eligible: true, reason: null });
});

// ---- 扫描链集成：信号→动作 ----

test("免费池缺省态：settings 未写时回退 ym436 落地模型", async () => {
  const pool = await getZhipuPool();
  assert.equal(pool.defaulted, true);
  assert.deepEqual(pool.models, ZHIPU_POOL_DEFAULT);
});

test("扫描基线：新免费模型自动入验收队列+池；窗口公告自动写；免费行/发布/公告全留痕", async () => {
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.ok, true);
  assert.equal(s.updates, 9, "发布 1 + 活动 1 + 公告 1 + 套餐改版 1 + 定价免费行 5");
  assert.equal(s.actions, 9, "每条出刊行都落了路由动作");

  // 新模型自动接入：model_watch_models observing 行 + 池清单并入 + 事件留痕。
  const onboarded = (await sql<{ status: string; context_length: number | null; verdict_note: string }[]>`
    SELECT status, context_length, verdict_note FROM model_watch_models WHERE model_id = ${TEST_MODEL}`)[0];
  assert.ok(onboarded, "zhipu:glm-z9-flash 已入表");
  assert.equal(onboarded!.status, "observing");
  assert.equal(onboarded!.context_length, 300_000);
  assert.ok(onboarded!.verdict_note.includes("自动接入"));
  const ev = await sql<{ kind: string }[]>`SELECT kind FROM model_watch_events WHERE model_id = ${TEST_MODEL}`;
  assert.ok(ev.some((e) => e.kind === "zhipu_onboard"));
  const pool = await getZhipuPool();
  assert.equal(pool.defaulted, false);
  assert.deepEqual([...pool.models].sort(), ["glm-4-flash-250414", "glm-4.7-flash", "glm-z9-flash"]);

  // 已种子模型不重复建行（created=false 也留痕 pool_onboarded）。
  const seeded = await byTitle("GLM-4.7-Flash：输入 免费 / 输出 免费");
  assert.equal(seeded!.routing_action!.action, "pool_onboarded");
  assert.equal(seeded!.routing_action!.created, false);

  // 不合口径只留痕不动作。
  const cogview = await byTitle("CogView-3-Flash：输入 多分辨率 / 输出 免费");
  assert.equal(cogview!.routing_action!.action, "pool_skipped");
  assert.ok(String(cogview!.routing_action!.reason).includes("非文本对话家族"));
  const v4 = await byTitle("GLM-4V-Flash：输入 免费 / 输出 免费");
  assert.equal(v4!.routing_action!.action, "pool_skipped");

  // 窗口公告自动写：settings 落 auto 规则；公告日期已过=摘窗态（ym436 落地态一致=首个实锚口径）。
  const rule = await getPlanWindowRule();
  assert.ok(rule && rule.mode === "auto");
  assert.deepEqual({ from: rule!.from, to: rule!.to, daily: rule!.daily }, { from: "2026-09-03", to: "2026-10-07", daily: { start: "23:00", end: "09:00" } });
  const noticeRow = await byTitle("夜间畅用活动");
  assert.equal(noticeRow!.routing_action!.action, "window_written");
  assert.equal(noticeRow!.routing_action!.active, false, "活动已到期 → 窗口停（摘窗）");
  assert.equal(planActive(Date.UTC(2026, 9, 14, 4, 0)), false, "部署窗口状态一致：2026-10-14 12:00 北京该时刻无套餐窗（settings 已到期；常量层 18:00-09:00 之外）");

  // 发布记录只记录。
  const release = await byTitle("GLM-Z9-Flash 免费模型上线");
  assert.deepEqual(release!.routing_action!.action, "noted");
});

test("同窗重扫零重复动作：零出刊零动作，池与窗口规则不被重写", async () => {
  const poolBefore = await getZhipuPool();
  const ruleBefore = await getPlanWindowRule();
  const eventsBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_watch_events WHERE model_id = ${TEST_MODEL}`)[0]!.n;
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.updates, 0);
  assert.equal(s.actions, 0);
  assert.deepEqual((await getZhipuPool()).models, poolBefore.models);
  assert.equal((await getPlanWindowRule())!.updatedAt, ruleBefore!.updatedAt);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_watch_events WHERE model_id = ${TEST_MODEL}`)[0]!.n, eventsBefore);
});

test("公告改版出更新刊：歧义文本拒写候人工，窗口规则保持不动；ops 日报露出候裁行", async () => {
  pages.set(SRC.notice, NOTICE_WINDOW + "\n* 第二阶段：2026 年 11 月 1 日至 2026 年 11 月 30 日，每日 23:00 至次日 09:00。\n");
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.updates, 1);
  assert.ok(s.notes.some((n) => n.includes("候人工")));
  const row = (await sql<{ routing_action: Record<string, unknown> }[]>`SELECT routing_action FROM zhipu_updates ORDER BY id DESC LIMIT 1`)[0]!;
  assert.equal(row.routing_action.action, "window_refused");
  const rule = await getPlanWindowRule();
  assert.equal(rule!.to, "2026-10-07", "拒写时窗口规则保持旧值");

  const findings = await collectFindings();
  const manual = findings.find((f) => f.key === "zhipuwatch.window_manual");
  assert.ok(manual, "歧义进 ops 日报候人工");
  assert.ok((manual!.detail ?? "").includes("zhipu.plan_window"));

  // /notice/ 的 plan_promo 公告（sitemap 发现面）同样入候裁露出面——ym438 首日实锚即此形态
  //（改版后的 usage-revision 公告，kind=plan_promo）。
  await sql`DELETE FROM zhipu_updates WHERE routing_action->>'action' = 'window_refused'`;
  await sql`
    INSERT INTO zhipu_updates (kind, title, url, payload, dedup_key, routing_action)
    VALUES ('plan_promo', '老用户权益说明', 'https://docs.bigmodel.cn/cn/coding-plan/notice/usage-revision',
            '{}'::jsonb, ${"test|refused-plan-promo-" + T},
            ${sql.json({ action: "window_refused", reason: "日期区间缺年份", at: new Date().toISOString() } as never)})`;
  const findings2 = await collectFindings();
  assert.ok(findings2.some((f) => f.key === "zhipuwatch.window_manual"), "plan_promo /notice/ 拒写同样进日报");

  // 处置即静默：歧义行之后人工写窗口规则（updatedAt 更新）→ 候裁行消失（不纠缠）。
  await savePlanWindowRule({ mode: "manual", from: "2026-09-25", to: "2026-10-07", daily: { start: "23:00", end: "09:00" }, updatedAt: new Date().toISOString() }, "test");
  const findings3 = await collectFindings();
  assert.ok(!findings3.some((f) => f.key === "zhipuwatch.window_manual"), "人工接管写入后候裁行静默");
  await sql`DELETE FROM settings WHERE key = 'zhipu.plan_window'`;
  await refreshPlanWindow();
});

test("mode=manual：人工维护中的窗口规则不被自动解析覆写", async () => {
  // 清水位强制重扫同页（出更新刊）；先写 manual 规则挡自动写。年整区间与无年份复述同步替换，
  // 保证解析成立（否则落在拒写分支而非 manual 分支）。
  await savePlanWindowRule({ mode: "manual", from: "2026-12-01", to: "2026-12-31", daily: { start: "20:00", end: "08:00" }, updatedAt: "manual-test" }, "test");
  pages.set(SRC.notice, NOTICE_WINDOW
    .replace("2026 年 9 月 3 日", "2026 年 12 月 3 日")
    .replace("2026 年 10 月 7 日", "2026 年 12 月 31 日")
    .replace("9 月 3 日至 10 月 7 日", "12 月 3 日至 12 月 31 日"));
  const s = await scanZhipuWatch({ fetchText, digestOne: okDigest });
  assert.equal(s.updates, 1);
  const row = (await sql<{ routing_action: Record<string, unknown> }[]>`SELECT routing_action FROM zhipu_updates ORDER BY id DESC LIMIT 1`)[0]!;
  assert.equal(row.routing_action.action, "window_manual");
  assert.equal((await getPlanWindowRule())!.updatedAt, "manual-test", "人工规则原样保留");
  await sql`DELETE FROM settings WHERE key = 'zhipu.plan_window'`;
  await refreshPlanWindow();
});

// ---- 窗口两层求值 ----

test("窗口求值纯函数：日期区间含端点、跨天时段（23:00-09:00）、普通时段、缺面不生效", () => {
  const bj = (d: number, h: number, m = 0) => Date.UTC(2026, 0, d, h - 8, m);
  const night = { mode: "auto" as const, from: "2026-01-05", to: "2026-01-31", daily: { start: "23:00", end: "09:00" }, updatedAt: "t" };
  assert.equal(planWindowRuleActive(night, bj(10, 23, 0)), true, "跨天窗开窗点");
  assert.equal(planWindowRuleActive(night, bj(10, 23, 30)), true);
  assert.equal(planWindowRuleActive(night, bj(11, 8, 59)), true, "次日早尾");
  assert.equal(planWindowRuleActive(night, bj(11, 9, 0)), false);
  assert.equal(planWindowRuleActive(night, bj(10, 22, 59)), false);
  assert.equal(planWindowRuleActive(night, bj(1, 12, 0)), false, "起日之前");
  assert.equal(planWindowRuleActive(night, bj(31, 23, 30)), true, "止日含当日");
  const day = { mode: "auto" as const, from: "2026-01-05", to: "2026-01-31", daily: { start: "09:00", end: "18:00" }, updatedAt: "t" };
  assert.equal(planWindowRuleActive(day, bj(10, 12, 0)), true);
  assert.equal(planWindowRuleActive(day, bj(10, 18, 0)), false, "end 开区间");
  assert.equal(planWindowRuleActive({ mode: "auto", from: null, to: null, daily: null, updatedAt: "t" }, bj(10, 12)), false, "缺日期面=层内不生效（摘窗态）");
});

test("planActive 两层取或：settings 窗口在挂即真，键清=回落代码常量", async () => {
  const bj = (d: number, h: number, m = 0) => Date.UTC(2026, 0, d, h - 8, m);
  await savePlanWindowRule({ mode: "auto", from: "2026-01-05", to: "2026-01-31", daily: { start: "23:00", end: "09:00" }, updatedAt: "t" });
  await refreshPlanWindow();
  assert.equal(planActive(bj(10, 23, 0)), true, "settings 层在挂（历史日期，免泄漏干扰他测）");
  assert.equal(planActive(bj(11, 8, 0)), true);
  assert.equal(planActive(bj(10, 12, 0)), false);
  assert.equal(planActive(bj(11, 12, 0)), false, "规则已过期 → 摘窗（该时刻两层均不在挂）");

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  await savePlanWindowRule({ mode: "auto", from: today, to: today, daily: { start: "00:00", end: "23:59" }, updatedAt: "t" });
  await refreshPlanWindow();
  assert.equal(planActive(), true, "恢复 → 自动挂窗");
  await sql`DELETE FROM settings WHERE key = 'zhipu.plan_window'`;
  await refreshPlanWindow();
  assert.equal(planActive(bj(10, 12, 0)), false, "键清=回落代码常量（该时刻常量窗不在挂：白天）");
  // 2026-10-13 18:00（PLAN_WINDOW_FROM）起常量层每夜 18:00-09:00 在挂：显式时刻断言，免挂钟干扰
  //（本文件 10-13 晚起曾因拿真实当前时刻断言「无窗」而必红；基线对照与归因见 ym560 artifacts）。
  assert.equal(planActive(Date.UTC(2026, 9, 14, 12, 0)), true, "键清=回落代码常量（2026-10-14 20:00 北京：常量窗在挂）");
});

// ---- 连续失败自动摘池 ----

test("nextFailStreak 纯函数：全失败累加、成功清零、达阈值出退休名单并清计数", () => {
  const rounds = (n: number) => [{ modelId: TEST_MODEL, calls: 10, ok: n > 0 ? 10 : 0, lastError: n > 0 ? null : "HTTP 404" }];
  let st: Record<string, FailStreak> = {};
  st = nextFailStreak(st, rounds(0), "t1").state;
  st = nextFailStreak(st, rounds(0), "t2").state;
  assert.deepEqual(st, { [TEST_MODEL]: { count: 2, lastAt: "t2", lastError: "HTTP 404" } });
  const cleared = nextFailStreak(st, rounds(1), "t3");
  assert.deepEqual(cleared.state, {});
  assert.deepEqual(cleared.cleared, [TEST_MODEL]);
  let st2: Record<string, FailStreak> = {};
  st2 = nextFailStreak(st2, rounds(0), "t1").state;
  st2 = nextFailStreak(st2, rounds(0), "t2").state;
  const done = nextFailStreak(st2, rounds(0), "t3");
  assert.equal(done.retired.length, 1);
  assert.equal(done.retired[0]!.modelId, TEST_MODEL);
  assert.deepEqual(done.state, {});
});

test("连续 3 轮调用全失败 → 自动摘池（filtered+池移除+事件）；已 filtered 不重复退休；成功清零", async () => {
  await sql`
    INSERT INTO model_watch_models (model_id, name, vendor, tier, context_length, supports_vision, supports_json, free_from, last_prompt_price, last_completion_price, status, verdict_note, provider_facts)
    VALUES (${TEST_MODEL}, 'GLM-Z9-Flash', 'zhipu', 'free_tier', 300000, false, true, now(), '0', '0', 'observing', 'test', '{"channel":"zhipu"}'::jsonb)
    ON CONFLICT (model_id) DO UPDATE SET status = 'observing', verdict_note = 'test'`;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('zhipuwatch.pool', ${sql.json({ models: ["glm-z9-flash"], updatedAt: "t", updatedBy: "test" } as never)}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const fail = [{ modelId: TEST_MODEL, calls: 10, ok: 0, lastError: "model not found" }];
  assert.deepEqual((await recordZhipuRoundOutcomes(fail)).retired, []);
  assert.deepEqual((await recordZhipuRoundOutcomes(fail)).retired, []);
  const third = await recordZhipuRoundOutcomes(fail);
  assert.deepEqual(third.retired, [TEST_MODEL]);
  const row = (await sql<{ status: string; verdict_note: string }[]>`SELECT status, verdict_note FROM model_watch_models WHERE model_id = ${TEST_MODEL}`)[0]!;
  assert.equal(row.status, "filtered");
  assert.ok(row.verdict_note.includes("自动摘池"));
  assert.deepEqual((await getZhipuPool()).models, ZHIPU_POOL_DEFAULT, "移除后池空 → 落默认回退（预设永不空池）");
  const ev = await sql<{ kind: string }[]>`SELECT kind FROM model_watch_events WHERE model_id = ${TEST_MODEL}`;
  assert.ok(ev.some((e) => e.kind === "zhipu_auto_retire"));
  // 已 filtered：更新零行，不再重复退休/事件。
  const fourth = await recordZhipuRoundOutcomes(fail);
  assert.deepEqual(fourth.retired, []);
  // 退休模型经定价页信号再来 → 不回池不复活（shoumen P3-6 销项）。
  const reonboard = await onboardZhipuModel({
    model: "GLM-Z9-Flash", name: "GLM-Z9-Flash", contextTokens: 300_000,
    sourceUrl: SRC.pricing, note: "test re-onboard after retire",
  });
  assert.equal(reonboard.retired, true);
  assert.equal(reonboard.created, false);
  assert.deepEqual((await getZhipuPool()).models, ZHIPU_POOL_DEFAULT, "退休模型未回池");
  // 成功调用清零：重建 observing 后一败一成，计数清空。
  await sql`UPDATE model_watch_models SET status = 'observing' WHERE model_id = ${TEST_MODEL}`;
  await recordZhipuRoundOutcomes(fail);
  await recordZhipuRoundOutcomes([{ modelId: TEST_MODEL, calls: 10, ok: 3, lastError: null }]);
  const state = (await sql<{ value: Record<string, unknown> | null }[]>`SELECT value FROM settings WHERE key = 'zhipuwatch.failstreak'`)[0]!.value;
  assert.deepEqual(state, {}, "成功后失败计数清空");
});

// ---- ops 日报免费占比行 ----

test("免费通道日报行：承接次数/占比/证书覆盖/池水位（有调用即出）", async () => {
  // 他套件（api-router/capability-routing）会删 openrouter budgets 行且不恢复：先落回 0055
  // 迁移的规范值，保证「池水位」分支确定性走到。
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('openrouter', 60, 100, 500) ON CONFLICT (service) DO NOTHING`;
  const lk = `ym438-share-${T}`;
  // ym472 三通道口径夹具：opencode-free 业务调用计分子（计入正例）；certify.* 与 *.drill 即使
  // 落在免费通道上也不进分子/分母（剔除正例——旧码只剔 free_capability_test 且分子无 opencode，
  // 同一夹具下旧码即红，判别性由本夹具＋同窗现算期望承载）。
  const [rc] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, status) VALUES (${lk}, 'zhipu-free', 'test', 'completed') RETURNING id`;
  const [rcCert] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, status) VALUES (${lk + "-cert"}, 'opencode-free', 'modelwatch.certify.prefilter', 'completed') RETURNING id`;
  const [rcDrill] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, status) VALUES (${lk + "-drill"}, 'zhipu-free', 'ym467.drill', 'completed') RETURNING id`;
  let attemptNo = 0; // attempt 全 receipt 唯一（(receipt_id, attempt) 唯一约束），跨服务递增
  const attempts: Array<[number, string, number]> = [
    [rc!.id, "zhipu-free", 3], [rc!.id, "openrouter", 1], [rc!.id, "llm", 1], [rc!.id, "opencode-free", 2],
    [rcCert!.id, "opencode-free", 3],
    [rcDrill!.id, "zhipu-free", 1],
  ];
  for (const [rid, service, n] of attempts) {
    for (let i = 0; i < n; i++) {
      attemptNo++;
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, started_at)
                VALUES (${rid}, ${attemptNo}, ${service}, 'live', 'received', now() - interval '1 hour')`;
    }
  }
  try {
    // 期望值按库内同窗现算（测试库可能有他套件残留的实时调用，断言与库内事实一致而非绝对数）；
    // 口径与实现一致：origin=live 且统一剔除验收/演练调用（fct / modelwatch.certify.* / *.drill）。
    const [exp] = await sql<{ zhipu: number; openrouter: number; opencode: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE a.service = 'zhipu-free')::int AS zhipu,
             count(*) FILTER (WHERE a.service = 'openrouter')::int AS openrouter,
             count(*) FILTER (WHERE a.service = 'opencode-free')::int AS opencode,
             count(*)::int AS total
      FROM receipt_attempts a JOIN receipts rc ON rc.id = a.receipt_id
      WHERE a.origin = 'live'
        AND rc.purpose <> 'free_capability_test'
        AND rc.purpose NOT LIKE 'modelwatch.certify.%'
        AND rc.purpose NOT LIKE '%.drill'
        AND a.started_at > now() - interval '24 hours'`;
    const free = exp!.zhipu + exp!.openrouter + exp!.opencode;
    const share = Math.round((free / exp!.total) * 100);
    const findings = await collectFindings();
    const line = findings.find((f) => f.key === "free.share");
    assert.ok(line, "有调用即出免费占比行");
    assert.ok(line!.title.includes(`承接 ${free} 次调用（占 ${share}%）`), `实际标题：${line!.title}`);
    assert.ok(
      (line!.detail ?? "").includes(`智谱免费 ${exp!.zhipu} 次、OpenRouter ${exp!.openrouter} 次、opencode ${exp!.opencode} 次`),
      `实际明细：${line!.detail}`,
    );
    assert.ok((line!.detail ?? "").includes(`合计 ${free}/${exp!.total}`), `合计与现算一致：${line!.detail}`);
    assert.ok((line!.detail ?? "").includes("证书覆盖"), "证书覆盖能力位数在行内");
    assert.ok((line!.detail ?? "").includes("OpenRouter 池"), "池水位在行内");
  } finally {
    await sql`DELETE FROM receipts WHERE logical_key LIKE ${lk + "%"}`;
  }
});
