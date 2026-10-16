import { assertProductionSecrets, config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { startWorkerWatchdog } from "@aihot/backend/operations/watch";
import { resolveRunRole, runRoleWarning, sideEffectsEnabled } from "@aihot/backend/operations/runrole";
import { buildApp } from "./app.ts";

assertProductionSecrets([
  ["auth", "SESSION_SECRET"],
  ["auth", "IMG_PROXY_SIGN_SECRET"],
]);
// Somebody must be able to sign in to the admin.
if (config.environmentName === "production" && !(config.adminPassword && config.adminPassword.length >= 12) && !process.env.FEISHU_LOGIN_APP_ID) {
  throw new Error("Refusing to start in production: set ADMIN_PASSWORD (at least 12 characters) or configure Feishu sign-in");
}

// Run-role master gate (ym671): the api process itself has exactly two side effects — the
// heartbeat settings row and the worker watchdog's settings writes and Feishu alerts. Both belong
// to the active role; shadow/off (and a missing/invalid AIHOT_RUN_ROLE, failing closed to off)
// serve the site without them.
const gate = resolveRunRole(process.env.AIHOT_RUN_ROLE);
if (gate.failed) console.log(runRoleWarning(gate));

const app = await buildApp();
await app.listen({ port: config.apiPort, host: process.env.API_HOST || "127.0.0.1" });
if (sideEffectsEnabled(gate.role)) {
  startHeartbeat(`api:${config.apiPort}`);
  startWorkerWatchdog();
} else {
  console.log(JSON.stringify({ level: "info", msg: "api started without side effects", role: gate.role }));
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();

  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
