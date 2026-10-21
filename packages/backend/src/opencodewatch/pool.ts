// opencode 免费池（ym467）：settings 键 opencodewatch.pool 记录客户端免费档清单（自动接入的
// 结果面；无 opencode: 前缀，与预设回退同形）。新免费模型自动写 model_watch_models
// （opencode: 前缀，status=observing）→ 夜批能力验收（capability-test 对 opencode: 成员自动
// 用 opencode 免费预设钉选）→ 证书 → 路由，全程零人工；时间线由 model_watch_events
// （kind=opencode_onboard）留痕。连续失败自动摘池：与智谱同口径（3 轮全失败置 filtered）。
// 与智谱注册的差异（平台自述限时免费、目录 24h 一进一出，ym443 R1 实测）：'ended' 行由
// 目录同步写入（scan.ts），目录再现时 onboard 复活（机器结论可逆）；'filtered'（连续失败
// 摘池）不复活（人工结论优先，与智谱一致）。
import { sql } from "../db.ts";
import { addEvent } from "../modelwatch/store.ts";

export const OPENCODE_POOL_KEY = "opencodewatch.pool";
export const OPENCODE_FAILSTREAK_KEY = "opencodewatch.failstreak";
/** 连续全失败轮数阈值：连续 3 轮（约 3 天）即自动摘池。 */
export const AUTO_RETIRE_STREAK = 3;

export interface OpencodePoolState {
  models: string[];
  /** true=settings 尚无记录，models 为空默认（首次扫描落池后转 false）。 */
  defaulted: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const opencodeModelIdOf = (model: string): string => `opencode:${model.trim().toLowerCase()}`;

export async function getOpencodePool(): Promise<OpencodePoolState> {
  const rows = await sql<{ value: { models?: unknown; updatedAt?: unknown; updatedBy?: unknown } | null }[]>`
    SELECT value FROM settings WHERE key = ${OPENCODE_POOL_KEY}`;
  const v = rows[0]?.value ?? null;
  const models = Array.isArray(v?.models) ? (v!.models as unknown[]).filter((m): m is string => typeof m === "string") : [];
  if (models.length === 0) {
    return { models: [], defaulted: true, updatedAt: null, updatedBy: null };
  }
  return {
    models,
    defaulted: false,
    updatedAt: typeof v?.updatedAt === "string" ? v.updatedAt : null,
    updatedBy: typeof v?.updatedBy === "string" ? v.updatedBy : null,
  };
}

/** 路由快照用：池清单（无则空——opencode 预设无证书且池空时报「无可跑模型」，同 OpenRouter 口径）。 */
export async function opencodePoolModels(): Promise<string[]> {
  return (await getOpencodePool()).models;
}

async function saveOpencodePool(state: OpencodePoolState, actor: string): Promise<void> {
  const value = { models: state.models, updatedAt: new Date().toISOString(), updatedBy: actor };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${OPENCODE_POOL_KEY}, ${sql.json(value as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** 自动接入（幂等）：行不存在才插入；'filtered'%（连续失败人工/机器退休）不复活，
 *  'ended'（目录消失）复活为 observing（机器结论可逆——目录再现即回来）。池去重并入。 */
export async function onboardOpencodeModel(input: {
  model: string; name: string; contextTokens: number | null; sourceUrl: string; note: string;
  /** 目录来源：serve=宿主客户端；direct=opencode.ai 公共免费网关（无需凭据）。 */
  transport?: "serve" | "direct";
}): Promise<{ modelId: string; created: boolean; revived: boolean; retired: boolean }> {
  const modelId = opencodeModelIdOf(input.model);
  const existing = await sql<{ status: string }[]>`SELECT status FROM model_watch_models WHERE model_id = ${modelId}`;
  if (existing[0] && existing[0]!.status === "filtered") {
    return { modelId, created: false, revived: false, retired: true };
  }
  let created = false;
  let revived = false;
  if (existing[0] && existing[0]!.status === "ended") {
    const up = await sql<{ model_id: string }[]>`
      UPDATE model_watch_models SET status = 'observing', updated_at = now()
      WHERE model_id = ${modelId} AND status = 'ended' RETURNING model_id`;
    revived = up.length > 0;
  } else if (!existing[0]) {
    const inserted = await sql<{ model_id: string }[]>`
      INSERT INTO model_watch_models
        (model_id, name, vendor, tier, context_length, supports_vision, supports_json,
         free_from, last_prompt_price, last_completion_price, status, verdict_note, provider_facts)
      VALUES
        (${modelId}, ${input.name}, 'opencode', 'free_tier', ${input.contextTokens}, false, true,
         now(), '0', '0', 'observing', ${input.note},
         ${sql.json({ channel: "opencode", transport: input.transport ?? "serve", baseUrlEnv: (input.transport ?? "serve") === "direct" ? null : "OPENCODE_SERVE_URL", autoOnboard: true, sourceUrl: input.sourceUrl } as never)})
      ON CONFLICT (model_id) DO NOTHING RETURNING model_id`;
    created = inserted.length > 0;
  }
  if (created || revived) {
    await addEvent("opencode_onboard", modelId, { name: input.name, contextLength: input.contextTokens, sourceUrl: input.sourceUrl, note: input.note, revived });
  }
  const pool = await getOpencodePool();
  const key = input.model.trim().toLowerCase();
  if (!pool.models.includes(key)) {
    await saveOpencodePool({ ...pool, models: [...pool.models, key] }, "system: opencode-watch");
  }
  return { modelId, created, revived, retired: false };
}

export async function removeFromOpencodePool(model: string, actor: string): Promise<void> {
  const key = model.trim().toLowerCase();
  const pool = await getOpencodePool();
  if (!pool.models.includes(key)) return;
  await saveOpencodePool({ ...pool, models: pool.models.filter((m) => m !== key) }, actor);
}

/** 目录同步用：模型从客户端目录消失 → status=ended + 事件（行保留可回；'filtered' 不降级）。 */
export async function markOpencodeModelEnded(model: string, note: string): Promise<boolean> {
  const modelId = opencodeModelIdOf(model);
  const updated = await sql<{ model_id: string }[]>`
    UPDATE model_watch_models SET status = 'ended', verdict_note = ${note}, updated_at = now()
    WHERE model_id = ${modelId} AND status NOT IN ('ended', 'filtered') RETURNING model_id`;
  if (updated.length === 0) return false;
  await addEvent("opencode_gone", modelId, { note });
  await removeFromOpencodePool(model, "system: opencode-watch");
  return true;
}

// ---- 连续失败摘池（智谱同款） ----

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

/** 纯函数（判别测试用）：按本轮结果推进连续失败计数（与 zhipu 同形——独立一份，
 *  两池各自记各自的前缀，互不牵连）。 */
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

/** 验收轮收尾调用（capability-test 仅传 opencode: 成员的结果）：推进失败计数，达阈值即自动
 *  摘池（status=filtered + 池移除 + 事件 opencode_auto_retire 留痕），计数状态存 settings。 */
export async function recordOpencodeRoundOutcomes(rounds: RoundOutcome[], now = new Date()): Promise<{ retired: string[] }> {
  const oc = rounds.filter((r) => r.modelId.startsWith("opencode:") && r.calls > 0);
  if (oc.length === 0) return { retired: [] };
  const rows = await sql<{ value: Record<string, FailStreak> | null }[]>`SELECT value FROM settings WHERE key = ${OPENCODE_FAILSTREAK_KEY}`;
  const result = nextFailStreak(rows[0]?.value ?? {}, oc, now.toISOString());
  const retired: string[] = [];
  for (const { modelId, streak } of result.retired) {
    const note = `ym467 自动摘池：连续 ${streak.count} 轮验收全部调用失败（最近：${streak.lastError ?? "无错误文本"}）`;
    const updated = await sql<{ model_id: string }[]>`
      UPDATE model_watch_models SET status = 'filtered', verdict_note = ${note}, updated_at = now()
      WHERE model_id = ${modelId} AND status NOT IN ('filtered', 'ended') RETURNING model_id`;
    if (updated.length === 0) continue; // 已人工处理过：尊重既有状态，只清计数
    await addEvent("opencode_auto_retire", modelId, { streak: streak.count, lastError: streak.lastError, note });
    await removeFromOpencodePool(modelId.replace(/^opencode:/, ""), "system: opencode-watch");
    retired.push(modelId);
  }
  const value = result.state;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${OPENCODE_FAILSTREAK_KEY}, ${sql.json(value as never)}, 'system: opencode-watch')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return { retired };
}
