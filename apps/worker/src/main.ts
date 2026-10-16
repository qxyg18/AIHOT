// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { registerInsightJobs } from "@aihot/backend/editorial/insights";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { brandProfilesEmpty } from "@aihot/backend/brandprofiles/refresh";
import { ensureContentTargets } from "@aihot/backend/notify/deliver";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { resolveRunRole, runRoleWarning, sideEffectsEnabled } from "@aihot/backend/operations/runrole";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

// Run-role master gate (ym671): everything below writes to the database, registers crons that pay
// and notify, or catches an empty site up — all of it belongs to the active role. shadow/off (and
// a missing/invalid AIHOT_RUN_ROLE, which fails closed to off) start none of it and connect nowhere.
const gate = resolveRunRole(process.env.AIHOT_RUN_ROLE);
if (gate.failed) console.log(runRoleWarning(gate));
let heartbeat: NodeJS.Timeout | undefined;
if (sideEffectsEnabled(gate.role)) {
  await ensureContentTargets();
  const boss = await getBoss();
  await registerContentJobs(boss);
  await registerInsightJobs(boss);
  if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
  await registerEventJobs(boss);
  await registerNotifyJobs(boss);
  await registerPublicationJobs(boss);
  await registerSchedules(boss);
  // A new site has no leaderboard until the first scheduled round: compute one now.
  if (FEATURES.leaderboard) {
    const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
    if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
  }
  // Brand profiles (zw14): an empty table gets its first collection round at startup.
  if (await brandProfilesEmpty()) await boss.send("cron.brandprofiles.refresh", {}, { singletonKey: "first-round" });
  heartbeat = startHeartbeat("worker");
  console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));
} else {
  // No timers, no queue, no connection: keep the process up (a deployment rehearsal stays green
  // this way) with a bare interval that owns no resource and touches nothing.
  setInterval(() => {}, 1 << 30);
  console.log(JSON.stringify({ level: "info", msg: "worker started without side effects", role: gate.role, pid: process.pid }));
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  if (heartbeat) clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
