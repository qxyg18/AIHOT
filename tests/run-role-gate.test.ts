// Entry-point integration for the run-role master gate (ym671): the real worker and api entry
// files are spawned as child processes.
// - shadow/off (and a missing or invalid AIHOT_RUN_ROLE, failing closed to off) must start the
//   processes without touching ANY external system: the database and model endpoints are pointed
//   at a local interceptor socket, and the test asserts it recorded zero connections — no
//   connection means no startup write, no cron registration, no catch-up round, no heartbeat, no
//   paid call, no notification.
// - the active path runs against a dedicated throwaway database (created and dropped here) and
//   must keep today's behavior: heartbeat row written, pg-boss schema and schedules registered.
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A local socket standing in for every external endpoint; any connection attempt is recorded. */
function interceptor() {
  const hits: string[] = [];
  const server = net.createServer((socket) => {
    hits.push(`${socket.remoteAddress}:${socket.remotePort}`);
    socket.destroy();
  });
  return {
    hits: () => hits,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return String((server.address() as net.AddressInfo).port);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  lines: string[];
  exited: Promise<number | null>;
  kill: () => void;
}

function spawnEntry(entry: string, env: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, [entry], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const pump = (stream: NodeJS.ReadableStream) => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
  };
  pump(child.stdout!);
  pump(child.stderr!);
  return {
    lines,
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
    kill: () => child.kill(),
  };
}

async function waitFor(run: Run, needle: string, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (run.lines.some((l) => l.includes(needle))) return;
    const exited = await Promise.race([run.exited, new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    if (exited !== null) throw new Error(`process exited early (${exited}): ${run.lines.join(" | ")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for "${needle}": ${run.lines.join(" | ")}`);
}

const WORKER = "apps/worker/src/main.ts";
const API = "apps/api/src/main.ts";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIHOT_CREDENTIALS_DIR: "/nonexistent-runrole-test",
    COLLECT_ENABLED: "false",
    MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    FEISHU_INTERNAL_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
  };
}

const interceptors: { hits: () => string[]; close: () => Promise<void> }[] = [];
after(async () => {
  for (const i of interceptors) await i.close();
  await closeDb();
});

// On Windows a child cannot receive a graceful SIGTERM (TerminateProcess — the exit code is then
// 1 or null depending on timing); the gate evidence is the banner plus zero connections, so only
// POSIX asserts the clean exit code. Awaiting the exit is itself the "it terminated" check.
function assertExitCode(code: number | null): void {
  if (process.platform !== "win32") assert.equal(code, 0, "graceful shutdown expected");
}

for (const role of ["shadow", "off", "turbo", undefined] as (string | undefined)[]) {
  const label = role === undefined ? "missing" : `"${role}"`;
  test(`worker with ${label} AIHOT_RUN_ROLE starts and touches nothing`, async () => {
    const db = interceptor();
    interceptors.push(db);
    const llm = interceptor();
    interceptors.push(llm);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      DATABASE_URL: `postgres://nobody:nobody@127.0.0.1:${await db.start()}/nothing`,
      LLM_BASE_URL: `http://127.0.0.1:${await llm.start()}`,
    };
    if (role === undefined) delete env.AIHOT_RUN_ROLE;
    else env.AIHOT_RUN_ROLE = role;

    const run = spawnEntry(WORKER, env);
    // "turbo" is not a role: the resolver must say so and run as off; the other three stay quiet.
    if (role === "turbo") await waitFor(run, "AIHOT_RUN_ROLE missing or invalid");
    await waitFor(run, "worker started without side effects");
    await new Promise((r) => setTimeout(r, 2_500)); // a heartbeat or catch-up would show by now
    run.kill();
    assertExitCode(await run.exited);
    assert.deepEqual(db.hits(), [], "shadow/off worker must not reach the database");
    assert.deepEqual(llm.hits(), [], "shadow/off worker must not call any model endpoint");
    if (role === "turbo" || role === undefined) {
      const warn = run.lines.find((l) => l.includes("AIHOT_RUN_ROLE missing or invalid"));
      assert.ok(warn, "fail-closed warning expected");
    }
  });
}

test("api with AIHOT_RUN_ROLE=shadow serves without heartbeat or watchdog", async () => {
  const db = interceptor();
  interceptors.push(db);
  const llm = interceptor();
  interceptors.push(llm);
  const port = 3900 + (Date.now() % 100);
  const env = {
    ...baseEnv(),
    AIHOT_RUN_ROLE: "shadow",
    API_PORT: String(port),
    API_HOST: "127.0.0.1",
    DATABASE_URL: `postgres://nobody:nobody@127.0.0.1:${await db.start()}/nothing`,
    LLM_BASE_URL: `http://127.0.0.1:${await llm.start()}`,
  };
  const run = spawnEntry(API, env);
  await waitFor(run, "api started without side effects");
  await new Promise((r) => setTimeout(r, 2_500)); // the heartbeat's first beat is immediate
  run.kill();
  assertExitCode(await run.exited);
  assert.deepEqual(db.hits(), [], "shadow api must not write heartbeats or watchdog state");
  assert.deepEqual(llm.hits(), [], "shadow api must not send alerts");
});

test("worker with AIHOT_RUN_ROLE=active keeps registering (dedicated throwaway database)", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  const name = `runrole_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}_test`;
  const dedicated = `${url.protocol}//${url.username}${url.password ? `:${url.password}` : ""}@${url.host}/${name}`;
  const llm = interceptor();
  interceptors.push(llm);
  await sql.unsafe(`CREATE DATABASE ${name}`);
  try {
    const migrated = spawnSync(process.execPath, ["scripts/migrate.ts"], {
      cwd: REPO_ROOT, env: { ...baseEnv(), DATABASE_URL: dedicated }, encoding: "utf-8", timeout: 120_000,
    });
    assert.equal(migrated.status, 0, `migrate failed: ${migrated.stdout}\n${migrated.stderr}`);

    const run = spawnEntry(WORKER, {
      ...baseEnv(), AIHOT_RUN_ROLE: "active", DATABASE_URL: dedicated,
      LLM_BASE_URL: `http://127.0.0.1:${await llm.start()}`,
    });
    await waitFor(run, '"msg":"worker started"');
    await new Promise((r) => setTimeout(r, 1_500));
    run.kill();
    await run.exited;

    const postgres = (await import("postgres")).default;
    const db = postgres(dedicated, { max: 1 });
    try {
      const [heartbeat] = await db`SELECT value FROM settings WHERE key = 'heartbeat.worker'`;
      assert.ok(heartbeat, "active worker writes its heartbeat settings row");
      const [{ count }] = await db`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'pgboss'`;
      assert.ok(count > 0, "active worker registers the queue schema");
      const [{ scheduled }] = await db`SELECT count(*)::int AS scheduled FROM pgboss.schedule`;
      assert.ok(scheduled > 0, "active worker registers its cron schedules");
      assert.deepEqual(llm.hits(), [], "with MODEL_CALLS_ENABLED=false the active worker pays for nothing");
    } finally {
      await db.end({ timeout: 5 });
    }
  } finally {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name}`);
  }
});
