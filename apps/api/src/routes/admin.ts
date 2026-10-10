// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "@aihot/backend/admin/auth";

import { importSelectBenchRun, listSelectBenchRuns, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";

import { contentChain, detachFromFact, mergeStories, overrideFields, rerun, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { banSource, eraseFeedback, feedbackScreenshot, listFeedback, unbanSource, updateFeedback } from "@aihot/backend/admin/feedback";
import { listMonitorEvents, listMonitorPosts, relinkPost, resolveMonitorPost, reviewReceipt, setWithdrawn, updateMonitorEvent } from "@aihot/backend/admin/monitor";
import { releaseReceipt, requeueFailedArticles, resolveDelivery, runsOverview } from "@aihot/backend/admin/runs";
import { listBudgets, listTargets, replaceContactQr, setTargetEnabled, updateBudget } from "@aihot/backend/admin/settings";
import { llmConfigOverview, setLlmConfig, testLlmConnection } from "@aihot/backend/admin/llmconfig";
import { apiRouterOverview, resetApiRouterState, setApiRouterConfig } from "@aihot/backend/admin/api-router";
import { modelWatchOverview, runModelWatchScan, setModelWatchConfig, setModelWatchVerdict } from "@aihot/backend/admin/modelwatch";
import { ossWatchOverview, registerOssProject, runOssReview, runOssScan } from "@aihot/backend/admin/osswatch";
import { runZhipuReview, runZhipuScan, zhipuWatchOverview } from "@aihot/backend/admin/zhipuwatch";
import { loadOpportunities } from "@aihot/backend/opportunities/read";
import { reviewOpportunity } from "@aihot/backend/opportunities/review";
import { createSource, fetchNow, listSources, previewSource, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import type { AdminOccupancyState } from "@aihot/contracts/site";
import { ADMIN_OCCUPANCY_STATES } from "@aihot/contracts/site";
import { sql } from "@aihot/backend/db";
import { loadContact } from "@aihot/backend/site/contact";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

function decodeImage(dataUrl: unknown): Buffer {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(String(dataUrl ?? ""));
  if (!m) throw Object.assign(new Error("image must be a PNG, JPEG or WebP data URL"), { statusCode: 400 });
  return Buffer.from(m[2]!, "base64");
}

// Five occupancy states accepted by confirm: single source in @aihot/contracts/site
// (ADMIN_OCCUPANCY_STATES, ym326 audit P2-2) — shared with opportunities/read.ts & review.ts.

// ---- 自治闭环投影（T06C/ym259）：HUB 权威的脱敏自治只读投影 ----
// HUB 侧把自治状态与决策队列的脱敏投影写到凭据目录（宿主 D:/secrets/aihot → 容器
// /secrets 只读挂载；路径可用 AUTONOMY_PROJECTION_PATH 覆盖）。本端点只读该缓存件：
// 缺失/坏件 = hubAvailable=false（页面显示 unknown）；generatedAt 过期 = 各能力态按
// stale 显示。无执行/批准影子接口——HUB 是唯一权威。契约同 web 侧 admin/autonomy.tsx
// 的冻结 DTO（AutonomyProjection）。
interface AutonomyDecisionDTO {
  id: string;
  title: string;
  question: string;
  status: "pending" | "decided" | "suspended";
  options: Array<{ id: string; label: string; gain: string; risk: string; recommended: boolean }>;
  taskId: string | null;
  decidedAt: string | null;
  history: string[];
}
interface AutonomyCapabilityDTO { key: string; title: string; state: string; detail: string; updatedAt: string | null }
interface AutonomyProjectionDTO {
  source: "hub";
  generatedAt: string;
  hubAvailable: boolean;
  capabilities: AutonomyCapabilityDTO[];
  decisions: AutonomyDecisionDTO[];
}
const AUTONOMY_STALE_AFTER_H = 26; // 与 24h 自治节奏留 2h 余量
const AUTONOMY_STATES = new Set(["defined", "enabled", "active", "verified", "stale", "unknown"]);

async function autonomyProjection(): Promise<AutonomyProjectionDTO> {
  const dir = process.env.AIHOT_CREDENTIALS_DIR || "/secrets";
  const file = process.env.AUTONOMY_PROJECTION_PATH || `${dir}/autonomy-projection.json`;
  const unavailable: AutonomyProjectionDTO = {
    source: "hub", generatedAt: new Date().toISOString(), hubAvailable: false, capabilities: [], decisions: [],
  };
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return unavailable; // 文件缺失=HUB 侧投影未就位/不可达（可预期降级，非 500）
  }
  try {
    const d = JSON.parse(raw) as Partial<AutonomyProjectionDTO>;
    const caps = Array.isArray(d.capabilities)
      ? d.capabilities.filter((c): c is AutonomyCapabilityDTO =>
          !!c && typeof c.key === "string" && typeof c.title === "string" && AUTONOMY_STATES.has(String(c.state)))
      : [];
    const decisions = Array.isArray(d.decisions)
      ? d.decisions.filter((x): x is AutonomyDecisionDTO => !!x && typeof x.id === "string")
      : [];
    const generatedAt = typeof d.generatedAt === "string" ? d.generatedAt : "";
    const ts = Date.parse(generatedAt);
    const stale = !Number.isFinite(ts) || Date.now() - ts > AUTONOMY_STALE_AFTER_H * 3_600_000;
    return {
      source: "hub",
      generatedAt,
      hubAvailable: true,
      capabilities: stale ? caps.map((c) => ({ ...c, state: "stale" })) : caps,
      decisions,
    };
  } catch {
    return unavailable; // 坏件=不可达（不把解析失败当空数据呈现）
  }
}

export function registerAdmin(app: FastifyInstance) {
  // Sources (F18)
  app.get("/api/admin/sources", adminHandler(async (req) => {
    const f = q(req);
    return listSources({ q: f.q, kind: f.kind, health: f.health, mode: f.mode, enabled: f.enabled as "true" | "false" | undefined, page: page(req) });
  }));
  app.post("/api/admin/sources", adminHandler(async (req, _reply, admin) => createSource(body(req), actorOf(admin))));
  app.post("/api/admin/sources/preview", adminHandler(async (req) => previewSource(body(req) as never)));
  app.get("/api/admin/sources/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await sourceDetail(param(req, "id")))));
  app.patch("/api/admin/sources/:id", adminHandler(async (req, reply, admin) => {
    const b = body<{ patch: unknown; version: string; reason?: string }>(req);
    return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
  }));
  app.post("/api/admin/sources/:id/preview", adminHandler(async (req, reply) => {
    const [s] = await sql`SELECT * FROM sources WHERE id = ${param(req, "id")}`;
    return s ? previewSource(s as never) : notFound(req, reply);
  }));
  app.post("/api/admin/sources/:id/fetch", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))));

  // Content and events (F19)
  app.get("/api/admin/content", adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "") })));
  app.get("/api/admin/content/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))));
  app.post("/api/admin/content/:id/visibility", adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/seo", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/content/:id/override", adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/rerun", adminHandler(async (req, reply, admin) => {
    const b = body<{ step: "extract" | "analyze" | "group" }>(req);
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rerun(param(req, "id"), b.step, requestId, actorOf(admin)));
  }));
  app.post("/api/admin/content/:id/detach", adminHandler(async (req, _reply, admin) => detachFromFact(param(req, "id"), String(body(req).reason ?? ""), actorOf(admin))));
  app.post("/api/admin/stories/merge", adminHandler(async (req, _reply, admin) => {
    const b = body<{ from: number; into: number; reason: string }>(req);
    return mergeStories(Number(b.from), Number(b.into), b.reason, actorOf(admin));
  }));

  // Feedback
  app.get("/api/admin/feedback", adminHandler(async (req) => listFeedback({ status: q(req).status, q: q(req).q, page: page(req) })));
  app.patch("/api/admin/feedback/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateFeedback(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/feedback/:id/erase", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await eraseFeedback(Number(param(req, "id")), String(body(req).reason ?? ""), actorOf(admin)))));
  app.get("/api/admin/feedback/:id/screenshot", adminHandler(async (req, reply) => {
    const file = await feedbackScreenshot(Number(param(req, "id")));
    const data = file ? await readFile(file).catch(() => null) : null;
    if (!data) return notFound(req, reply);
    const ext = file!.split(".").pop();
    return reply.type(ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`).send(data);
  }));
  app.post("/api/admin/feedback-bans", adminHandler(async (req, reply, admin) => {
    const b = body<{ sourceHash: string; reason: string }>(req);
    await banSource(b.sourceHash, b.reason, actorOf(admin));
    return reply.code(204).send();
  }));
  app.delete("/api/admin/feedback-bans/:hash", adminHandler(async (req, reply, admin) => {
    await unbanSource(param(req, "hash"), actorOf(admin));
    return reply.code(204).send();
  }));

  // Runs (F20)
  app.get("/api/admin/runs", adminHandler(async () => runsOverview()));
  app.post("/api/admin/receipts/:id/release", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await releaseReceipt(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/deliveries/:id/resolve", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveDelivery(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/processing/requeue", adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))));

  // Reset monitor corrections (F12)
  app.get("/api/admin/monitor/events", adminHandler(async (req) => listMonitorEvents({ withdrawn: q(req).withdrawn === "1" })));
  app.get("/api/admin/monitor/posts", adminHandler(async (req) => listMonitorPosts({ filter: q(req).filter as never, page: page(req) })));
  app.patch("/api/admin/monitor/events/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateMonitorEvent(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/monitor/events/:id/receipt-review", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await reviewReceipt(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/monitor/events/:id/withdrawn", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setWithdrawn(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/monitor/relink", adminHandler(async (req, _reply, admin) => relinkPost(body(req) as never, actorOf(admin))));
  app.post("/api/admin/monitor/posts/:id/resolve", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveMonitorPost(param(req, "id"), body(req) as never, actorOf(admin)))));

  // Settings
  app.get("/api/admin/settings", adminHandler(async () => ({ contact: await loadContact(), targets: await listTargets(), budgets: await listBudgets() })));
  app.post("/api/admin/settings/contact-qr", adminHandler(async (req, _reply, admin) => {
    const b = body<{ slot: "wechatQr" | "feishuQr"; image: string }>(req);
    return replaceContactQr({ slot: b.slot, data: decodeImage(b.image) }, actorOf(admin));
  }));
  app.post("/api/admin/notify-targets/:key", adminHandler(async (req, reply, admin) => {
    const b = body<{ enabled: boolean; reason: string }>(req);
    return orNotFound(req, reply, await setTargetEnabled(param(req, "key"), !!b.enabled, b.reason, actorOf(admin)));
  }));
  app.put("/api/admin/budgets/:service", adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))));

  // LLM API endpoint configuration (base URL / API key / model) with a live test button.
  app.get("/api/admin/llm-config", adminHandler(async () => llmConfigOverview()));
  app.put("/api/admin/llm-config", adminHandler(async (req, _reply, admin) => setLlmConfig(body(req) as never, actorOf(admin))));
  app.post("/api/admin/llm/test", adminHandler(async () => testLlmConnection()));

  // 统一接口路由（命主 2026-10-05）：权重链/开关/免费日上限 + 今日健康态手动重置。
  app.get("/api/admin/api-router", adminHandler(async () => apiRouterOverview()));
  app.put("/api/admin/api-router", adminHandler(async (req, _reply, admin) => setApiRouterConfig(body(req) as never, actorOf(admin))));
  app.post("/api/admin/api-router/reset", adminHandler(async (_req, _reply, admin) => resetApiRouterState(actorOf(admin))));


  // Models and evaluation (F20)
  app.get("/api/admin/models", adminHandler(async (req) => modelsOverview(Math.min(90, Number(q(req).days) || 7))));
  app.post("/api/admin/models/:capability", adminHandler(async (req, _reply, admin) => {
    const b = body<{ model: string | null; reason: string }>(req);
    return switchModel(param(req, "capability"), b.model ?? null, String(b.reason ?? ""), actorOf(admin));
  }));

  // 免费模型信源监控（OpenRouter，24h 一轮）：总览 / 立即扫描 / 人工判定（观察窗验收出口）/ 策略开关
  app.get("/api/admin/model-watch", adminHandler(async () => modelWatchOverview()));
  app.post("/api/admin/model-watch/scan", adminHandler(async (_req, _reply, admin) => runModelWatchScan(actorOf(admin))));
  app.put("/api/admin/model-watch/config", adminHandler(async (req, _reply, admin) => setModelWatchConfig(body(req) as never, actorOf(admin))));
  app.post("/api/admin/model-watch/models/:id/verdict", adminHandler(async (req, _reply, admin) => {
    const b = body<{ verdict: "good" | "simple" | "unusable"; note: string }>(req);
    return setModelWatchVerdict(param(req, "id"), b.verdict, String(b.note ?? ""), actorOf(admin));
  }));

  // 自治闭环（T06C/ym259）：HUB 权威的脱敏自治只读投影（只读缓存件；过期→stale、缺失→unknown 降级；无影子操作接口）
  app.get("/api/admin/autonomy", adminHandler(async () => autonomyProjection()));

  // 开源项目跟踪（GitHub 三面采集 → 有料出刊 → 大白话解读）：总览 / 立即扫描 / 立即复核 / 登记项目
  app.get("/api/admin/oss-watch", adminHandler(async () => ossWatchOverview()));
  app.post("/api/admin/oss-watch/scan", adminHandler(async (_req, _reply, admin) => runOssScan(actorOf(admin))));
  app.post("/api/admin/oss-watch/review", adminHandler(async (_req, _reply, admin) => runOssReview(actorOf(admin))));
  app.post("/api/admin/oss-watch/projects", adminHandler(async (req, _reply, admin) => registerOssProject(body(req) as never, actorOf(admin))));

  // 智谱关注·智谱发布（ym437）：5 定点页（.md 直取）+ sitemap 差分日扫 → 有料出刊 → 大白话解读；
  // 总览 / 立即扫描 / 立即复核。
  app.get("/api/admin/zhipu-watch", adminHandler(async () => zhipuWatchOverview()));
  app.post("/api/admin/zhipu-watch/scan", adminHandler(async (_req, _reply, admin) => runZhipuScan(actorOf(admin))));
  app.post("/api/admin/zhipu-watch/review", adminHandler(async (_req, _reply, admin) => runZhipuReview(actorOf(admin))));

  // SelectBench
  app.get("/api/admin/selectbench", adminHandler(async () => ({ runs: await listSelectBenchRuns() })));
  app.get("/api/admin/selectbench/:id", adminHandler(async (req, reply) => {
    const f = q(req);
    return orNotFound(req, reply, await selectBenchRun(param(req, "id"), { model: f.model, outcome: f.outcome, stratum: f.stratum, disagree: f.disagree === "1" }));
  }));
  app.post("/api/admin/selectbench/import", adminHandler(async (req, _reply, admin) => {
    const b = body<{ label: string; report: unknown }>(req);
    return importSelectBenchRun(b.report, String(b.label || "导入的对比运行"), actorOf(admin));
  }));

  // 入驻机会（T19 组件 × T20 能力接线，T06B/ym256）：capability 门在模块内 fail-closed
  // （channel:read/feedback/confirm ∪ admin:operate，与 grants 同表同键），路由层先按同一
  // 并集回 403，未登录与写请求 CSRF 由 adminHandler 统一拒；cap: null 使并集语义不被
  // adminHandler 的单值门截断（operator compat 与 channel viewer 均可到达模块门）。
  app.get("/api/admin/opportunities", adminHandler(async (req, reply, admin) => {
    if (!admin.capabilities.includes("channel:read") && !admin.capabilities.includes("admin:operate")) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "This admin session lacks the required capability." });
    }
    return loadOpportunities(actorOf(admin));
  }, { cap: null }));
  app.post("/api/admin/opportunities/review", adminHandler(async (req, reply, admin) => {
    const b = body<{ entityType: "brand" | "mall"; entitySlug: string; action: "feedback" | "confirm"; state?: AdminOccupancyState; missing?: string[]; feedback?: string | null; hubRef?: string | null }>(req);
    const caps = b.action === "feedback" ? ["channel:feedback", "admin:operate"] : b.action === "confirm" ? ["channel:confirm", "admin:operate"] : null;
    if (!caps) throw Object.assign(new Error("action must be feedback or confirm"), { statusCode: 400 });
    if (!admin.capabilities.some((c) => caps.includes(c))) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "This admin session lacks the required capability." });
    }
    if (b.entityType !== "brand" && b.entityType !== "mall") throw Object.assign(new Error("entityType must be brand or mall"), { statusCode: 400 });
    if (!b.entitySlug) throw Object.assign(new Error("entitySlug is required"), { statusCode: 400 });
    if (b.action === "confirm" && !(ADMIN_OCCUPANCY_STATES as readonly string[]).includes(b.state ?? "")) {
      throw Object.assign(new Error("confirm requires one of the five occupancy states"), { statusCode: 400 });
    }
    return reviewOpportunity({ principal: actorOf(admin), entityType: b.entityType, entitySlug: b.entitySlug, action: b.action, state: b.state, missing: b.missing, feedback: b.feedback, hubRef: b.hubRef });
  }, { cap: null }));

  // Attention counts for the navigation.
  app.get("/api/admin/nav-counts", adminHandler(async () => {
    const [c] = await sql<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
             (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
             (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs,
             (SELECT count(*)::int FROM monitor_posts WHERE (recognition->>'needsReview')::boolean IS TRUE AND (recognition->>'reviewed')::boolean IS NOT TRUE AND processed_at > now() - interval '7 days')
               + (SELECT count(*)::int FROM monitor_posts WHERE processed_at IS NULL AND collected_at < now() - interval '20 minutes') AS monitor`;
    return c;
  }));

  // Audit trail
  app.get("/api/admin/audit", adminHandler(async (req) => {
    const f = q(req);
    const rows = await sql`
      SELECT id, created_at, actor, action, subject, reason, before, after FROM audit_log
      WHERE (${f.subject ?? null}::text IS NULL OR subject = ${f.subject ?? null}) AND (${f.action ?? null}::text IS NULL OR action LIKE ${`${f.action ?? ""}%`})
      ORDER BY created_at DESC LIMIT 100 OFFSET ${(page(req) - 1) * 100}`;
    return { page: page(req), rows };
  }));
}
