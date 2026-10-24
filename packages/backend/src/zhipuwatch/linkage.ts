// 信号→路由动作执行器（ym438 S01-S03）：把扫描出刊/存量回填的 zhipu_updates 行按 signals.classify
// 分类并执行——
//   free_pool_candidate → 免费池接入（pool.onboardZhipuModel；不合口径只留痕 pool_skipped，不动作）
//   window_rule        → 套餐窗规则写 settings zhipu.plan_window（解析歧义拒写候人工；manual 不覆写）
//   model_release      → 仅记录（freeHint 供观察）
// 留痕：行 routing_action jsonb，条件写回（routing_action IS NULL 才写）保证同窗重扫/并发回填零
// 重复动作；动作本身幂等（接入 ON CONFLICT DO NOTHING、窗口规则等值不重写）。单行动作失败只落
// routing_action=error 不打断扫描（DB 层故障照旧向上抛，由 job_runs 兜底）。
import { classifyItem } from "./signals.ts";
import { onboardZhipuModel } from "./pool.ts";
import { getPlanWindowRule, planWindowRuleActive, savePlanWindowRule } from "../lib/windows.ts";
import { saveRoutingActionIfMissing, type ZhipuUpdateRow } from "./store.ts";

export interface ActionContext {
  now: Date;
  /** 运行观察（进 summary.notes / zhipuwatch.lastrun，后台页可见）。 */
  note: (text: string) => void;
}

/** 单行信号→动作（返回值即写回 routing_action 的 jsonb）。 */
export async function runRoutingAction(row: ZhipuUpdateRow, ctx: ActionContext): Promise<Record<string, unknown>> {
  const at = ctx.now.toISOString();
  const signal = classifyItem({
    kind: row.kind, url: row.url, title: row.title, text: String(row.payload?.text ?? ""),
  });
  switch (signal.kind) {
    case "free_pool_candidate": {
      const base = { at, model: signal.model, context: signal.context };
      if (!signal.eligible) return { action: "pool_skipped", ...base, reason: signal.reason };
      const res = await onboardZhipuModel({
        model: signal.model, name: signal.model, contextTokens: signal.contextTokens, sourceUrl: row.url,
        note: `ym438 自动接入：定价页免费行（上下文 ${signal.context ?? "未知"}，来源 ${row.url}）`,
      });
      if (res.retired) return { action: "pool_skipped", ...base, reason: "模型已摘池/已结束（filtered/ended），不回池" };
      ctx.note(`免费模型在池：${signal.model}${res.created ? "（新接入验收队列）" : "（已在队列）"}`);
      return { action: "pool_onboarded", ...base, modelId: res.modelId, created: res.created };
    }
    case "window_rule": {
      const parse = signal.parse;
      if (parse.status === "not-window") return { action: "noted", at, reason: "非窗口公告（无窗口关键词与日期区间）" };
      if (parse.status === "refused") {
        ctx.note(`窗口公告解析歧义，未自动写（候人工）：${parse.reason}`);
        return { action: "window_refused", at, reason: parse.reason };
      }
      const window = parse.window;
      const current = await getPlanWindowRule();
      if (current?.mode === "manual") {
        return { action: "window_manual", at, window, reason: "settings 为人工维护（mode=manual），自动解析不覆写" };
      }
      const same = !!current && current.from === window.from && current.to === window.to &&
        current.daily?.start === window.daily.start && current.daily?.end === window.daily.end;
      if (!same) {
        await savePlanWindowRule({
          mode: "auto", from: window.from, to: window.to, daily: window.daily,
          note: `《${row.title}》自动解析（${row.url}）`, updatedAt: at,
        });
      }
      const active = planWindowRuleActive({ mode: "auto", from: window.from, to: window.to, daily: window.daily, updatedAt: at }, ctx.now.getTime());
      ctx.note(`免费窗口规则${same ? "保持" : "已更新"}：${window.from} ~ ${window.to} 每日 ${window.daily.start}-${window.daily.end} → ${active ? "窗口在挂" : "窗口已停（摘窗）"}`);
      return { action: same ? "window_unchanged" : "window_written", at, from: window.from, to: window.to, daily: window.daily, active };
    }
    case "model_release":
      return { action: "noted", at, freeHint: signal.freeHint };
    default:
      return { action: "noted", at };
  }
}

/** 批量执行（新出刊行 + 存量回填行，按 id 去重）；返回本轮写入的动作数。 */
export async function applySignalActions(rows: ZhipuUpdateRow[], ctx: ActionContext): Promise<number> {
  const seen = new Set<number>();
  let applied = 0;
  for (const row of rows) {
    if (row.routing_action || seen.has(row.id)) continue;
    seen.add(row.id);
    let action: Record<string, unknown>;
    try {
      action = await runRoutingAction(row, ctx);
    } catch (error) {
      action = { action: "error", at: ctx.now.toISOString(), reason: String(error).slice(0, 300) };
    }
    if (await saveRoutingActionIfMissing(row.id, action)) applied++;
  }
  return applied;
}
