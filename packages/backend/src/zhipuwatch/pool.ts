// 智谱免费池（ym438 S02）：settings 键 zhipuwatch.pool 记录定价页见过的免费模型清单（自动接入
// 的结果面；无 zhipu: 前缀，与预设回退同形）。新免费模型自动写 model_watch_models（zhipu: 前缀，
// status=observing）→ 夜批能力验收（capability-test 对 zhipu: 成员自动用智谱免费预设钉选）→
// 证书 → 路由，全程零人工；时间线由 model_watch_events（kind=zhipu_onboard）留痕。
// 连续失败自动摘池：验收轮里整轮调用全失败的模型记一次失败（settings zhipuwatch.failstreak），
// 连续 AUTO_RETIRE_STREAK 轮即置 status=filtered（摘出验收队列/路由），从池移除并落事件；
// 任何一轮有成功调用即清零。口径：只算「调用全失败」（模型不存在/端点拒答），判卷 rejected
// 是有效结论不算失败。
import { sql } from "../db.ts";
import { addEvent } from "../modelwatch/store.ts";

export const ZHIPU_POOL_KEY = "zhipuwatch.pool";
export const ZHIPU_FAILSTREAK_KEY = "zhipuwatch.failstreak";
/** 连续全失败轮数阈值：连续 3 轮（约 3 天）即自动摘池。 */
export const AUTO_RETIRE_STREAK = 3;
/** 缺省池（=ym436 落地态）：settings 未写时 ZHIPU_FREE_KEY 预设的回退模型。 */
export const ZHIPU_POOL_DEFAULT = ["glm-4.7-flash"];

export interface ZhipuPoolState {
  models: string[];
  /** true=settings 尚无记录，models 是默认回退（首次扫描落池后转 false）。 */
  defaulted: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const zhipuModelIdOf = (model: string): string => `zhipu:${model.trim().toLowerCase()}`;

export async function getZhipuPool(): Promise<ZhipuPoolState> {
  const rows = await sql<{ value: { models?: unknown; updatedAt?: unknown; updatedBy?: unknown } | null }[]>`
    SELECT value FROM settings WHERE key = ${ZHIPU_POOL_KEY}`;
  const v = rows[0]?.value ?? null;
  const models = Array.isArray(v?.models) ? (v!.models as unknown[]).filter((m): m is string => typeof m === "string") : [];
  if (models.length === 0) {
    return { models: [...ZHIPU_POOL_DEFAULT], defaulted: true, updatedAt: null, updatedBy: null };
  }
  return {
    models,
    defaulted: false,
    updatedAt: typeof v?.updatedAt === "string" ? v.updatedAt : null,
    updatedBy: typeof v?.updatedBy === "string" ? v.updatedBy : null,
  };
}

/** 路由快照用：池清单（无则默认回退）。 */
export async function zhipuPoolModels(): Promise<string[]> {
  return (await getZhipuPool()).models;
}

async function saveZhipuPool(state: ZhipuPoolState, actor: string): Promise<void> {
  const value = { models: state.models, updatedAt: new Date().toISOString(), updatedBy: actor };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${ZHIPU_POOL_KEY}, ${sql.json(value as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** 自动接入（幂等）：model_watch_models 无此行才插入（曾 filtered/ended 的行不复活——人工结论
 *  优先）；池清单去重并入，且已 filtered/ended 的模型不入池（shoumen P3-6 销项：退休模型经
 *  页面更新复发=摘池被反悔）。返回 created 供路由动作留痕；retired=已有终态行跳过。 */
export async function onboardZhipuModel(input: {
  model: string; name: string; contextTokens: number | null; sourceUrl: string; note: string;
}): Promise<{ modelId: string; created: boolean; retired: boolean }> {
  const modelId = zhipuModelIdOf(input.model);
  const existing = await sql<{ status: string }[]>`SELECT status FROM model_watch_models WHERE model_id = ${modelId}`;
  if (existing[0] && (existing[0]!.status === "filtered" || existing[0]!.status === "ended")) {
    return { modelId, created: false, retired: true };
  }
  const inserted = await sql<{ model_id: string }[]>`
    INSERT INTO model_watch_models
      (model_id, name, vendor, tier, context_length, supports_vision, supports_json,
       free_from, last_prompt_price, last_completion_price, status, verdict_note, provider_facts)
    VALUES
      (${modelId}, ${input.name}, 'zhipu', 'free_tier', ${input.contextTokens}, false, true,
       now(), '0', '0', 'observing', ${input.note},
       ${sql.json({ channel: "zhipu", baseUrlEnv: "ZHIPU_BASE_URL", autoOnboard: true, sourceUrl: input.sourceUrl } as never)})
    ON CONFLICT (model_id) DO NOTHING RETURNING model_id`;
  const created = inserted.length > 0;
  if (created) await addEvent("zhipu_onboard", modelId, { name: input.name, contextLength: input.contextTokens, sourceUrl: input.sourceUrl, note: input.note });
  const pool = await getZhipuPool();
  const key = input.model.trim().toLowerCase();
  if (!pool.models.includes(key)) {
    await saveZhipuPool({ ...pool, models: [...pool.models, key] }, "system: zhipu-watch");
  }
  return { modelId, created, retired: false };
}

export async function removeFromZhipuPool(model: string, actor: string): Promise<void> {
  const key = model.trim().toLowerCase();
  const pool = await getZhipuPool();
  if (!pool.models.includes(key)) return;
  await saveZhipuPool({ ...pool, models: pool.models.filter((m) => m !== key) }, actor);
}

// ---- 连续失败摘池 ----

export interface RoundOutcome {
  modelId: string;
  calls: number;
  ok: number;
  lastError: string | null;
}

export interface FailStreak {
  count: number;
  lastAt: string;
  lastError: string | null;
}

/** 纯函数（判别测试用）：按本轮结果推进连续失败计数。
 *  有成功调用 → 清零；整轮调用全失败 → +1；达到阈值 → 出退休名单并清计数。 */
export function nextFailStreak(
  state: Record<string, FailStreak>, rounds: RoundOutcome[], at: string,
): { state: Record<string, FailStreak>; cleared: string[]; retired: Array<{ modelId: string; streak: FailStreak }> } {
  const next: Record<string, FailStreak> = { ...state };
  const cleared: string[] = [];
  const retired: Array<{ modelId: string; streak: FailStreak }> = [];
  for (const r of rounds) {
    if (r.calls <= 0) continue;
    if (r.ok > 0) {
      if (next[r.modelId]) {
        delete next[r.modelId];
        cleared.push(r.modelId);
      }
      continue;
    }
    const prev = next[r.modelId]?.count ?? 0;
    const streak: FailStreak = { count: prev + 1, lastAt: at, lastError: r.lastError ? r.lastError.slice(0, 200) : null };
    if (streak.count >= AUTO_RETIRE_STREAK) {
      delete next[r.modelId];
      retired.push({ modelId: r.modelId, streak });
    } else {
      next[r.modelId] = streak;
    }
  }
  return { state: next, cleared, retired };
}

/** 验收轮收尾调用（capability-test 仅传 zhipu: 成员的结果）：推进失败计数，达阈值即自动摘池
 *  （status=filtered + 池移除 + 事件 zhipu_auto_retire 留痕），计数状态存 settings。 */
export async function recordZhipuRoundOutcomes(rounds: RoundOutcome[], now = new Date()): Promise<{ retired: string[] }> {
  const zhipu = rounds.filter((r) => r.modelId.startsWith("zhipu:") && r.calls > 0);
  if (zhipu.length === 0) return { retired: [] };
  const rows = await sql<{ value: Record<string, FailStreak> | null }[]>`SELECT value FROM settings WHERE key = ${ZHIPU_FAILSTREAK_KEY}`;
  const result = nextFailStreak(rows[0]?.value ?? {}, zhipu, now.toISOString());
  const retired: string[] = [];
  for (const { modelId, streak } of result.retired) {
    const note = `ym438 自动摘池：连续 ${streak.count} 轮验收全部调用失败（最近：${streak.lastError ?? "无错误文本"}）`;
    const updated = await sql<{ model_id: string }[]>`
      UPDATE model_watch_models SET status = 'filtered', verdict_note = ${note}, updated_at = now()
      WHERE model_id = ${modelId} AND status NOT IN ('filtered', 'ended') RETURNING model_id`;
    if (updated.length === 0) continue; // 已人工处理过：尊重既有状态，只清计数
    await addEvent("zhipu_auto_retire", modelId, { streak: streak.count, lastError: streak.lastError, note });
    await removeFromZhipuPool(modelId.replace(/^zhipu:/, ""), "system: zhipu-watch");
    retired.push(modelId);
  }
  const value = result.state;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${ZHIPU_FAILSTREAK_KEY}, ${sql.json(value as never)}, 'system: zhipu-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return { retired };
}
