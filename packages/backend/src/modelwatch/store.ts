// model_watch 两张表的读写 + modelwatch.* settings 键。只做存取与迁移写，不含策略。
import { sql } from "../db.ts";
import type { OrModel, ProbeResult } from "./openrouter.ts";
import type { RoutingState } from "./routing.ts";

export type WatchStatus = "observing" | "vetted" | "simple" | "unusable" | "listed" | "filtered" | "ended";
export type Verdict = "good" | "simple" | "unusable";

export interface WatchRow {
  model_id: string;
  name: string;
  vendor: string;
  tier: "promo" | "free_tier";
  context_length: number | null;
  supports_vision: boolean;
  supports_json: boolean;
  free_from: Date | null;
  free_until_hint: string | null;
  last_prompt_price: string;
  last_completion_price: string;
  status: WatchStatus;
  verdict: Verdict | null;
  verdict_at: Date | null;
  verdict_by: string | null;
  verdict_note: string | null;
  observe_until: Date | null;
  probe: ProbeResult | null;
  /** ym249（0052-D）：策略/目录/探针/证书版本与脱敏 provider 事实；version 行 CAS。 */
  policy_version: string;
  catalog_version: string;
  probe_version: string;
  cert_version: string;
  provider_facts: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** ym249：目录轮见的脱敏事实（无凭据；供路由过滤与后台 DTO 消费）。 */
export function providerFactsOf(m: OrModel): Record<string, unknown> {
  return {
    promptPrice: m.promptPrice,
    completionPrice: m.completionPrice,
    contextLength: m.contextLength,
    supportsText: m.supportsText,
    supportsVision: m.supportsVision,
    outputLimit: m.outputLimit,
  };
}

export interface WatchEvent {
  id: number;
  model_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function listWatchModels(): Promise<WatchRow[]> {
  return sql<WatchRow[]>`SELECT * FROM model_watch_models ORDER BY (status = 'ended'), tier, free_from DESC NULLS LAST, model_id`;
}

export async function getWatchModel(modelId: string): Promise<WatchRow | null> {
  const rows = await sql<WatchRow[]>`SELECT * FROM model_watch_models WHERE model_id = ${modelId}`;
  return rows[0] ?? null;
}

/** 新免费模型入行。promo 进 24h 观察窗；常年免费档只陈列（listed）。沿革：2026-10-02 口径下
 *  上下文不足 1M 的 promo 落 filtered 仅陈列；命主 2026-10-13 重核定放开该闸——不足 1M 同样进
 *  观察窗，去留以实测质量定（filtered 现仅余通道池连续失败自动摘池等既有路径；人工判定可越线启用）。 */
export async function insertFreeModel(m: OrModel, observeUntil: Date, eligible: boolean): Promise<void> {
  const status = m.tier === "free_tier" ? "listed" : eligible ? "observing" : "filtered";
  await sql`
    INSERT INTO model_watch_models (model_id, name, vendor, tier, context_length, supports_vision, supports_json,
      free_from, free_until_hint, last_prompt_price, last_completion_price, status, observe_until, verdict_note,
      catalog_version, provider_facts)
    VALUES (${m.id}, ${m.name}, ${m.vendor}, ${m.tier}, ${m.contextLength}, ${m.supportsVision}, ${m.supportsJson},
      now(), ${m.freeUntilHint}, ${m.promptPrice}, ${m.completionPrice},
      ${status}, ${status === "observing" ? observeUntil : null},
      ${status === "filtered" ? `上下文 ${m.contextLength} 不达启用门槛，仅陈列` : null},
      ${new Date().toISOString()}, ${sql.json(providerFactsOf(m) as never)})
    ON CONFLICT (model_id) DO NOTHING`;
}

/** 每轮都把最新参数刷进去（免费截止 hint 可能滞后出现，所以要持续更新）。
 *  ym249：目录事实随轮落 provider_facts/catalog_version，行更新走 version CAS——并发扫描
 *  同行时后写者 0 行命中即放弃本轮（下一轮再刷），不覆盖对方的版本链。 */
export async function refreshFreeModel(m: OrModel, expectedVersion: number): Promise<boolean> {
  const rows = await sql<{ model_id: string }[]>`
    UPDATE model_watch_models SET name = ${m.name}, vendor = ${m.vendor}, context_length = ${m.contextLength},
      supports_vision = ${m.supportsVision}, supports_json = ${m.supportsJson},
      free_until_hint = coalesce(${m.freeUntilHint}, free_until_hint),
      last_prompt_price = ${m.promptPrice}, last_completion_price = ${m.completionPrice},
      catalog_version = ${new Date().toISOString()},
      provider_facts = ${sql.json(providerFactsOf(m) as never)},
      version = version + 1, updated_at = now()
    WHERE model_id = ${m.id} AND version = ${expectedVersion}
    RETURNING model_id`;
  return rows.length > 0;
}

/** 到期：模型已从免费列表消失（拿不到翻正后价格），价格两栏留空避免误导性地显示零价。 */
export async function markEnded(modelId: string): Promise<void> {
  await sql`UPDATE model_watch_models SET status = 'ended', last_prompt_price = '', last_completion_price = '', updated_at = now() WHERE model_id = ${modelId}`;
}

/** 重新免费（价格翻回零）：重开观察窗，旧判定作废——新窗口是新一次质量验收。 */
export async function reopenFreeModel(m: OrModel, observeUntil: Date, eligible: boolean): Promise<void> {
  const status = m.tier === "free_tier" ? "listed" : eligible ? "observing" : "filtered";
  await sql`UPDATE model_watch_models SET name = ${m.name}, vendor = ${m.vendor}, tier = ${m.tier},
      context_length = ${m.contextLength}, supports_vision = ${m.supportsVision}, supports_json = ${m.supportsJson},
      free_from = now(), free_until_hint = ${m.freeUntilHint},
      last_prompt_price = ${m.promptPrice}, last_completion_price = ${m.completionPrice},
      status = ${status}, verdict = NULL, verdict_at = NULL, verdict_by = NULL, verdict_note = NULL,
      observe_until = ${status === "observing" ? observeUntil : null}, probe = NULL,
      catalog_version = ${new Date().toISOString()}, provider_facts = ${sql.json(providerFactsOf(m) as never)},
      cert_version = '', version = version + 1, updated_at = now()
    WHERE model_id = ${m.id}`;
}

export async function saveProbe(modelId: string, probe: ProbeResult, failStreak: number): Promise<void> {
  await sql`UPDATE model_watch_models SET probe = ${sql.json({ ...probe, failStreak } as never)},
      probe_version = ${probe.at}, version = version + 1, updated_at = now() WHERE model_id = ${modelId}`;
}

// ---- ym249：逐能力认证的持久面（0052-D）----

export interface EvalSampleRow {
  modelId: string;
  capability: string;
  datasetVersion: string;
  promptVersion: string;
  policyVersion: string;
  verdict: string;
  passCount: number;
  payload: Record<string, unknown>;
  receiptId: number | null;
}

/** 逐能力验收原始样本（append-only，表级触发器禁 UPDATE/DELETE）：每轮判卷各落一行。 */
export async function saveEvalSample(row: EvalSampleRow): Promise<void> {
  await sql`INSERT INTO model_free_eval_samples (model_id, capability, dataset_version, prompt_version, policy_version, verdict, pass_count, payload, receipt_id)
    VALUES (${row.modelId}, ${row.capability}, ${row.datasetVersion}, ${row.promptVersion}, ${row.policyVersion}, ${row.verdict},
            ${row.passCount}, ${sql.json(row.payload as never)}, ${row.receiptId})`;
}

/** 证书集版本前进：任一 model×capability 结论变化后调用（消费方据此判快照新鲜度）。 */
export async function bumpCertVersion(modelId: string, note: string): Promise<string> {
  const next = `${new Date().toISOString()}|${note}`.slice(0, 200);
  await sql`UPDATE model_watch_models SET cert_version = ${next}, version = version + 1, updated_at = now() WHERE model_id = ${modelId}`;
  return next;
}

/** 策略版本前进（配置开关/钉选变化时）。 */
export async function bumpPolicyVersion(note: string): Promise<void> {
  const next = `${new Date().toISOString()}|${note}`.slice(0, 200);
  await sql`UPDATE model_watch_models SET policy_version = ${next}, version = version + 1, updated_at = now()`;
}

/** 落判定：verdict 归档三字段 + 状态映射（good→vetted / simple→simple / unusable→unusable），
 *  手动判定顺带结束观察窗（人工结论优先于时间窗），自动判定不动时间窗。 */
export async function applyVerdict(modelId: string, verdict: Verdict, by: string, note: string | null, endObservation: boolean): Promise<void> {
  const status: WatchStatus = verdict === "good" ? "vetted" : verdict === "simple" ? "simple" : "unusable";
  if (endObservation) {
    await sql`UPDATE model_watch_models SET verdict = ${verdict}, verdict_at = now(), verdict_by = ${by},
        verdict_note = ${note}, status = ${status}, observe_until = NULL, updated_at = now()
      WHERE model_id = ${modelId}`;
  } else {
    await sql`UPDATE model_watch_models SET verdict = ${verdict}, verdict_at = now(), verdict_by = ${by},
        verdict_note = ${note}, status = ${status}, updated_at = now()
      WHERE model_id = ${modelId}`;
  }
}

export async function addEvent(kind: string, modelId: string, payload: Record<string, unknown>): Promise<void> {
  await sql`INSERT INTO model_watch_events (model_id, kind, payload) VALUES (${modelId}, ${kind}, ${sql.json(payload as never)})`;
}

export async function recentEvents(limit = 40): Promise<WatchEvent[]> {
  return sql<WatchEvent[]>`SELECT * FROM model_watch_events ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

// ---- settings 键 ----

export interface WatchConfig {
  autoSwitch: boolean;
  pinned: string | null;
}

export async function getWatchConfig(): Promise<WatchConfig> {
  const rows = await sql<{ value: Partial<WatchConfig> | null }[]>`SELECT value FROM settings WHERE key = 'modelwatch.config'`;
  const v = rows[0]?.value ?? {};
  return { autoSwitch: v.autoSwitch !== false, pinned: v.pinned ?? null };
}

export async function saveWatchConfig(next: WatchConfig, actor: string): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.config', ${sql.json(next as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export interface LastRun {
  at: string;
  ok: boolean;
  error: string | null;
  free: number;
  added: number;
  ended: number;
}

export async function getLastRun(): Promise<LastRun | null> {
  const rows = await sql<{ value: LastRun | null }[]>`SELECT value FROM settings WHERE key = 'modelwatch.lastrun'`;
  return rows[0]?.value ?? null;
}

export async function saveLastRun(run: LastRun): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.lastrun', ${sql.json(run as never)}, 'system: model-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function getRoutingState(): Promise<RoutingState | null> {
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'modelwatch.routing'`;
  return (rows[0]?.value as RoutingState | null) ?? null;
}

export async function saveRoutingState(next: RoutingState): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('modelwatch.routing', ${sql.json(next as never)}, 'system: model-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}
