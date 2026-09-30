// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { FEATURES } from "@aihot/industry/features";
import { credential } from "@aihot/backend/config";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { refreshStoryStatuses } from "@aihot/backend/events/digest";
import { linkRelatedStories } from "@aihot/backend/events/group";
import { catchUpReports, composeDaily, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { refreshBrandProfiles } from "@aihot/backend/brandprofiles/refresh";
import { sweepDeepReads } from "@aihot/backend/editorial/deepread";
import { mimoUsable } from "@aihot/backend/providers/mimo";
import { mimoShiftActive, offpeakActive, offpeakPlanLive, quietActive } from "@aihot/backend/lib/windows";
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

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  // zw20 off-peak plan: model-heavy jobs run only inside the daily discount window below.
  // The window never overlaps the weekday quiet hours, so they carry no quiet marking.
  offpeak?: boolean;
  // zw20 off-peak plan: "exempt" still runs inside the weekday quiet window (ops, monitoring,
  // archive snapshots; also missed-catchup of reports so a downtime never loses a report).
  quiet?: "exempt";
}

const collecting = process.env.COLLECT_ENABLED !== "false";

// zw20 (owner directive 2026-09-30): from 2026-10-08 Beijing time, no site updates on weekdays
// 12:00-18:00 (Coding Plan peak hours) and model-heavy jobs only in the discounted window
// 23:00-07:30 (ka3: or the MIMO pay-as-you-go shift 9:00-22:59 while its balance holds). Before
// the effective date every gate passes and behavior is unchanged. Skipped slots are silent in
// job_runs: the time distribution of that table is the audit evidence.
export const gateAllows = (s: { offpeak?: boolean; quiet?: "exempt" }, now = Date.now()) => {
  if (!offpeakPlanLive(now)) return true;
  if (s.offpeak) return offpeakActive(now) || (mimoShiftActive(now) && !quietActive(now));
  if (quietActive(now)) return s.quiet === "exempt";
  return true;
};

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
  // recovery) from being dropped by the quiet gate instead of running late.
  { name: "reports.daily", cron: "30 23 * * *", missed: "once", quiet: "exempt", run: () => composeDaily(beijingDate(Date.now())) },
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
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", quiet: "exempt", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release, before the alerts look.
  { name: "ops.recover", cron: "*/10 * * * *", quiet: "exempt", run: async () => ({ receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), deliveries: await markStaleDeliveries() }) },
  { name: "ops.alerts", cron: "*/10 * * * *", quiet: "exempt", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", quiet: "exempt", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", quiet: "exempt", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, quiet: "exempt" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", quiet: "exempt", run: () => sourceHealthWeekly() },
  // Four upstream checks a day; a new run is published only when the evidence changed. With collection
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
      if (!gateAllows(s)) return; // zw20: outside the allowed window; silent skip, no job_runs row
      // ka3: once the plan is live, model-heavy jobs on the MIMO shift (outside the discount
      // window) run only while MIMO is configured and its circuit is closed; before the plan is
      // live this branch never triggers and the pre-plan behavior (run all day) is untouched.
      if (offpeakPlanLive() && s.offpeak && !offpeakActive() && !(await mimoUsable())) return;
      return recordRun(s.name, s.run);
    });
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (existing.name.startsWith("cron.") && !names.has(existing.name)) await boss.unschedule(existing.name);
  }
}
