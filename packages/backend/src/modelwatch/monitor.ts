// 免费模型监控主循环（24h 一轮，worker 的 model-watch.scan 调度；后台页面可手动触发）：
//   拉列表 → 差分（新免费/重新免费/持续刷新/到期） → 探针 → 24h 观察窗自动判定 →
//   主力/简单档/替补选任 → 写 settings.modelwatch.routing（60s 缓存 + 失效广播给 modelFor
//   与 openrouter-free 预设）。策略口径（命主 2026-10-02；上下文闸 2026-10-13 重核定）：
//   - 上下文闸放开（命主 2026-10-13 重核定，废止「≥1M 启用线」）：不足 1M 的免费模型同样进观察窗
//     与能力实测，去留以实测质量定（原口径：只启用上下文 ≥1M 的，不达标仅陈列报「筛选未达标」）；
//   - 优惠期内的免费模型优先支撑本站运行（未显式指派的能力位自动切过去，显式后台/环境指派不动）；
//   - 新模型先进 24h 观察窗，探针不过关只进简单能力位（预筛/摘要/结构抽取）；
//   - 切换主力时，上一任仍免费的模型留作替补（调用失败自动换替补重试）；
//   - 免费窗口以价格翻正为准结束，全站自动回落常规路由。
import { listOpenRouterModels, probeOpenRouterModel, verdictOfProbe, CatalogEmptyError, type OrModel, type ProbeResult } from "./openrouter.ts";
import { invalidateFreeRouting, OPENROUTER_FREE_KEY, type RoutingState } from "./routing.ts";
import { invalidateModelCache } from "../editorial/models.ts";
import {
  addEvent, applyVerdict, bumpCertVersion, getRoutingState, getWatchConfig, insertFreeModel, listWatchModels,
  markEnded, refreshFreeModel, reopenFreeModel, saveEvalSample, saveLastRun, saveProbe, saveRoutingState, type WatchRow,
} from "./store.ts";
import { saveCapabilityRoute } from "./capability-routing.ts";
import { evalSpecsFor, type EvalSpec } from "../editorial/analyze.ts";

export const OBSERVE_WINDOW_MS = 24 * 3600_000;
/** 启用门槛：上下文闸已放开（命主 2026-10-13 重核定，废止 2026-10-02 的「上下文 ≥1M 启用线」）——
 *  不足 1M 的免费模型同样进观察窗与能力实测，去留以实测质量定；常量保留为 0 = 不作拦截
 *  （沿革：原值 1_000_000，不达标者落 filtered 仅陈列）。 */
export const MIN_FREE_CONTEXT_TOKENS = 0;
/** 每轮探针上限（在役漂移复查优先，再补观察窗里最早到点的）。 */
const PROBE_CAP = 4;

/** promo 即具启用资格；上下文门槛常量现为 0（2026-10-13 闸放开），比较保留作门槛挂点。 */
export function eligibleForUse(m: OrModel): boolean {
  return m.tier === "promo" && m.contextLength >= MIN_FREE_CONTEXT_TOKENS;
}

/** 非 OpenRouter 通道前缀（ym436 智谱 / ym473 opencode）：其成员不在 OpenRouter 目录，
 *  免费与否/连通性由各自通道盯守轴管理（zhipu-watch / opencodewatch），因此不进
 *  OpenRouter 面三处：目录差分（不随 OpenRouter 差分判 ended）、observing 探针面、
 *  legacy 主力/替补/简单槽位。 */
export function isForeignChannelModel(modelId: string): boolean {
  return modelId.startsWith("zhipu:") || modelId.startsWith("opencode:");
}

export interface ScanSummary {
  at: string;
  ok: boolean;
  error: string | null;
  free: number;
  added: number;
  ended: number;
  verdicts: number;
  probed: number;
  routing: { primary: string | null; fallback: string | null; simple: string | null; changed: boolean };
}

export interface ScanOptions {
  /** 注入拉取（测试/演练）。 */
  fetchModels?: () => Promise<OrModel[]>;
  /** 注入探针（测试）。 */
  probeModel?: (model: string, fetcher?: typeof fetch) => Promise<ProbeResult>;
  /** 手动「立即扫描」不跑探针（快），判定只消费已有探针数据。 */
  probe?: boolean;
  now?: Date;
}

/** 排序：新窗口优先（免费期大概率还长），同窗上下文大者优先，最后按 id 稳定。 */
export function rankFreeCandidates<T extends { model_id: string; tier: string; free_from: Date | string | null; context_length: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const tier = (x: T) => (x.tier === "promo" ? 0 : 1);
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    const fa = a.free_from ? Date.parse(String(a.free_from)) : 0;
    const fb = b.free_from ? Date.parse(String(b.free_from)) : 0;
    if (fa !== fb) return fb - fa;
    if ((b.context_length ?? 0) !== (a.context_length ?? 0)) return (b.context_length ?? 0) - (a.context_length ?? 0);
    return a.model_id < b.model_id ? -1 : 1;
  });
}

/** 主力/简单/替补选任（纯函数，便于测试）：autoSwitch 关着就维持现状。 */
export function pickRouting(
  rowsIn: WatchRow[],
  config: { autoSwitch: boolean; pinned: string | null },
  current: RoutingState | null,
): { primary: WatchRow | null; fallback: WatchRow | null; simple: WatchRow | null; changed: boolean } {
  // ym436：legacy 主力/替补/简单档是 OpenRouter 专属槽位——智谱成员（zhipu: 前缀）只走证书
  // 路由不进这里，防止 zhipu 模型 id 被 openrouter-free 预设发到 OpenRouter 端点。
  // ym473：opencode 成员同款（外通道成员统一不进 OpenRouter 槽位面）。
  const rows = rowsIn.filter((r) => !isForeignChannelModel(r.model_id));
  if (!config.autoSwitch) {
    const byId = new Map(rows.map((r) => [r.model_id, r]));
    return {
      primary: current?.primary ? byId.get(current.primary) ?? null : null,
      fallback: current?.fallback ? byId.get(current.fallback) ?? null : null,
      simple: current?.simple ? byId.get(current.simple) ?? null : null,
      changed: false,
    };
  }
  const free = rows.filter((r) => r.status !== "ended");
  // 主力：钉选优先（钉选视同人工放行，免观察窗；仅排除已结束/已判不可用）；其余从 vetted 里选。
  const pinnedRow = config.pinned ? free.find((r) => r.model_id === config.pinned && r.status !== "unusable") ?? null : null;
  const primary = pinnedRow ?? rankFreeCandidates(free.filter((r) => r.status === "vetted"))[0] ?? null;
  // 简单档：只在无主力时才被路由使用，但仍要选出来备着。
  const simple = rankFreeCandidates(free.filter((r) => r.status === "simple" && r.model_id !== primary?.model_id))[0] ?? null;
  // 替补：上一任主力（仍免费且非现任）优先，否则从其余 vetted 里补一个。
  const prev = current?.primary ? free.find((r) => r.model_id === current.primary && r.status !== "unusable") ?? null : null;
  const fallback =
    primary && prev && prev.model_id !== primary.model_id
      ? prev
      : rankFreeCandidates(free.filter((r) => r.status === "vetted" && r.model_id !== primary?.model_id))[0] ?? null;
  const changed = (primary?.model_id ?? null) !== (current?.primary ?? null) ||
    (fallback?.model_id ?? null) !== (current?.fallback ?? null) ||
    (simple?.model_id ?? null) !== (current?.simple ?? null);
  return { primary, fallback, simple, changed };
}

async function persistRouting(picked: { primary: WatchRow | null; fallback: WatchRow | null; simple: WatchRow | null }, changed: boolean): Promise<void> {
  await saveRoutingState({
    primary: picked.primary?.model_id ?? null,
    fallback: picked.fallback?.model_id ?? null,
    simple: picked.simple?.model_id ?? null,
    primaryVision: !!picked.primary?.supports_vision,
    simpleVision: !!picked.simple?.supports_vision,
    updatedAt: new Date().toISOString(),
  });
  if (changed) {
    await addEvent("routing", picked.primary?.model_id ?? "", {
      primary: picked.primary?.model_id ?? null,
      fallback: picked.fallback?.model_id ?? null,
      simple: picked.simple?.model_id ?? null,
    });
  }
  invalidateFreeRouting();
  invalidateModelCache();
}

/** 重算并落 routing（扫描收尾、人工判定、改配置后共用）。 */
export async function reapplyPolicy(): Promise<{ primary: string | null; fallback: string | null; simple: string | null; changed: boolean }> {
  const [rows, config, current] = await Promise.all([listWatchModels(), getWatchConfig(), getRoutingState()]);
  const picked = pickRouting(rows, config, current);
  await persistRouting(picked, picked.changed);
  return { primary: picked.primary?.model_id ?? null, fallback: picked.fallback?.model_id ?? null, simple: picked.simple?.model_id ?? null, changed: picked.changed };
}

interface ProbeLike extends ProbeResult {
  failStreak?: number;
}

/** 探针 + 漂移降级 + 观察窗自动判定（同一趟，扫描内调用）。 */
async function probeAndVerdict(rows: WatchRow[], opts: ScanOptions, now: Date): Promise<{ probed: number; verdicts: number }> {
  const routing = await getRoutingState();
  // 在役主力/简单档先探（漂移复查），再补观察窗里最早到点的；同一模型只探一次。
  const driftTargets = rows.filter((r) => (r.status === "vetted" || r.status === "simple") && (r.model_id === routing?.primary || r.model_id === routing?.simple));
  // ym436：observing 探针走 OpenRouter 端点——智谱成员不经此面（其连通性由通道端点实弹与
  // 能力验收管线负责）。ym473：opencode 成员同款（连通性归客户端中介链实弹与验收管线；
  // 且其 observe_until 为空，若进本面会恒占探针名额、饿死 OpenRouter 观察窗判定）。
  const observing = rows.filter((r) => r.status === "observing" && !isForeignChannelModel(r.model_id)).sort((a, b) => Number(a.observe_until ?? 0) - Number(b.observe_until ?? 0));
  const targets = [...new Map([...driftTargets, ...observing].map((r) => [r.model_id, r])).values()].slice(0, PROBE_CAP);
  let verdicts = 0;
  for (const row of targets) {
    const probe = await (opts.probeModel ?? probeOpenRouterModel)(row.model_id);
    const prevStreak = ((row.probe as ProbeLike | null)?.failStreak ?? 0);
    const bothFailed = !probe.json.ok && !probe.summary.ok;
    await saveProbe(row.model_id, probe, bothFailed ? prevStreak + 1 : 0);
    await addEvent("probe", row.model_id, { jsonOk: probe.json.ok, summaryOk: probe.summary.ok, ms: probe.json.ms + probe.summary.ms });
    // 漂移降级：在役模型连续两轮探针全挂 → 主力降简单档；简单档降不可用。
    if (bothFailed && prevStreak + 1 >= 2) {
      if (row.status === "vetted") {
        await applyVerdict(row.model_id, "simple", "auto-drift", "连续两轮探针两项全挂，降为简单档", false);
        await addEvent("drift", row.model_id, { from: "vetted", to: "simple" });
        verdicts++;
      } else if (row.status === "simple") {
        await applyVerdict(row.model_id, "unusable", "auto-drift", "连续两轮探针两项全挂，标记不可用", false);
        await addEvent("drift", row.model_id, { from: "simple", to: "unusable" });
        verdicts++;
      }
    }
  }
  const appended = await autoVerdictDue(now);
  return { probed: targets.length, verdicts: verdicts + appended };
}

/** 观察窗到点自动判定（需要至少一轮探针数据；没探到的等下一轮）。返回判定条数。
 *  ym249 口径注记：观察窗判定只落 watch status（vetted/simple/unusable=连通质量结论），
 *  不写 model_free_capabilities——24h 时间到点不自动认证任何能力位；能力认证唯一入口是
 *  certifyCapability 的逐能力真实 schema 测试（不合格 park，不拖框架）。 */
async function autoVerdictDue(now: Date): Promise<number> {
  const fresh = await listWatchModels();
  const due = fresh.flatMap((r) => (r.status === "observing" && !r.verdict && r.observe_until && r.observe_until <= now && r.probe ? [{ row: r, probe: r.probe }] : []));
  let verdicts = 0;
  for (const { row, probe } of due) {
    const verdict = verdictOfProbe(probe);
    await applyVerdict(row.model_id, verdict, "auto-probe", `探针判定：json ${probe.json.ok ? "过" : "挂"} / 摘要 ${probe.summary.ok ? "过" : "挂"}`, false);
    await addEvent("verdict", row.model_id, { verdict, by: "auto-probe" });
    verdicts++;
  }
  return verdicts;
}

// ---- ym249：逐能力真实 schema 认证（per-capability certification）----
// 命主拍板（d-ym238-free-routing-policy option A，seq 19972）：逐能力认证通过后放开对应
// 能力位。每能力单独认证/单独 park：通用双探针过关不算认证（AC4），真实 schema（analyze.ts
// 同一 const）通过率 ≥90% 才 qualified；不合格只 park 该 model×capability，不拖其他能力、
// 不拖框架交付。调用走 chatJson 免费预设+钉选，天然过预算/回执/operationKey 闸。

export interface CertifyResult {
  capability: string;
  verdict: "qualified" | "rejected";
  passCount: number;
  total: number;
  variants: Array<{ variant: string; pass: number; total: number }>;
}

export interface CertifyOptions {
  modelId: string;
  capability: string;
  /** 每 variant 的调用次数（ym196 口径 10 次；判卷线 pass/total ≥ 0.9）。 */
  samples?: number;
  /** 注入替代真实调用（测试）：返回 ok=样本过 schema 与否。 */
  call?: (spec: EvalSpec, attempt: number) => Promise<{ ok: boolean; error?: string }>;
  /** 人工触发时的执行者标记（audit 用）。 */
  actor?: string;
}

/** 认证一个模型的一个能力位：真实 prompt+schema 跑 N 次 → 证据 append-only → 结论行。 */
export async function certifyCapability(opts: CertifyOptions): Promise<CertifyResult> {
  const specs = evalSpecsFor(opts.capability);
  if (specs.length === 0) throw new Error(`capability "${opts.capability}" has no eval spec (not certified in this framework yet)`);
  const samples = opts.samples ?? 10;
  const variants: CertifyResult["variants"] = [];
  let passCount = 0;
  let total = 0;
  for (const spec of specs) {
    let pass = 0;
    for (let attempt = 1; attempt <= samples; attempt++) {
      let ok: boolean;
      let error: string | undefined;
      if (opts.call) {
        const r = await opts.call(spec, attempt);
        ok = r.ok;
        error = r.error;
      } else {
        ok = false;
        try {
          const { chatJson } = await import("../providers/llm.ts");
          // ym436 销项 P2-3（shoumen）：zhipu: 前缀成员走智谱预设（与 capability-test 同款
          // 分流），否则会被发到 OpenRouter 端点被拒，证书却记在智谱模型名下（伪证）。
          // ym467：opencode: 前缀成员同款分流（走 opencode 免费预设，经客户端中介出文）。
          const { ZHIPU_FREE_KEY } = await import("../providers/zhipu.ts");
          const { OPENCODE_FREE_KEY } = await import("../providers/opencode.ts");
          await chatJson({
            model: opts.modelId.startsWith("zhipu:") ? ZHIPU_FREE_KEY : opts.modelId.startsWith("opencode:") ? OPENCODE_FREE_KEY : OPENROUTER_FREE_KEY,
            pinnedModel: opts.modelId,
            pinnedStrict: true, // ym573：认证出证只认被钉模型自答——目标挂即样本判负，不回代答
            purpose: `modelwatch.certify.${opts.capability}`,
            subject: `certify:${opts.modelId}:${opts.capability}:${spec.variant}`,
            promptVersion: `certify-${opts.capability}-v1`,
            system: spec.system,
            user: spec.user,
            schema: spec.schema,
            parse: spec.parse,
            json: spec.json,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            timeoutMs: 120_000,
            attemptTag: `certify-${attempt}`,
          });
          ok = true;
        } catch (error_) {
          ok = false;
          error = String(error_).slice(0, 200);
        }
      }
      if (ok) pass++;
      total++;
    }
    variants.push({ variant: spec.variant, pass, total: samples });
    passCount += pass;
    await saveEvalSample({
      modelId: opts.modelId,
      capability: opts.capability,
      datasetVersion: `builtin-v1/${spec.variant}`,
      promptVersion: `certify-${opts.capability}-v1`,
      policyVersion: "",
      verdict: pass >= samples * 0.9 ? "pass" : "fail",
      passCount: pass,
      payload: { variant: spec.variant, total: samples, ...(pass < samples * 0.9 ? { note: "park: 真实 schema 通过率不足 90%" } : {}) },
      receiptId: null,
    });
  }
  const verdict: "qualified" | "rejected" = passCount >= Math.ceil(total * 0.9) ? "qualified" : "rejected";
  await saveCapabilityRoute({
    modelId: opts.modelId,
    capability: opts.capability,
    verdict,
    passCount,
    payload: { variants, basis: "real-schema", line: "pass/total >= 0.9", ...(verdict === "rejected" ? { parkReason: "真实 schema 通过率不足 90%，该能力位 park" } : {}) },
    receiptId: null,
  });
  await bumpCertVersion(opts.modelId, `certify:${opts.capability}:${verdict}`);
  invalidateFreeRouting();
  await addEvent("certify", opts.modelId, { capability: opts.capability, verdict, passCount, total, variants });
  return { capability: opts.capability, verdict, passCount, total, variants };
}

/** 单轮扫描。失败只记 scan_error 事件与 lastrun，异常向上抛由 job_runs 兜底。 */
export async function scanModelWatch(opts: ScanOptions = {}): Promise<ScanSummary> {
  const now = opts.now ?? new Date();
  const startedAt = new Date().toISOString();
  const summary: ScanSummary = { at: startedAt, ok: false, error: null, free: 0, added: 0, ended: 0, verdicts: 0, probed: 0, routing: { primary: null, fallback: null, simple: null, changed: false } };
  try {
    const models = await (opts.fetchModels ?? listOpenRouterModels)();
    summary.free = models.length;
    const existing = await listWatchModels();
    // ym249：坏/空目录是「目录可疑」不是「全部免费结束」。无论目录端点抛 CatalogEmptyError
    // 还是拉回空列表，只要库里有未 ended 的免费模型就绝不进入差分循环（一个都不 markEnded，
    // AC1 stale 闸），本轮按失败收口留痕，等下一轮目录恢复。真·全部结束=目录非空但不再含它们。
    if (models.length === 0 && existing.some((r) => r.status !== "ended")) {
      const reason = "目录返回空且库内有在途免费模型：疑似坏/空目录，跳过本轮差分（不集体判 ended）";
      await addEvent("catalog_suspicious", "", { reason, watching: existing.filter((r) => r.status !== "ended").length });
      summary.error = reason;
      await saveLastRun({ at: startedAt, ok: false, error: reason, free: 0, added: 0, ended: 0 });
      return summary;
    }
    const byId = new Map(existing.map((r) => [r.model_id, r]));
    const baseline = existing.length === 0 && models.length > 0;
    const observeUntil = new Date(now.getTime() + OBSERVE_WINDOW_MS);
    for (const m of models) {
      const row = byId.get(m.id);
      const eligible = eligibleForUse(m);
      if (!row) {
        await insertFreeModel(m, observeUntil, eligible);
        await addEvent("free_start", m.id, { tier: m.tier, name: m.name, context: m.contextLength, freeUntilHint: m.freeUntilHint, eligible });
        summary.added++;
      } else if (row.status === "ended") {
        await reopenFreeModel(m, observeUntil, eligible);
        await addEvent("free_start", m.id, { tier: m.tier, name: m.name, reopened: true, eligible });
        summary.added++;
      } else {
        // ym249：CAS 刷新（version 乐观锁）；并发扫描同行时 0 行命中即跳过本轮，不覆盖版本链。
        await refreshFreeModel(m, row.version);
      }
    }
    const freeIds = new Set(models.map((m) => m.id));
    for (const row of existing) {
      // ym436：智谱免费成员不在 OpenRouter 目录里——其免费与否由智谱价格页/发布记录盯
      // （ym438 联动卡），不随 OpenRouter 目录差分判 ended。
      // ym473：opencode 成员同款（第三路客户端中介通道，目录由 opencodewatch 盯守轴管理，
      // 见 opencodewatch/scan.ts）——此前仅豁免 zhipu:，致每日 22:30 扫描全量误标 ended。
      if (!isForeignChannelModel(row.model_id) && !freeIds.has(row.model_id) && row.status !== "ended") {
        await markEnded(row.model_id);
        await addEvent("free_end", row.model_id, { name: row.name, lastStatus: row.status });
        summary.ended++;
      }
    }
    if (baseline) await addEvent("baseline", "", { free: models.length, promo: models.filter((m) => m.tier === "promo").length, freeTier: models.filter((m) => m.tier === "free_tier").length });
    if (opts.probe !== false) {
      const fresh = await listWatchModels();
      const pv = await probeAndVerdict(fresh, opts, now);
      summary.probed = pv.probed;
      summary.verdicts = pv.verdicts;
    } else {
      // 手动扫描不跑探针（快），到点判定仍消费已有探针数据。
      summary.verdicts = await autoVerdictDue(now);
    }
    const routing = await reapplyPolicy();
    summary.routing = routing;
    summary.ok = true;
    await saveLastRun({ at: startedAt, ok: true, error: null, free: summary.free, added: summary.added, ended: summary.ended });
    return summary;
  } catch (error) {
    // ym249：坏/空目录是「目录可疑」不是「全部免费结束」——到不了差分循环就不会 markEnded，
    // 这里单列事件留痕（AC1 stale 闸），本轮按失败收口，等下一轮目录恢复。
    if (error instanceof CatalogEmptyError) {
      await addEvent("catalog_suspicious", "", { error: String(error).slice(0, 300) });
      summary.error = String(error).slice(0, 300);
      await saveLastRun({ at: startedAt, ok: false, error: summary.error, free: summary.free, added: 0, ended: 0 });
      return summary;
    }
    summary.error = String(error).slice(0, 300);
    await addEvent("scan_error", "", { error: summary.error });
    await saveLastRun({ at: startedAt, ok: false, error: summary.error, free: summary.free, added: summary.added, ended: summary.ended });
    throw error;
  }
}
