// T06B/ym256 后台接线反例与正常路径测试（plan.md W1-W11）：真实 registerAdmin 路由面 +
// fastify inject（零监听）。能力门双层（路由层并集 403 + 模块内 fail-closed）、CSRF、
// operator compat 独立可用、viewer 只读不越权。全部跑在 *_test 隔离库（setup.ts 守卫）。
import "./setup.ts";

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { config, REPO_ROOT } from "@aihot/backend/config";
import { SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { sha256 } from "@aihot/backend/lib/ids";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = `t06b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CSRF = `csrf-${T}`;
const APP = { id: `app-${T}`, secret: `secret-${T}` };

const MALLS = (JSON.parse(readFileSync(join(REPO_ROOT, "database/seeds/lb-malls-2026-10.json"), "utf8")) as {
  malls: Array<{ slug: string; name: string; city?: string }>;
}).malls;
const [MAL_FOR_FEEDBACK, MAL_FOR_CONFIRM, MAL_REJECTED] = MALLS.map((m) => m.slug);

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
  const claims = { appId: APP.id, unionId: `t06b-${userId}`, email: null };
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
  await sql`INSERT INTO admin_cap_grants (principal, capability, granted_by) VALUES (${principal}, ${capability}, ${T})
            ON CONFLICT (principal, capability) DO NOTHING`;
}

interface S { token: string; userId: number; principal: string }
let op: S, viewer: S, confirmer: S, unknown: S;
let app: FastifyInstance;

const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });
const csrf = { "x-csrf-token": CSRF };
const feedbackBody = (slug: string) => ({ entityType: "mall", entitySlug: slug, action: "feedback", feedback: "渠道owner评估中", hubRef: "HUB-ym256" });
const confirmBody = (slug: string, state: string) => ({ entityType: "mall", entitySlug: slug, action: "confirm", state });

before(async () => {
  for (const r of await sql<{ id: number }[]>`SELECT id FROM admin_users`) preexistingUserIds.add(r.id);
  op = await sessionFor("admin@local"); // the G00-verified legacy operator address (compat)
  viewer = await sessionFor(`viewer-${T}@test`);
  confirmer = await sessionFor(`confirmer-${T}@test`);
  unknown = await sessionFor(`unknown-${T}@test`);
  await grantTo(`admin:${viewer.userId}`, "channel:read");
  await grantTo(`admin:${viewer.userId}`, "channel:feedback");
  await grantTo(`admin:${confirmer.userId}`, "channel:confirm");
  app = Fastify();
  registerAdmin(app);
  await app.ready();
});

after(async () => {
  await app.close();
  await sql`DELETE FROM admin_cap_grants WHERE granted_by = ${T}`;
  await sql`DELETE FROM opportunity_reviews WHERE reviewed_by IN ${sql([viewer.principal, confirmer.principal, op.principal])}`;
  if (createdUserIds.length) {
    await sql`DELETE FROM admin_sessions WHERE user_id IN ${sql(createdUserIds)}`;
    await sql`DELETE FROM admin_users WHERE id IN ${sql(createdUserIds)}`;
  }
  await closeDb();
});

test("W1 未登录 GET /api/admin/opportunities → 401（AC2 未登录拒绝）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/opportunities" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "unauthorized");
});

test("W2 已登录、无任何 grant、非 compat 会话 GET → 403（未知身份 deny，AC2/AC3 fail-closed）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/opportunities", headers: cookie(unknown.token) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "forbidden");
});

test("W3 viewer(channel:read) GET → 200，返回名录五状态结构（AC2 只读五状态）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/opportunities", headers: cookie(viewer.token) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { rows: Array<{ entity: { type: string }; occupancy: string; missing: string[] }>; generatedAt: string };
  assert.ok(Array.isArray(body.rows) && body.rows.length >= MALLS.length, "rows 至少覆盖全名录 mall 行");
  assert.equal(new Set(body.rows.map((r) => r.occupancy)).size <= 5, true);
  for (const r of body.rows) assert.ok(r.missing !== undefined, "缺项字段显式存在");
  assert.equal(typeof body.generatedAt, "string");
});

test("W4 viewer POST feedback 缺 CSRF → 403（AC2 反馈有 CSRF）", async () => {
  const res = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(viewer.token), "content-type": "application/json" }, payload: feedbackBody(MAL_FOR_FEEDBACK) });
  assert.equal(res.statusCode, 403);
});

test("W5 viewer POST feedback 带 CSRF → 200 且不改状态（feedback 只提待核）", async () => {
  // 用本文件专属 slug 起步（名录外实体 feedback 合法）：官方 sweep 只清 articles 残留，
  // 名录 slug 可能带着此前套件写入的审阅状态，起步断言须与库残留解耦。
  const slug = `w5-${T}`;
  const res = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(viewer.token), ...csrf, "content-type": "application/json" }, payload: feedbackBody(slug) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { state: string; feedback: string | null; reviewedBy: string | null };
  assert.equal(body.state, "pending_review", "feedback 起新实体从待核起步");
  assert.equal(body.feedback, "渠道owner评估中");
  assert.equal(body.reviewedBy, viewer.principal);
});

test("W6 viewer POST confirm → 403（viewer 无 channel:confirm，不能确认）", async () => {
  // node:test 同文件并发：本例用独立 slug，使「拒绝先于写入」的行级断言不被 W7 的并行写入击穿。
  const res = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(viewer.token), ...csrf, "content-type": "application/json" }, payload: confirmBody(MAL_REJECTED, "confirmed_open") });
  assert.equal(res.statusCode, 403);
  const [row] = await sql`SELECT review_state FROM opportunity_reviews WHERE entity_type = 'mall' AND entity_slug = ${MAL_REJECTED}`;
  assert.equal(row, undefined, "未落任何审阅行（拒绝先于写入）");
});

test("W7 confirmer(仅 channel:confirm) POST confirm → 200；GET → 403（read 并集不含 confirm-only）", async () => {
  const post = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(confirmer.token), ...csrf, "content-type": "application/json" }, payload: confirmBody(MAL_FOR_CONFIRM, "historical") });
  assert.equal(post.statusCode, 200);
  assert.equal((post.json() as { state: string }).state, "historical");
  const get = await app.inject({ method: "GET", url: "/api/admin/opportunities", headers: cookie(confirmer.token) });
  assert.equal(get.statusCode, 403);
});

test("W8 已授权 operator(grant 行 admin:operate) GET → 200 且 POST feedback → 200（AC1；compat 无行缝隙见遗留登记，证据另录）", async () => {
  // 兼容语义边界（手动取证入 evidence/compat-probe.txt）：admin@local compat 会话过路由层并集门
  // 后被 T19 模块内纯 grant 行门拒（500 capability_required）。生产启用前须授 operator grant
  // 行（T20 授权面）或模块适配 compat——本卡允许面外，登记遗留。此处模拟生产已授权态。
  await grantTo(op.principal, "admin:operate");
  const get = await app.inject({ method: "GET", url: "/api/admin/opportunities", headers: cookie(op.token) });
  assert.equal(get.statusCode, 200);
  const post = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(op.token), ...csrf, "content-type": "application/json" }, payload: { entityType: "brand", entitySlug: `brand-probe-${T}`, action: "feedback", feedback: null } });
  assert.equal(post.statusCode, 200);
});

test("W8b grant 仅 admin:operate（无 channel:* 行）POST confirm → 200（audit P3-2：operator 走 grant 行的 confirm 正路）", async () => {
  await grantTo(op.principal, "admin:operate");
  const res = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: { ...cookie(op.token), ...csrf, "content-type": "application/json" }, payload: { entityType: "mall", entitySlug: `w8b-${T}`, action: "confirm", state: "planned" } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { state: string }).state, "planned");
});

test("W9 viewer 直调运营 API GET /api/admin/sources → 403（AC2 运营面拒 viewer）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/sources", headers: cookie(viewer.token) });
  assert.equal(res.statusCode, 403);
});

test("W10/W11 参数面：action 非法/entityType 非法/缺 entitySlug/confirm 缺或坏 state → 400", async () => {
  const h = { ...cookie(op.token), ...csrf, "content-type": "application/json" };
  const cases: Array<Record<string, unknown>> = [
    { entityType: "mall", entitySlug: MAL_FOR_FEEDBACK, action: "bogus" },
    { entityType: "store", entitySlug: MAL_FOR_FEEDBACK, action: "feedback" },
    { entityType: "mall", entitySlug: "", action: "feedback" },
    { entityType: "mall", entitySlug: MAL_FOR_FEEDBACK, action: "confirm" },
    { entityType: "mall", entitySlug: MAL_FOR_FEEDBACK, action: "confirm", state: "maybe_open" },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: "POST", url: "/api/admin/opportunities/review", headers: h, payload: payload as never });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().code, "invalid_request");
  }
});
