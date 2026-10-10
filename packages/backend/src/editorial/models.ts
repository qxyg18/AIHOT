// Model per capability: the code default (`default`, the deployment's own model), an environment
// override, and an admin switch kept in settings (every switch is audited). Read at call time and
// cached for a minute, so a switch applies to the next call without a restart; a changed model only
// affects work done from then on (history is not re-judged).
import { sql } from "../db.ts";
import { MODELS } from "../providers/llm.ts";
import { mimoCircuitRemainingMs, mimoUsable } from "../providers/mimo.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import { ZHIPU_FREE_KEY } from "../providers/zhipu.ts";
import { OPENCODE_FREE_KEY } from "../providers/opencode.ts";
import { mimoEarlyLive, mimoShiftActive, offpeakPlanLive } from "../lib/windows.ts";
import { ensureFreeRouting, OPENROUTER_FREE_KEY } from "../modelwatch/routing.ts";
import { registerPurposeMap, resolveFreeModel } from "../modelwatch/capability-routing.ts";
import { apiRouteChain, PROVIDER_MODELS, registerRouterOverrideProbe } from "../providers/api-router.ts";

/** ym467：免费路由命中成员按通道选预设（zhipu/opencode 各自独立预设，缺省 openrouter——
 *  智谱优先口径由合流序保证，不由本函数）。 */
function freePresetByChannel(channel: string | undefined): string {
  return channel === "zhipu" ? ZHIPU_FREE_KEY : channel === "opencode" ? OPENCODE_FREE_KEY : OPENROUTER_FREE_KEY;
}
const FREE_PREFIX_RE = /^(zhipu|opencode):/;

/** ka3: inside the MIMO daytime shift (9:00-22:59 Beijing, plan live) an unoverridden capability
 *  runs on the pay-as-you-go MIMO preset instead of the plan model; explicit admin/env choices
 *  always win and off-peak hours keep the discounted Zhipu plan. */
export const MIMO_SHIFT_MODEL = "mimo-v2.6-flash";

/** 免费模型观察窗里「质量过差」模型的用武之地：结构简单、出错可兜底的轻能力位
 *  （预筛宽召回 / 短摘要 / 结构抽取），命主口径 2026-10-02。 */
export const SIMPLE_CAPABILITIES: CapabilityKey[] = ["prefilter", "summarize", "structure"];

export function routeToMimo(input: { overridden: boolean; planLive: boolean; shift: boolean; usable: boolean }): boolean {
  return !input.overridden && input.planLive && input.shift && input.usable;
}

/** ym434（承 ym431 审计 P1-1）：白天窗禁回落等待信号。
 *  白天窗内能力位无免费证书命中且 MIMO 路由不可用（熔断/未配置）时，modelFor 抛本信号而非
 *  回落 default（智谱套餐）——调用方按既有退避重试（retryAfterSeconds 为建议间隔），等熔断窗
 *  过/凭据恢复/跨窗自愈后自然成功。继承 ProviderRejectedError（retryable=true）以复用各调用
 *  面既有的「可重试拒绝」语义（重试/等待，不判 failed）。 */
export class ShiftWaitError extends ProviderRejectedError {
  /** 建议重试间隔（秒）：熔断剩余时间（60..1800 夹取）；未配置或其他=1800。 */
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message, null, true);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface Capability {
  label: string;
  env: string;
  default: string;
  /** Receipt purposes this capability produces (for the admin statistics). */
  purposes: string[];
  vision?: boolean;
}

export const CAPABILITIES = {
  prefilter: { label: "精选预筛（是否属于这个行业，宽召回）", env: "PREFILTER_MODEL", default: "default", purposes: ["prefilter_article"] },
  score: { label: "精选评分（两次独立评分，按信源分级门槛）", env: "SCORE_MODEL", default: "default", purposes: ["score_article"] },
  understand: { label: "内容理解（入选和接近入选的标题、摘要、推荐理由、标签，能看图时看首图）", env: "UNDERSTAND_MODEL", default: "default", purposes: ["understand_article"] },
  summarize: { label: "标题摘要（其余文章的中文标题与摘要）", env: "SUMMARIZE_MODEL", default: "default", purposes: ["summarize_article"] },
  structure: { label: "结构抽取（分类、标签、主体公司、事件事实，不写读者文字）", env: "STRUCTURE_MODEL", default: "default", purposes: ["structure_article"] },
  group: { label: "事件归组（新报道与候选事实的关系：同一次发生、同一事件的进展、无关；被同一篇报道连起来的两个事件是否同一事件）", env: "GROUP_MODEL", default: "default", purposes: ["group_article", "group_signal", "group_story"] },
  groupReview: { label: "归组复核（相似度不高的合并、两个事件的合并，写入前再读一遍；最好换一家模型）", env: "GROUP_REVIEW_MODEL", default: "default", purposes: ["group_review", "group_story_review"] },
  digest: { label: "事件综述", env: "DIGEST_MODEL", default: "default", purposes: ["story_digest"] },
  report: { label: "日报、周报、月报", env: "REPORT_MODEL", default: "default", purposes: ["report_lead", "report_so_what", "report_daily", "report_weekly", "report_monthly"] },
  translate: { label: "精选全文翻译（含引用帖）", env: "TRANSLATE_MODEL", default: "default", purposes: ["translate_body", "translate_quoted"] },
  monitor: { label: "Codex 重置公告识别", env: "MONITOR_MODEL", default: "default", purposes: ["monitor.recognize", "monitor.context"] },
  brandProfile: { label: "品牌档案八问总结（百科材料→八问+50字简介）", env: "BRAND_PROFILE_MODEL", default: "default", purposes: ["brand_profile"] },
  insight: { label: "研报观点提取（研报正文→品牌/商业体/行业的研判观点+数字三件套）", env: "INSIGHT_MODEL", default: "default", purposes: ["report_insights"] },
  deepread: { label: "新闻深解读（站内历史+档案→不点原文也能懂的大白话）", env: "DEEPREAD_MODEL", default: "default", purposes: ["article_deep_read"] },
  ossDigest: { label: "开源项目更新解读（GitHub 更新→大白话+施工适配提示）", env: "OSS_DIGEST_MODEL", default: "default", purposes: ["oss_digest"] },
  ossDigestReview: { label: "开源解读复核（复核轮强模型审免费模型产出，教训回灌）", env: "OSS_DIGEST_REVIEW_MODEL", default: "default", purposes: ["oss_digest_review"] },
  zhipuDigest: { label: "智谱动态解读（智谱发布→大白话+对本站路由的影响提示）", env: "ZHIPU_DIGEST_MODEL", default: "default", purposes: ["zhipu_digest"] },
  zhipuDigestReview: { label: "智谱解读复核（复核轮强模型审免费模型产出）", env: "ZHIPU_DIGEST_REVIEW_MODEL", default: "default", purposes: ["zhipu_digest_review"] },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

/** 复核类能力位：核与被核同源=独立性破防，代码级排除免费路由（ym196 oss / ym437 智谱）。 */
export const FREE_EXCLUDED_CAPABILITIES: CapabilityKey[] = ["ossDigestReview", "zhipuDigestReview"];

// ym196：purpose→能力位映射注册进共享注册表（chatJson 免费候选链反查用；模块加载即注册）。
registerPurposeMap(CAPABILITIES);

let cache: { at: number; overrides: Record<string, string> } | null = null;

// ym350：显式指派探针——后台切换/环境变量的能力位不进路由转移（routeForPurpose 反查）。
// 环境变量即时可见；后台切换经 overrides 缓存可见（缓存未热+覆盖恰指路由预设键的理论
// 窄窗沿 ym350 审计 P3-4 遗留口径）。
registerRouterOverrideProbe((capability) => {
  const c = CAPABILITIES[capability as CapabilityKey];
  return !!c && (!!process.env[c.env] || !!cache?.overrides?.[capability]);
});

async function overrides(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.overrides;
  const rows = await sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const map: Record<string, string> = {};
  for (const r of rows) if (r.value?.model && MODELS[r.value.model]) map[r.key.slice("models.".length)] = r.value.model;
  cache = { at: Date.now(), overrides: map };
  return map;
}

export function invalidateModelCache() {
  cache = null;
}

/** The model a capability uses now: admin switch, else environment, else the code default. A live
 *  free OpenRouter model (owner directive 2026-10-02: the site runs on free models while a free
 *  window holds) takes the unoverridden capabilities before the MIMO daytime shift (ka3). */
export async function modelFor(capability: CapabilityKey): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const o = await overrides();
  const overridden = !!(o[capability] ?? process.env[c.env]);
  if (!overridden) {
    // ym350 统一接口路由：路由启用=链首接管（合并吸收免费证书桥+MIMO 白班窗两段旧逻辑，
    // 免费位让位/日上限耗尽时 MIMO 全天候顶上，取代白班窗语义）；路由关/链空=旧路径逐字节
    // 保留。复核类能力位走 excludeFree 链（绝不与被复核同源）。
    const routerChain = await apiRouteChain(capability, {
      vision: !!c.vision,
      excludeFree: FREE_EXCLUDED_CAPABILITIES.includes(capability),
    });
    if (routerChain.length > 0) return routerChain[0]!;
    // ym196 shoumen P2 销项：复核类能力位代码级排除免费路由——复核与被复核同源=独立性
    // 破防，即使显式指派被误删也只回落付费（default），绝不静默走免费桥。
    if (!FREE_EXCLUDED_CAPABILITIES.includes(capability)) {
      // ym249（命主拍板 d-ym238-free-routing-policy option A，seq 19972）：逐能力认证通过后
      // 放开对应能力位——只认 model_free_capabilities 的 per-capability 证书。观察窗探针双过
      // 不再经 legacy 主力/简单桥放行全能力位（legacy 桥收口，第三参传 null）；无证书的能力位
      // 照旧走既有付费选择（已批准付费业务授权不默默替换）。生产快照 primary/simple 本就全
      // null，收口零扰动。
      const routing = await ensureFreeRouting();
      const routes = routing.capabilityRoute[capability] ?? [];
      const hit = resolveFreeModel(routes, null, { vision: !!c.vision, simpleEligible: SIMPLE_CAPABILITIES.includes(capability) });
      // ym436：命中成员按通道选预设——合流序智谱在前（命主口径：智谱免费优先于 OpenRouter）；
      // ym467：opencode 通道成员同形各自选预设（opencode-free）。
      if (hit) return freePresetByChannel(routes.find((r) => r.model === hit.model)?.channel);
    }
  }
  const chosen = o[capability] ?? process.env[c.env] ?? c.default;
  // ym241: mimoUsable costs a settings read (the circuit probe); only pay for it when the shift
  // route is actually reachable — overridden capabilities and off-window calls short-circuit here.
  const planLive = offpeakPlanLive() || mimoEarlyLive();
  const shift = mimoShiftActive();
  const usable = overridden || !planLive || !shift ? false : await mimoUsable();
  if (routeToMimo({ overridden, planLive, shift, usable })) {
    return MIMO_SHIFT_MODEL;
  }
  // ym434（承 ym431 审计 P1-1）：白天窗禁回落——未显式指派、shift 内、免费路由无命中（能走到
  // 这里即无命中）、MIMO 不可用（熔断或未配置）时，抛等待信号而非回落 default（智谱套餐）。
  // 调用方按既有退避重试（ShiftWaitError.retryAfterSeconds），等熔断窗过/凭据恢复/跨窗自愈后
  // 自然成功；显式指派与套餐窗（shift 外）的回落行为不变。
  if (!overridden && planLive && shift && !usable) {
    const remaining = await mimoCircuitRemainingMs();
    const waitSeconds = remaining === null ? 1800 : Math.min(1800, Math.max(60, Math.ceil(remaining / 1000)));
    throw new ShiftWaitError(
      `shift-wait: no free-certificate route for ${capability} and MIMO is ${remaining === null ? "not configured" : "circuit-open"} in the daytime window; waiting instead of falling back to the plan model`,
      waitSeconds,
    );
  }
  return MODELS[chosen] ? chosen : c.default;
}

/** Where the current choice comes from, for the admin page.
 *  ym249：free 命中附 resolved 当前证据（哪只模型、何时认证、通过数）——后台按事实投影。 */
export async function modelSources(): Promise<Record<string, { model: string; source: "admin" | "env" | "default" | "free" | "mimo"; evidence?: { freeModel: string; testedAt: string; passCount: number } }>> {
  const o = await overrides();
  const routing = await ensureFreeRouting();
  const out: Record<string, { model: string; source: "admin" | "env" | "default" | "free" | "mimo"; evidence?: { freeModel: string; testedAt: string; passCount: number } }> = {};
  for (const [key, c] of Object.entries(CAPABILITIES) as Array<[string, Capability]>) {
    if (o[key]) out[key] = { model: o[key]!, source: "admin" };
    else if (process.env[c.env] && MODELS[process.env[c.env]!]) out[key] = { model: process.env[c.env]!, source: "env" };
    else {
      // ym350：路由启用时投影与 modelFor 实走一致的链首——MIMO 链首=「接口路由·MIMO」
      // （全天候接管，取代白班窗）；免费链首继续走下方 free 证据投影；GLM 链首=default
      // 语义（现有分支兜底）。路由关=链空，全部旧投影。
      const routerChain = await apiRouteChain(key, { vision: !!c.vision, excludeFree: FREE_EXCLUDED_CAPABILITIES.includes(key as CapabilityKey) });
      if (routerChain[0] === PROVIDER_MODELS.mimo) { out[key] = { model: MIMO_SHIFT_MODEL, source: "mimo" }; continue; }
      // ym196 shoumen 复审 P3 销项：复核类能力位与 modelFor 同口径排除免费路由——故障
      // 场景（显式指派误删）下呈现与实走一致（付费），不误导 admin 页。
      // ym249：legacy 桥同 modelFor 收口（option A），且 free 命中附认证证据。
      const routes = routing.capabilityRoute[key] ?? [];
      const hit = !FREE_EXCLUDED_CAPABILITIES.includes(key as CapabilityKey)
        ? resolveFreeModel(
            routes,
            null,
            { vision: !!c.vision, simpleEligible: SIMPLE_CAPABILITIES.includes(key as CapabilityKey) },
          )
        : null;
      if (hit) {
        const route = routes.find((r) => r.model === hit.model);
        // ym436：智谱通道成员在后台页显示为 zhipu-free:<模型>（去前缀），openrouter 同旧；
        // ym467：opencode 通道同形（opencode-free:<模型>）。
        const preset = freePresetByChannel(route?.channel);
        out[key] = { model: `${preset}:${hit.model.replace(FREE_PREFIX_RE, "")}`, source: "free",
                     evidence: { freeModel: hit.model.replace(FREE_PREFIX_RE, ""), testedAt: route?.testedAt ?? "", passCount: route?.passCount ?? 0 } };
      } else out[key] = { model: c.default, source: "default" };
    }
  }
  return out;
}
