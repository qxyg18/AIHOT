// Admin「免费模型信源监控」：监控面总览、手动扫描（不跑探针）、人工质量判定、策略开关。
// 人工判定即 24h 观察窗的验收出口（agent-hub 侧「免费模型24小时观察窗」卡的落点动作）。
import { sql } from "../db.ts";
import { audit } from "./auth.ts";
import { reapplyPolicy, scanModelWatch, type ScanSummary } from "../modelwatch/monitor.ts";
import { openRouterConfigured } from "../modelwatch/openrouter.ts";
import { zhipuCircuitState } from "../providers/zhipu.ts";
import { ensureFreeRouting, invalidateFreeRouting, openRouterCircuitState } from "../modelwatch/routing.ts";
import { listCapabilityRoutes } from "../modelwatch/capability-routing.ts";
import {
  applyVerdict, getLastRun, getRoutingState, getWatchConfig, getWatchModel, listWatchModels, recentEvents, saveWatchConfig, type Verdict,
} from "../modelwatch/store.ts";

export async function modelWatchOverview() {
  const [configured, routing, stored, circuit, config, lastRun, models, events, capRoutes] = await Promise.all([
    openRouterConfigured(),
    ensureFreeRouting(),
    getRoutingState(),
    openRouterCircuitState(),
    getWatchConfig(),
    getLastRun(),
    listWatchModels(),
    recentEvents(40),
    listCapabilityRoutes(),
  ]);
  // ym249：脱敏事实投影（无凭据；HUB/后台按事实消费）。fee 只报计数与实证覆盖，不带金额原文。
  // ym457：智谱免费通道观测并列面（熔断 settings llm.zhipu_circuit / budgets 用量 / 缺行告警）。
  const [fee, budget, zhipuCircuit, zhipuUsed] = await Promise.all([
    sql<{ attempts: number; sent: number; with_cost_evidence: number }[]>`
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE status IN ('received', 'completed'))::int AS sent,
             count(*) FILTER (WHERE cost_evidence <> '{}'::jsonb)::int AS with_cost_evidence
      FROM receipts WHERE service = 'openrouter' AND created_at > now() - interval '7 days'`,
    sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('openrouter', 'llm', 'zhipu-free') ORDER BY service`,
    zhipuCircuitState(),
    sql<{ used: number }[]>`
      SELECT count(*)::int AS used FROM receipt_attempts
      WHERE service = 'zhipu-free' AND origin = 'live' AND started_at > now() - interval '24 hours'`,
  ]);
  const budgetByService = new Map(budget.map((b) => [b.service, b]));
  const suspicious = events.some((e) => e.kind === "catalog_suspicious");
  const catalogVersion = models.reduce((max, m) => (m.catalog_version > max ? m.catalog_version : max), "");
  const maxCertVersion = models.reduce((max, m) => (m.cert_version > max ? m.cert_version : max), "");
  const maxPolicyVersion = models.reduce((max, m) => (m.policy_version > max ? m.policy_version : max), "");
  return {
    configured,
    routing,
    routingUpdatedAt: stored?.updatedAt ?? null,
    circuit,
    config,
    lastRun,
    models,
    events,
    capabilityRoute: routing.capabilityRoute,
    capability: {
      qualified: capRoutes.filter((r) => r.verdict === "qualified").length,
      rejected: capRoutes.filter((r) => r.verdict === "rejected").length,
      lastTestedAt: capRoutes[0]?.tested_at ?? null,
      recent: capRoutes.slice(0, 12).map((r) => ({ model_id: r.model_id, capability: r.capability, verdict: r.verdict, pass_count: r.pass_count, tested_at: r.tested_at })),
    },
    /** ym249 新增段（只增不减，旧消费者不受影响）。 */
    catalog: {
      configured,
      freeCount: models.filter((m) => m.status !== "ended").length,
      lastRunAt: lastRun?.at ?? null,
      suspicious,
      catalogVersion: catalogVersion || null,
    },
    fee: {
      window: "7d",
      attempts: fee[0]?.attempts ?? 0,
      sent: fee[0]?.sent ?? 0,
      withCostEvidence: fee[0]?.with_cost_evidence ?? 0,
    },
    budget: {
      openrouter: budgetByService.get("openrouter") ?? null,
      llm: budgetByService.get("llm") ?? null,
      /** free-only 是 fail-closed：缺行=该服务所有新调用被拒（POST=0）。 */
      openrouterMissing: !budgetByService.has("openrouter"),
    },
    /** ym457：智谱免费通道观测三行（熔断 settings llm.zhipu_circuit / budgets 用量 / 缺行告警），
     *  并列 openrouter 面。缺行=fail-closed（receipts.ts requireBudget：免费面无 budgets 行即拒发）——
     *  同 openrouterMissing 口径；used24h=近 24h live 承接计数。 */
    zhipu: {
      circuit: zhipuCircuit,
      budget: budgetByService.get("zhipu-free") ?? null,
      budgetMissing: !budgetByService.has("zhipu-free"),
      used24h: zhipuUsed[0]?.used ?? 0,
    },
    policyAndVersions: {
      autoSwitch: config.autoSwitch,
      pinned: config.pinned,
      maxPolicyVersion: maxPolicyVersion || null,
      maxCertVersion: maxCertVersion || routing.versions.maxCertVersion,
      checkedAt: routing.versions.checkedAt,
    },
    parked: capRoutes
      .filter((r) => r.verdict === "rejected")
      .map((r) => ({
        model_id: r.model_id,
        capability: r.capability,
        tested_at: r.tested_at,
        parkReason: (r.verdict_payload as Record<string, unknown>).parkReason ?? "真实 schema 认证未通过",
      })),
    counts: {
      free: models.filter((m) => m.status !== "ended").length,
      observing: models.filter((m) => m.status === "observing").length,
      promo: models.filter((m) => m.tier === "promo" && m.status !== "ended").length,
    },
  };
}

/** 手动「立即扫描」：拉列表 + 差分 + 策略重算，不跑探针（探针跟 24h 调度走，扫描保持秒级）。 */
export async function runModelWatchScan(actor: string): Promise<ScanSummary> {
  const summary = await scanModelWatch({ probe: false });
  await audit(actor, "modelwatch.scan", "modelwatch", null, null, { free: summary.free, added: summary.added, ended: summary.ended });
  return summary;
}

/** 人工质量判定（观察窗验收出口）：good=可当主力 / simple=只进简单能力位 / unusable=不用。 */
export async function setModelWatchVerdict(modelId: string, verdict: Verdict, note: string, actor: string) {
  const row = await getWatchModel(modelId);
  if (!row) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
  if (!["good", "simple", "unusable"].includes(verdict)) throw Object.assign(new Error("verdict must be good | simple | unusable"), { statusCode: 400 });
  if (!note.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  const before = { status: row.status, verdict: row.verdict ?? null };
  // 人工结论优先于时间窗：直接结束观察窗。
  await applyVerdict(modelId, verdict, actor, note.trim(), true);
  const routing = await reapplyPolicy();
  await audit(actor, "modelwatch.verdict", `model:${modelId}`, note.trim(), before, { status: verdict === "good" ? "vetted" : verdict, routing });
  return { modelId, before, routing };
}

/** 策略开关：autoSwitch=false 冻结当前路由不再自动切换；pinned=钉选主力（免观察窗）。 */
export async function setModelWatchConfig(input: { autoSwitch?: boolean; pinned?: string | null }, actor: string) {
  const before = await getWatchConfig();
  const next = {
    autoSwitch: typeof input.autoSwitch === "boolean" ? input.autoSwitch : before.autoSwitch,
    pinned: input.pinned === undefined ? before.pinned : input.pinned?.trim() || null,
  };
  await saveWatchConfig(next, actor);
  const routing = await reapplyPolicy();
  invalidateFreeRouting();
  await audit(actor, "modelwatch.config", "modelwatch", null, before, { ...next, routing });
  return { config: next, routing };
}
