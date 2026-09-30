// Model per capability: the code default (`default`, the deployment's own model), an environment
// override, and an admin switch kept in settings (every switch is audited). Read at call time and
// cached for a minute, so a switch applies to the next call without a restart; a changed model only
// affects work done from then on (history is not re-judged).
import { sql } from "../db.ts";
import { MODELS } from "../providers/llm.ts";
import { mimoUsable } from "../providers/mimo.ts";
import { mimoEarlyLive, mimoShiftActive, offpeakPlanLive } from "../lib/windows.ts";

/** ka3: inside the MIMO daytime shift (9:00-22:59 Beijing, plan live) an unoverridden capability
 *  runs on the pay-as-you-go MIMO preset instead of the plan model; explicit admin/env choices
 *  always win and off-peak hours keep the discounted Zhipu plan. */
export const MIMO_SHIFT_MODEL = "mimo-v2.6-flash";

export function routeToMimo(input: { overridden: boolean; planLive: boolean; shift: boolean; usable: boolean }): boolean {
  return !input.overridden && input.planLive && input.shift && input.usable;
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
  report: { label: "日报、周报、月报", env: "REPORT_MODEL", default: "default", purposes: ["report_lead", "report_daily", "report_weekly", "report_monthly"] },
  translate: { label: "精选全文翻译（含引用帖）", env: "TRANSLATE_MODEL", default: "default", purposes: ["translate_body", "translate_quoted"] },
  monitor: { label: "Codex 重置公告识别", env: "MONITOR_MODEL", default: "default", purposes: ["monitor.recognize", "monitor.context"] },
  brandProfile: { label: "品牌档案八问总结（百科材料→八问+50字简介）", env: "BRAND_PROFILE_MODEL", default: "default", purposes: ["brand_profile"] },
  insight: { label: "研报观点提取（研报正文→品牌/商业体/行业的研判观点+数字三件套）", env: "INSIGHT_MODEL", default: "default", purposes: ["report_insights"] },
  deepread: { label: "新闻深解读（站内历史+档案→不点原文也能懂的大白话）", env: "DEEPREAD_MODEL", default: "default", purposes: ["article_deep_read"] },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

let cache: { at: number; overrides: Record<string, string> } | null = null;

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

/** The model a capability uses now: admin switch, else environment, else the code default. Inside
 *  the MIMO daytime shift the default additionally routes to the MIMO preset (ka3). */
export async function modelFor(capability: CapabilityKey): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const o = await overrides();
  const overridden = !!(o[capability] ?? process.env[c.env]);
  const chosen = o[capability] ?? process.env[c.env] ?? c.default;
  if (routeToMimo({ overridden, planLive: offpeakPlanLive() || mimoEarlyLive(), shift: mimoShiftActive(), usable: await mimoUsable() })) {
    return MIMO_SHIFT_MODEL;
  }
  return MODELS[chosen] ? chosen : c.default;
}

/** Where the current choice comes from, for the admin page. */
export async function modelSources(): Promise<Record<string, { model: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides();
  const out: Record<string, { model: string; source: "admin" | "env" | "default" }> = {};
  for (const [key, c] of Object.entries(CAPABILITIES) as Array<[string, Capability]>) {
    if (o[key]) out[key] = { model: o[key]!, source: "admin" };
    else if (process.env[c.env] && MODELS[process.env[c.env]!]) out[key] = { model: process.env[c.env]!, source: "env" };
    else out[key] = { model: c.default, source: "default" };
  }
  return out;
}
