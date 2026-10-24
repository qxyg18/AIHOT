// T06C/ym259 自治接线反例与正常路径测试（W1-W7）：真实 registerAdmin 路由面 + fastify
// inject（零监听）。覆盖：未登录/越权拒、HUB 投影缺失降级（unknown）、新鲜投影六态透传、
// 缓存过期→stale、坏件不 500、无影子写接口。全部跑在 *_test 隔离库（setup.ts 守卫）。
import "./setup.ts";

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { sha256 } from "@aihot/backend/lib/ids";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = `t06c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CSRF = `csrf-${T}`;
const APP = { id: `app-${T}`, secret: `secret-${T}` };
const DIR = mkdtempSync(join(tmpdir(), "t06c-"));

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
  const claims = { appId: APP.id, unionId: `t06c-${userId}`, email: null };
  Object.assign(process.env, { FEISHU_LOGIN_APP_ID: APP.id, FEISHU_LOGIN_APP_SECRET: APP.secret });
  if (!config.adminUnionIds.includes(claims.unionId)) config.adminUnionIds.push(claims.unionId);
  const binding = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${userId}, ${CSRF}, ${new Date(Date.now() + 3_600_000)}, null,
                    'feishu', ${binding}, ${sql.json(claims as never)})`;
  return { token, userId, principal: `admin:${userId}` };
}

const STATES = ["defined", "enabled", "active", "verified", "stale", "unknown"];
const capsPayload = STATES.map((s) => ({ key: `cap-${s}`, title: `能力-${s}`, state: s, detail: `样本 ${s}`, updatedAt: null }));
const decisionsPayload = [{
  id: "d-ra-sample", title: "样本决策", question: "大白话：样本问题", status: "pending",
  options: [{ id: "a", label: "甲", gain: "g", risk: "r", recommended: true }],
  taskId: null, decidedAt: null, history: [],
}];

function writeProjection(content: string): string {
  const p = join(DIR, `proj-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(p, content, "utf8");
  process.env.AUTONOMY_PROJECTION_PATH = p;
  return p;
}

interface S { token: string; userId: number; principal: string }
let op: S, unknown: S;
let app: FastifyInstance;

const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });

before(async () => {
  for (const r of await sql<{ id: number }[]>`SELECT id FROM admin_users`) preexistingUserIds.add(r.id);
  op = await sessionFor("admin@local"); // the G00-verified legacy operator address (compat)
  unknown = await sessionFor(`unknown-${T}@test`);
  app = Fastify();
  registerAdmin(app);
  await app.ready();
});

after(async () => {
  await app.close();
  if (createdUserIds.length) {
    await sql`DELETE FROM admin_sessions WHERE user_id IN ${sql(createdUserIds)}`;
    await sql`DELETE FROM admin_users WHERE id IN ${sql(createdUserIds)}`;
  }
  delete process.env.AUTONOMY_PROJECTION_PATH;
  rmSync(DIR, { recursive: true, force: true });
  await closeDb();
});

test("W1 未登录 GET /api/admin/autonomy → 401（AC1 未登录拒绝）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "unauthorized");
});

test("W2 已登录、无 admin:operate grant、非 compat 会话 GET → 403（越权 deny）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy", headers: cookie(unknown.token) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "forbidden");
});

test("W3 投影缓存件缺失 → 200 hubAvailable=false（HUB unavailable 显示 unknown/stale，AC2 降级）", async () => {
  delete process.env.AUTONOMY_PROJECTION_PATH; // 回落 AIHOT_CREDENTIALS_DIR（setup 指向不存在目录）
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy", headers: cookie(op.token) });
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.source, "hub");
  assert.equal(d.hubAvailable, false);
  assert.deepEqual(d.capabilities, []);
  assert.deepEqual(d.decisions, []);
});

test("W4 新鲜投影 → 200 hubAvailable=true、六态原样透传、决策透传", async () => {
  writeProjection(JSON.stringify({
    source: "hub", generatedAt: new Date().toISOString(), hubAvailable: true,
    capabilities: capsPayload, decisions: decisionsPayload,
  }));
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy", headers: cookie(op.token) });
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.hubAvailable, true);
  assert.deepEqual(d.capabilities.map((c: { state: string }) => c.state), STATES);
  assert.equal(d.decisions.length, 1);
  assert.equal(d.decisions[0].id, "d-ra-sample");
});

test("W5 缓存过期（generatedAt 30h 前）→ 200 各能力态按 stale 显示（AC1 缓存过期显示 stale）", async () => {
  writeProjection(JSON.stringify({
    source: "hub", generatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), hubAvailable: true,
    capabilities: capsPayload, decisions: decisionsPayload,
  }));
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy", headers: cookie(op.token) });
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.hubAvailable, true);
  assert.ok(d.capabilities.length === STATES.length && d.capabilities.every((c: { state: string }) => c.state === "stale"), "过期缓存全部按 stale 呈现");
});

test("W6 坏件（非 JSON）→ 200 hubAvailable=false（解析失败不 500、不冒称空数据）", async () => {
  writeProjection("{not json");
  const res = await app.inject({ method: "GET", url: "/api/admin/autonomy", headers: cookie(op.token) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().hubAvailable, false);
});

test("W7 无影子写接口：POST /api/admin/autonomy → 404（只读投影，无执行/批准面）", async () => {
  const res = await app.inject({ method: "POST", url: "/api/admin/autonomy", headers: cookie(op.token) });
  assert.equal(res.statusCode, 404);
});
