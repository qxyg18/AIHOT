// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { FEATURES } from "@aihot/industry/features";
import { credential, config } from "@aihot/backend/config";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { refreshStoryStatuses } from "@aihot/backend/events/digest";
import { linkRelatedStories } from "@aihot/backend/events/consolidate";
import { catchUpReports, composeDaily, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { refreshBrandProfiles } from "@aihot/backend/brandprofiles/refresh";
import { sweepDeepReads } from "@aihot/backend/editorial/deepread";
import { mimoUsable } from "@aihot/backend/providers/mimo";
import { freeChannelUsable } from "@aihot/backend/modelwatch/routing";
import { offpeakPlanLive, planActive } from "@aihot/backend/lib/windows";
import { monitorTick } from "@aihot/backend/monitor/scan";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { markStaleDeliveries } from "@aihot/backend/notify/deliver";
import { scanModelWatch } from "@aihot/backend/modelwatch/monitor";
import { runCapabilityTests } from "@aihot/backend/modelwatch/capability-test";
import { scanOssWatch } from "@aihot/backend/osswatch/scan";
import { reviewDueDigests } from "@aihot/backend/osswatch/review";
import { scanZhipuWatch } from "@aihot/backend/zhipuwatch/scan";
import { reviewDueDigests as reviewZhipuDigests } from "@aihot/backend/zhipuwatch/review";
import { scanOpencodeWatch } from "@aihot/backend/opencodewatch/scan";
import { runDiscoveryRound, runProbeRound, runActivationRound } from "@aihot/backend/jobs/admission";
import { refreshMacroFromNbs } from "@aihot/backend/macro/nbs";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  // ym431: marks model-heavy jobs — kept for the MIMO-availability guard in the worker handler.
  // (zw20's "run only in the discount window" gating is retired; jobs run on their cadence all day.)
  offpeak?: boolean;
  // zw20 annotation, retained on the rows: these ran even in the retired quiet window.
  quiet?: "exempt";
}

const collecting = process.env.COLLECT_ENABLED !== "false";

// ym431 (owner directive 2026-10-08): the zw20 quiet window and time-of-day gating are retired —
// the site updates around the clock and every job runs on its own cadence. Which model pays is
// decided in modelFor (plan window = Zhipu plan; otherwise free models first + MIMO pay-as-you-go),
// with the MIMO-availability guard in the worker handler keeping heavy jobs off the plan outside
// its window. The signature stays for the schedule rows and the boundary tests.
export const gateAllows = (_s: { offpeak?: boolean; quiet?: "exempt" }, _now = Date.now()) => true;

export const SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", offpeak: true, run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "*/5 * * * *", offpeak: true, run: () => translatePending() },
  // Deep reads (ka4): one plain-language reading per public article that matches a brand, a mall
  // or a market-wide signal; articles with neither are recorded as skipped, so reruns stay cheap.
  { name: "deepread.sweep", cron: "*/30 * * * *", offpeak: true, run: () => sweepDeepReads() },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", quiet: "exempt", run: snapshotHeat },
  { name: "stories.status", cron: "7 * * * *", offpeak: true, run: refreshStoryStatuses },
  { name: "stories.links", cron: "12 * * * *", offpeak: true, run: linkRelatedStories },
  // Reports are composed inside the discount window; "exempt" keeps a missed catch-up (downtime
  // recovery) from being dropped by the quiet gate instead of running late. ym41: deadline moved
  // to 07:00 Beijing (owner ruling 2026-10-01) — the day's issue covers [D-1 07:00, D 07:00) and
  // goes out at 07:10, still inside the zw20 discount window.
  { name: "reports.daily", cron: "10 7 * * *", missed: "once", quiet: "exempt", run: () => composeDaily(beijingDate(Date.now())) },
  { name: "reports.weekly", cron: "50 23 * * 1", missed: "once", quiet: "exempt", run: () => composeWeekly(isoWeekLabel(addDays(beijingDate(Date.now()), -7))) },
  {
    name: "reports.monthly",
    cron: "55 23 1 * *",
    missed: "once",
    quiet: "exempt",
    run: () => {
      const [y, m] = beijingDate(Date.now()).split("-").map(Number) as [number, number];
      return composeMonthly(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
    },
  },
  { name: "reports.catch-up", cron: "15 * * * *", offpeak: true, run: () => catchUpReports() },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", quiet: "exempt", run: () => dailyRetention() },
  // Brand profiles (zw14): encyclopedia facts and the eight-question summaries refresh weekly;
  // unchanged source text keeps its paid summary, so a quiet round makes no model calls.
  { name: "brandprofiles.refresh", cron: "35 3 * * 1", missed: "once", quiet: "exempt", run: () => refreshBrandProfiles() },
  { name: "sources.icons", cron: "40 4 * * *", missed: "once", quiet: "exempt", run: refreshSourceIcons },
  // 免费模型信源监控（命主 2026-10-02）：每 24 小时拉一次 OpenRouter 模型表，盯免费窗口
  // 开启/结束并重算路由（只启用上下文 ≥1M 的）。探针打的是免费模型（零成本），不算
  // model-heavy，quiet 豁免保证节奏不被静默窗吞掉。
  { name: "model-watch.scan", cron: "30 6 * * *", missed: "once", quiet: "exempt", run: () => scanModelWatch() },
  // 免费模型能力级验收（ym196 命主令）：每免费模型×每能力位 10 次真实调用（免费零成本），
  // 付费模型判卷（≥9/10 合格→进能力路由；付费降为断链过渡档）。滚动批：每晚 8 组合，
  // 未测优先、7 天复测；判卷走付费 default，优惠窗折扣价。ym477（拍板 gate-review）：
  // MIMO 熔断态当晚整批跳过——判卷的套餐消耗归零，熔断期不扩证书面，恢复后次晚自然续跑。
  { name: "model-watch.capability-test", cron: "40 23 * * *", missed: "once", quiet: "exempt", offpeak: true, run: () => runCapabilityTests({ skipOnMimoCircuitOpen: true }) },
  // 开源项目跟踪（ym190 建卡；ym195 命主令改双轮）：白天轮 06:47 扫描后立刻出解读——
  // 免费模型优先（免费路由在役主力即写即出，免费窗口未开回落 MIMO 付费班次），不等优惠窗。
  { name: "oss.watch", cron: "47 6 * * *", missed: "once", quiet: "exempt", run: () => scanOssWatch() },
  // 复核轮 23:33（优惠窗内）：强模型（ossDigestReview，显式指派计划模型保独立性）对照原始
  // 材料复核白天的解读，问题提炼成教训沉淀（osswatch.lessons），次日白天解读注入教训段。
  { name: "oss.review", cron: "33 23 * * *", missed: "once", quiet: "exempt", offpeak: true, run: () => reviewDueDigests() },
  // 智谱关注（ym437 命主点名需求②）：日扫 06:53 拉 5 定点页（.md 直取）+ sitemap 差分，有料才出刊，
  // 解读走免费通道优先（zhipu 免费档证书）；复核轮 23:36 用强模型（zhipuDigestReview，排除免费路由）
  // 对照原始材料复核清晨的免费解读。
  { name: "zhipu.watch", cron: "53 6 * * *", missed: "once", quiet: "exempt", run: () => scanZhipuWatch() },
  { name: "zhipu.review", cron: "36 23 * * *", missed: "once", quiet: "exempt", offpeak: true, run: () => reviewZhipuDigests() },
  // opencode 免费档目录同步与存在性预检（ym467 S05）：直连宿主 opencode serve 客户端
  // （GET /provider，Basic 鉴权），免费双信号（-free 后缀/白名单 + 客户端零价）入池；
  // 目录消失的成员置 ended 出池（行保留可回）；版本/免费集合快照落 settings 供漂移探测。
  { name: "opencode.watch", cron: "57 6 * * *", missed: "once", quiet: "exempt", run: () => scanOpencodeWatch() },
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", quiet: "exempt", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release, before the alerts look.
  { name: "ops.recover", cron: "*/10 * * * *", quiet: "exempt", run: async () => ({ receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), deliveries: await markStaleDeliveries() }) },
  { name: "ops.alerts", cron: "*/10 * * * *", quiet: "exempt", run: () => checkAlerts() },
  // 宏观月度序列（ym770，d-radar-macro-monthly-auto 命主 2026-10-21 拍 opt-auto）：统计局每月
  // 15–19 日发布上月社零，这里每日 07:25 幂等拉一次发布页，只有新月份（或官方修订）才写库；
  // 抓不到/解析不了即抛错留 job_runs 红，既有数据不动（零半截写入）。零 token、不打模型。
  { name: "macro.refresh", cron: "25 7 * * *", missed: "once", quiet: "exempt", run: () => refreshMacroFromNbs() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", quiet: "exempt", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", quiet: "exempt", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, quiet: "exempt" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", quiet: "exempt", run: () => sourceHealthWeekly() },
  // Three upstream checks a day; a new run is published only when the evidence changed. With collection
  // off only the computation runs, over the snapshots already stored. The 14:05 slot is gone (zw20:
  // weekday quiet hours); 02:05/08:05/20:05 stay clear of them.
  ...(FEATURES.leaderboard
    ? [{ name: "leaderboard.round", cron: "5 2,8,20 * * *", missed: "once" as const, run: () => (collecting ? refreshLeaderboard() : runLeaderboardRound()) }]
    : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),
  // Source admission engine (ym312): discovery and probe entries, each behind its own valve
  // (SOURCE_DISCOVERY_ENABLED / SOURCE_PROBE_ENABLED, both default off — the BUILD-disabled state
  // holds until the activation card turns them on). Removing a valve unregisters the schedule (the
  // sweep below clears its cron) and leaves the other valve's candidates and append-only checks.
  ...(config.sourceDiscoveryEnabled
    ? [{ name: "sources.admission.discover", cron: "50 4 * * *", missed: "once" as const, quiet: "exempt" as const, run: () => runDiscoveryRound() }]
    : []),
  ...(config.sourceProbeEnabled
    ? [{ name: "sources.admission.probe", cron: "20 */2 * * *", run: () => runProbeRound() }]
    : []),
  // Activation round (ym257/T06): eligible candidates become collecting sources via ym311's
  // activateCandidate. Shares the probe valve — probe off = the engine's write side fully off
  // (eligible rows just wait). 20 min after the probe slot; an overlap is harmless (advisory
  // lock + idempotent replay). Missed slots skip: eligible rows are persistent, nothing is lost.
  ...(config.sourceProbeEnabled
    ? [{ name: "sources.admission.activate", cron: "40 */2 * * *", run: () => runActivationRound() }]
    : []),
  // Codex reset monitor: checked every minute, scanned every 5 (every 3 while hot). It reads X through
  // SocialData, so without that key there is nothing to run.
  ...(collecting && FEATURES.codexResetMonitor && credential("collectors", "SOCIALDATA_API_KEY")
    ? [
        { name: "monitor.tick", cron: "* * * * *", quiet: "exempt" as const, run: () => monitorTick() },
        { name: "monitor.lookback", cron: "40 4 * * *", quiet: "exempt" as const, run: () => monitorTick({ lookbackHours: 48 }) },
      ]
    : []),
];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => {
      if (!gateAllows(s)) return;
      // ka3/ym431 guard: outside the plan window (free/MIMO hours), model-heavy jobs run only
      // while MIMO or a free channel (ym436: Zhipu free family / OpenRouter pool with members)
      // can take them — never fall back to the plan there.
      if (offpeakPlanLive() && s.offpeak && !planActive() && !(await mimoUsable()) && !(await freeChannelUsable())) return;
      return recordRun(s.name, s.run);
    });
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (existing.name.startsWith("cron.") && !names.has(existing.name)) await boss.unschedule(existing.name);
  }
}
