// Capability framework invariants (T20/ym252): server-side capability derivation is fail-closed
// (no grant rows and no verified compat ⇒ no capabilities, upgraded by nothing the client sends)
// and the adminHandler guard separates channel read/feedback from admin:operate. Same throwaway
// database as the rest of the invariant suite; the fastify app never listens, inject() stays
// in memory, and every row created here is removed in after().
// DEV_AUTH_ROLE stays unset in this process (the 401 shape is proven directly); the dev-stand-in
// test runs in a child process, and its script is joined from single-line strings because the
// TS type stripper in node 24 misparses multiline template literals inside call arguments.
import "./setup.ts";

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { sha256 } from "@aihot/backend/lib/ids";
import { adminHandler } from "../apps/api/src/routes/admin-auth.ts";

const T = `t20-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CSRF = `csrf-${T}`;
const APP = { id: `app-${T}`, secret: `secret-${T}` };

const preexistingUserIds = new Set<number>();
const createdUserIds: number[] = [];

async function sessionFor(email: string): Promise<{ token: string; userId: number; principal: string }> {
  const [u] = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, display_name, last_login_at) VALUES (${email}, ${email}, now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`;
  const userId = u!.id;
  if (!preexistingUserIds.has(userId)) createdUserIds.push(userId);
  const token = randomBytes(32).toString("base64url");
  // A stored session is accepted only while its sign-in binding still verifies (fail-closed), so the
  // rows are signed with the Feishu claims form completeLogin uses.
  const claims = { appId: APP.id, unionId: `t20-${userId}`, email: null };
  Object.assign(process.env, { FEISHU_LOGIN_APP_ID: APP.id, FEISHU_LOGIN_APP_SECRET: APP.secret });
  if (!config.adminUnionIds.includes(claims.unionId)) config.adminUnionIds.push(claims.unionId);
  const binding = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${userId}, ${CSRF}, ${new Date(Date.now() + 3_600_000)}, null,
                    'feishu', ${binding}, ${sql.json(claims as never)})`;
  return { token, userId, principal: `admin:${userId}` };
}

async function grantTo(principal: string, capability: string) {
  await sql`INSERT INTO admin_cap_grants (principal, capability, granted_by) VALUES (${principal}, ${capability}, ${T})`;
}

let op: { token: string; userId: number; principal: string };
let viewer: { token: string; userId: number; principal: string };
let unknown: { token: string; userId: number; principal: string };
let app: FastifyInstance;

const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });
const sorted = (xs: string[]) => [...xs].sort();

before(async () => {
  for (const r of await sql<{ id: number }[]>`SELECT id FROM admin_users`) preexistingUserIds.add(r.id);
  op = await sessionFor("admin@local");          // the G00-verified legacy operator address
  viewer = await sessionFor(`viewer-${T}@test`);
  unknown = await sessionFor(`unknown-${T}@test`);
  await grantTo(`admin:${viewer.userId}`, "channel:read");
  await grantTo(`admin:${viewer.userId}`, "channel:feedback");

  app = Fastify();
  app.get("/t/operate-default", adminHandler(async () => ({ ok: true })));
  app.post("/t/operate-default", adminHandler(async () => ({ ok: true })));
  app.get("/t/channel-read", adminHandler(async () => ({ ok: true }), { cap: "channel:read" }));
  app.post("/t/channel-feedback", adminHandler(async () => ({ ok: true }), { cap: "channel:feedback" }));
  app.get("/t/me", adminHandler(async (_req, _reply, admin) => ({ capabilities: admin.capabilities }), { cap: null }));
  await app.ready();
});

after(async () => {
  await sql`DELETE FROM admin_cap_grants WHERE granted_by = ${T}`;
  if (createdUserIds.length) {
    await sql`DELETE FROM admin_sessions WHERE user_id IN ${sql(createdUserIds)}`;
    await sql`DELETE FROM admin_users WHERE id IN ${sql(createdUserIds)}`;
  }
  await closeDb();
});

// ---- R1-R3: derivation is fail-closed, compat is the only default, grants stay separated ----

test("R1 unknown principal without grants gets no capabilities (fail-closed, never operator)", async () => {
  const p = await sessionPrincipal(`${SESSION_COOKIE}=${unknown.token}`);
  assert.ok(p && !p.dev);
  assert.deepEqual(p!.capabilities, []);
});

test("R2 legacy operator (admin@local) keeps exactly admin:operate while unmanaged", async () => {
  const p = await sessionPrincipal(`${SESSION_COOKIE}=${op.token}`);
  assert.deepEqual(sorted(p!.capabilities), ["admin:operate"]);
});

test("R3 granted viewer gets exactly its grants and no operator capability", async () => {
  const p = await sessionPrincipal(`${SESSION_COOKIE}=${viewer.token}`);
  assert.deepEqual(sorted(p!.capabilities), ["channel:feedback", "channel:read"]);
});

// ---- R4/R4b: query-time validation — revocation and grants apply on the next request ----

test("R4 revoke and re-grant hit the same live session token on the next call", async () => {
  const cookieHeader = `${SESSION_COOKIE}=${viewer.token}`;
  await sql`UPDATE admin_cap_grants SET revoked_at = now() WHERE principal = ${viewer.principal} AND capability = 'channel:read'`;
  assert.deepEqual(sorted((await sessionPrincipal(cookieHeader))!.capabilities), ["channel:feedback"]);
  await sql`UPDATE admin_cap_grants SET revoked_at = null WHERE principal = ${viewer.principal} AND capability = 'channel:read'`;
  assert.deepEqual(sorted((await sessionPrincipal(cookieHeader))!.capabilities), ["channel:feedback", "channel:read"]);
});

test("R4b operator entering strict mode loses compat, and revoking its rows loses everything", async () => {
  const cookieHeader = `${SESSION_COOKIE}=${op.token}`;
  await grantTo(op.principal, "channel:read");
  assert.deepEqual(sorted((await sessionPrincipal(cookieHeader))!.capabilities), ["channel:read"]);
  await sql`UPDATE admin_cap_grants SET revoked_at = now() WHERE principal = ${op.principal}`;
  assert.deepEqual((await sessionPrincipal(cookieHeader))!.capabilities, []);
});

// ---- R5: the capability vocabulary is enforced by the storage itself ----

test("R5 admin_cap_grants rejects unknown capability values", async () => {
  await assert.rejects(grantTo(unknown.principal, "super:admin"));
});

// ---- R6-R9: the adminHandler guard (inject() — the app never listens) ----

test("R6 viewer reads its channel route, is denied operate routes, feedback keeps CSRF", async () => {
  const read = await app.inject({ method: "GET", url: "/t/channel-read", headers: cookie(viewer.token) });
  assert.equal(read.statusCode, 200);
  const operateGet = await app.inject({ method: "GET", url: "/t/operate-default", headers: cookie(viewer.token) });
  assert.equal(operateGet.statusCode, 403);
  const operatePost = await app.inject({ method: "POST", url: "/t/operate-default", headers: { ...cookie(viewer.token), "x-csrf-token": CSRF } });
  assert.equal(operatePost.statusCode, 403);
  const feedbackNoCsrf = await app.inject({ method: "POST", url: "/t/channel-feedback", headers: cookie(viewer.token) });
  assert.equal(feedbackNoCsrf.statusCode, 403);
  const feedback = await app.inject({ method: "POST", url: "/t/channel-feedback", headers: { ...cookie(viewer.token), "x-csrf-token": CSRF } });
  assert.equal(feedback.statusCode, 200);
});

test("R7 forged body/header capability values never upgrade a viewer", async () => {
  const forged = {
    ...cookie(viewer.token),
    "x-csrf-token": CSRF,
    "x-capabilities": "admin:operate",
    "x-admin-capability": "admin:operate",
    "content-type": "application/json",
  };
  const res = await app.inject({ method: "POST", url: "/t/operate-default", headers: forged, payload: { capabilities: ["admin:operate"] } });
  assert.equal(res.statusCode, 403);
});

test("R7b forged cookies stay unauthenticated, CSRF correctness never substitutes for a capability", async () => {
  const noSession = await app.inject({ method: "GET", url: "/t/me", headers: { cookie: `${SESSION_COOKIE}=forged-${T}` } });
  assert.equal(noSession.statusCode, 401);
  const joint = await app.inject({
    method: "POST", url: "/t/operate-default",
    headers: { ...cookie(viewer.token), "x-csrf-token": CSRF, "x-capabilities": "admin:operate" },
    payload: { capabilities: ["admin:operate"] },
  });
  assert.equal(joint.statusCode, 403);
});

test("R8 /me needs no capability and echoes only the server-decided set", async () => {
  const me = await app.inject({ method: "GET", url: "/t/me", headers: { ...cookie(viewer.token), "x-capabilities": "admin:operate" } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(sorted(me.json().capabilities), ["channel:feedback", "channel:read"]);
});

test("R9 ungranted sessions are denied on channel routes too (unknown deny by default)", async () => {
  const channel = await app.inject({ method: "GET", url: "/t/channel-read", headers: cookie(unknown.token) });
  assert.equal(channel.statusCode, 403);
  const operate = await app.inject({ method: "GET", url: "/t/operate-default", headers: cookie(unknown.token) });
  assert.equal(operate.statusCode, 403);
});

// ---- R10: the development stand-in keeps its legacy meaning (child process: env is frozen at import) ----

test("R10 dev impersonation carries admin:operate compat and stays dev", async () => {
  const script = [
    'process.env.DEV_AUTH_ROLE = "admin";',
    'const { sessionPrincipal, SESSION_COOKIE } = await import(process.env.CHILD_MOD);',
    'const p = await sessionPrincipal(SESSION_COOKIE + "=not-a-real-token");',
    'console.log(JSON.stringify(p && { dev: p.dev, userId: p.userId, caps: [...p.capabilities].sort() }));',
    'process.exit(0);',
  ].join("\n");
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, CHILD_MOD: pathToFileURL(join(process.cwd(), "packages", "backend", "src", "admin", "auth.ts")).href },
    });
    let so = "";
    child.stdout.on("data", (c) => (so += c));
    child.on("close", () => resolve(so.trim()));
    child.on("error", reject);
  });
  const p = JSON.parse(out) as { dev: boolean; userId: number | null; caps: string[] };
  assert.equal(p.dev, true);
  assert.equal(p.userId, null);
  assert.deepEqual(p.caps, ["admin:operate"]);
});
