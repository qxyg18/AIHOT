// 免费模型能力级验收（ym196 命主令）：每个免费模型×每个能力位做 10 次真实任务调用
// （免费零成本，走 receipts purpose=free_capability_test），10 份输出打包给付费模型判卷
// （purpose=free_capability_judge，优惠窗折扣价），≥9/10 合格 → model_free_capabilities
// 落 qualified → 该能力位后续调用路由到该免费模型（capability-routing）；付费降为断链
// 过渡档。滚动调度：每晚一轮，每轮 cap 个组合，未测优先、已测 7 天复测（漂移追平）。
import { z } from "zod";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { OPENROUTER_FREE_KEY } from "./routing.ts";
import { ZHIPU_FREE_KEY } from "../providers/zhipu.ts";
import { OPENCODE_FREE_KEY } from "../providers/opencode.ts";
import { recordZhipuRoundOutcomes, type RoundOutcome } from "../zhipuwatch/pool.ts";
import { recordOpencodeRoundOutcomes } from "../opencodewatch/pool.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { addEvent } from "./store.ts";
import { saveCapabilityRoute, type CapabilityVerdict } from "./capability-routing.ts";

export const CAPABILITY_JUDGE_PROMPT_VERSION = promptVersion("model-capability-judge");
const JUDGE_SYSTEM = promptText("model-capability-judge");

export const SAMPLES_PER_COMBO = 10;
export const COMBOS_PER_ROUND = 8;
export const RETEST_AFTER_DAYS = 7;
/** 合格线（命主令「验收是否合格」的执行口径）：10 份中 ≥9 pass。 */
export const QUALIFY_LINE = 9;

const Passthrough = z.object({}).passthrough();
// 真实 schema 导出的能力位用真 schema（结构即契约）；其余 passthrough+判卷语义把关。
const Score = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

interface CapSpec {
  capability: string;
  purpose: string;
  label: string;
  schema: z.ZodType;
  buildUser: (article: SampleArticle, i: number) => string;
  values?: Record<string, string>;
}

export interface SampleArticle {
  title: string;
  body: string;
  source: string;
  date: string;
}

const day = (i: number) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
const FIXTURE: SampleArticle[] = Array.from({ length: SAMPLES_PER_COMBO }, (_, i) => ({
  title: `童装品牌测试样本 ${i + 1}：门店调整与新品动作`,
  source: "测试信源",
  date: day(i),
  body: `某童装品牌在第 ${i + 1} 个测试样本中披露：本季新增门店 ${10 + i} 家，关闭低效店 ${i + 2} 家，主力价格带 199-399 元，并推出联名系列。相关负责人表示渠道库存周转天数 ${60 - i} 天，较上季改善。该品牌当前在全国拥有 ${100 + i * 5} 家门店。`,
}));

/** 从库里取 10 篇近期文章做测试材料（不足用内置 fixture 补齐，保证样本数恒为 10）。 */
export async function sampleArticles(): Promise<SampleArticle[]> {
  const rows = await sql<{ title: string; body_text: string; published_at: Date | null }[]>`
    SELECT title, body_text, published_at FROM articles
    WHERE body_text IS NOT NULL AND length(body_text) > 200 ORDER BY published_at DESC NULLS LAST LIMIT ${SAMPLES_PER_COMBO}`;
  const real = rows.map((r) => ({
    title: r.title,
    body: r.body_text.slice(0, 1500),
    source: "站内信源",
    date: (r.published_at ?? new Date()).toISOString().slice(0, 10),
  }));
  return [...real, ...FIXTURE].slice(0, SAMPLES_PER_COMBO);
}

const articleBlock = (a: SampleArticle) => `标题：${a.title}\n信源：${a.source}（${a.date}）\n正文：${a.body}`;

/** 各能力位的测试任务定义：真实提示词文件（promptText）+ 代表性输入。 */
export function capabilitySpecs(): CapSpec[] {
  return [
    { capability: "prefilter", purpose: "prefilter_article", label: "行业相关性判断（宽召回）", schema: Passthrough,
      buildUser: (a) => `${articleBlock(a)}\n\n判断这篇文章是否属于童装行业相关内容，按提示词输出 JSON。` },
    { capability: "score", purpose: "score_article", label: "精选评分", schema: Score,
      buildUser: (a) => `${articleBlock(a)}\n\n给这篇文章打关注度分（0-100 整数），按提示词输出 JSON。` },
    { capability: "understand", purpose: "understand_article", label: "内容理解（标题摘要推荐理由）", schema: Passthrough,
      buildUser: (a) => `${articleBlock(a)}\n\n理解这篇内容，按提示词输出 JSON。` },
    { capability: "summarize", purpose: "summarize_article", label: "标题摘要", schema: Passthrough,
      buildUser: (a) => `${articleBlock(a)}\n\n写中文标题与摘要，按提示词输出 JSON。`,
      values: { body: "（正文见用户消息）", identity: "童装行业动态", publishedDate: day(0), sourceName: "测试信源", title: "样本", today: day(0) } },
    { capability: "structure", purpose: "structure_article", label: "结构抽取", schema: Passthrough,
      buildUser: (a) => `${articleBlock(a)}\n\n抽取分类、标签、主体公司与事件事实，按提示词输出 JSON。`,
      values: { categoryCount: "6", categoryGuide: "brand-moves/channel/industry/statistics/product/overseas", categoryTags: "门店/新品/库存/价格", entities: "无预置主体", entityTags: "无", topicTags: "门店调整/新品" } },
    { capability: "group", purpose: "group_article", label: "事件归组", schema: Passthrough,
      buildUser: (a, i) => `新报道：${articleBlock(a)}\n\n候选事实：此前有报道称同一品牌本季门店净增为正、另有渠道库存改善的记录（第 ${i + 1} 组）。判断新报道与候选事实的关系（同一次发生/同一事件的进展/无关），按提示词输出 JSON。` },
    { capability: "groupReview", purpose: "group_review", label: "归组复核", schema: Passthrough,
      buildUser: (a, i) => `待复核合并：两篇报道都涉及童装品牌门店网络变化（相似度中等，第 ${i + 1} 组）。材料：${articleBlock(a)}\n\n判断这两条是否应合并为同一事件，按提示词输出 JSON。` },
    { capability: "digest", purpose: "story_digest", label: "事件综述", schema: Passthrough,
      buildUser: (a) => `事件相关报道：\n${articleBlock(a)}\n\n写一段事件综述，按提示词输出 JSON。` },
    { capability: "report", purpose: "report_lead", label: "日报头条导语", schema: Passthrough,
      buildUser: (a) => `今日素材：\n${articleBlock(a)}\n\n写日报头条导语（说清发生了什么、为什么值得注意），按提示词输出 JSON。` },
    { capability: "translate", purpose: "translate_body", label: "全文翻译", schema: Passthrough,
      buildUser: (a) => `把下面内容翻译成中文（保留事实与数字）：\n${a.title} — ${a.body.slice(0, 600)}\n\n按提示词输出 JSON。` },
    { capability: "monitor", purpose: "monitor.recognize", label: "公告识别", schema: Passthrough,
      buildUser: (a) => `帖子内容：${a.title}：${a.body.slice(0, 400)}\n\n识别这是否为模型服务重置/变更类公告，按提示词输出 JSON。` },
    { capability: "brandProfile", purpose: "brand_profile", label: "品牌档案总结", schema: Passthrough,
      buildUser: (a) => `品牌：样本童装品牌\n\n档案材料：${articleBlock(a)}\n\n按提示词输出八问 JSON。` },
    { capability: "insight", purpose: "report_insights", label: "研报观点提取", schema: Passthrough,
      buildUser: (a) => `研报片段：${articleBlock(a)}\n\n提取品牌/商业体/行业的研判观点与数字三件套，按提示词输出 JSON。`, values: { entities: "无预置主体" } },
    { capability: "deepread", purpose: "article_deep_read", label: "深解读", schema: Passthrough,
      buildUser: (a) => `文章：${articleBlock(a)}\n\n写一段不点原文也能懂的大白话深解读，按提示词输出 JSON。` },
    { capability: "ossDigest", purpose: "oss_digest", label: "开源更新解读", schema: Passthrough,
      buildUser: (a, i) => `开源项目：样本项目（https://github.com/example/repo）\n本期更新（kind=release）：{"tag":"v1.${i}.0","notes":"新增导出面板，修复列表翻页，工具占用上下文优化"}\n写大白话解读（概览/逐条/适配提示/置信度），按提示词输出 JSON。` },
    { capability: "zhipuDigest", purpose: "zhipu_digest", label: "智谱动态解读", schema: Passthrough,
      buildUser: (_a, i) => `今天：${day(0)}（北京时间）\n信源：智谱开放平台文档站（docs.bigmodel.cn）·「模型与产品发布记录」\n本期条目：kind=model_release，title=GLM-4.7-Flash 免费模型上线，url=https://docs.bigmodel.cn/cn/update/new-releases\n材料原文（唯一事实来源）：\n<Update label="2026-01-19" description="GLM-4.7-Flash 免费模型上线">\n  GLM-4.7-Flash 为 GLM-4.7 的免费版本，针对高频调用场景进行优化（第 ${i + 1} 期样本）；输入/输出单价均为免费，上下文 200K。\n</Update>\n写大白话解读（概览/逐条/值得行动/需要警惕/置信度），按提示词输出 JSON。` },
  ];
}

export interface JudgeOutcome {
  verdict: CapabilityVerdict;
  passCount: number;
  payload: Record<string, unknown>;
  receiptId: number | null;
}

export interface TestOptions {
  /** 注入单次能力调用（测试）；缺省走 chatJson 免费预设+pinnedModel。 */
  callModel?: (args: { model: string; capability: string; system: string; user: string }) => Promise<{ ok: boolean; output: unknown; error: string | null }>;
  /** 注入判卷（测试）；缺省走 chatJson 付费 default。 */
  judge?: (args: { model: string; capability: string; samples: Array<{ i: number; ok: boolean; output: unknown; error: string | null; task: string }> }) => Promise<JudgeOutcome>;
  /** 组合上限（每轮滚动）；缺省 COMBOS_PER_ROUND。 */
  cap?: number;
  now?: Date;
}

export interface TestSummary {
  at: string;
  ok: boolean;
  error: string | null;
  combos: number;
  tested: number;
  qualified: number;
  rejected: number;
  failedCombos: number;
  calls: number;
  /** ym438：本轮因连续调用全失败被自动摘池（status=filtered）的智谱模型。 */
  retired: string[];
}

const JudgeSchema = z.object({
  verdict: z.enum(["qualified", "rejected"]),
  samples: z.array(z.object({ i: z.number(), pass: z.boolean(), reason: z.string() })),
  passCount: z.number().int().min(0).max(10),
  issues: z.string(),
});

/** 待测组合：未测优先，再按 tested_at 最旧优先取 7 天前测过的（qualified/rejected 同权复测）。
 *  组合=在役免费模型（非 ended/filtered）× 全能力位，TS 侧笛卡尔积+内存过滤（量级 ~几百，免脆 SQL）。 */
export async function pickTestCombos(cap: number, now = new Date()): Promise<Array<{ modelId: string; capability: string }>> {
  const retestBefore = now.getTime() - RETEST_AFTER_DAYS * 86_400_000;
  const models = await sql<{ model_id: string; free_from: Date | null }[]>`
    SELECT model_id, free_from FROM model_watch_models WHERE status NOT IN ('ended', 'filtered') ORDER BY free_from DESC NULLS LAST, model_id`;
  const existing = await sql<{ model_id: string; capability: string; tested_at: Date }[]>`SELECT model_id, capability, tested_at FROM model_free_capabilities`;
  const lastTested = new Map(existing.map((r) => [`${r.model_id}|${r.capability}`, r.tested_at.getTime()]));
  const fresh: Array<{ modelId: string; capability: string }> = [];
  const retest: Array<{ modelId: string; capability: string; testedAt: number }> = [];
  for (const m of models) {
    for (const s of capabilitySpecs()) {
      const at = lastTested.get(`${m.model_id}|${s.capability}`);
      if (at === undefined) fresh.push({ modelId: m.model_id, capability: s.capability });
      else if (at <= retestBefore) retest.push({ modelId: m.model_id, capability: s.capability, testedAt: at });
    }
  }
  retest.sort((a, b) => a.testedAt - b.testedAt);
  return [...fresh, ...retest.map(({ modelId, capability }) => ({ modelId, capability }))].slice(0, cap);
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/** 一轮验收：选组合 → 每组合 10 次真实调用 → 打包付费判卷 → 验收写回 + 事件留痕。 */
export async function runCapabilityTests(opts: TestOptions = {}): Promise<TestSummary> {
  const now = opts.now ?? new Date();
  const summary: TestSummary = { at: now.toISOString(), ok: false, error: null, combos: 0, tested: 0, qualified: 0, rejected: 0, failedCombos: 0, calls: 0, retired: [] };
  try {
    const specs = new Map(capabilitySpecs().map((s) => [s.capability, s]));
    const articles = await sampleArticles();
    const combos = await pickTestCombos(opts.cap ?? COMBOS_PER_ROUND, now);
    summary.combos = combos.length;
    // ym438：智谱成员的本轮调用面（连续全失败自动摘池的依据；判卷失败/rejected 不算）。
    const round: RoundOutcome[] = [];
    for (const { modelId, capability } of combos) {
      const spec = specs.get(capability);
      if (!spec) continue;
      const system = promptText(promptNameFor(capability), spec.values ?? {});
      const samples = await mapLimited(Array.from({ length: SAMPLES_PER_COMBO }, (_, i) => i), 5, async (i) => {
        const user = spec.buildUser(articles[i % articles.length], i);
        summary.calls++;
        if (opts.callModel) {
          return { i, ...(await opts.callModel({ model: modelId, capability, system, user })), task: spec.label };
        }
        try {
          const res = await chatJson({
            // ym436：zhipu: 前缀成员走智谱免费预设（llm.ts 去前缀发 paas/v4），其余走 OpenRouter。
            // ym467：opencode: 前缀成员走 opencode 免费预设（经客户端中介出文）——分流错误会把
            // 调用发错端点、证书记错模型名下（ym436 P2-3 教训）。
            model: modelId.startsWith("zhipu:") ? ZHIPU_FREE_KEY : modelId.startsWith("opencode:") ? OPENCODE_FREE_KEY : OPENROUTER_FREE_KEY,
            purpose: "free_capability_test",
            subject: `${modelId}|${capability}#${i}`,
            promptVersion: promptVersion(promptNameFor(capability)), // ym196 shoumen P3-4：测试调用记真实能力提示词版本
            system,
            user,
            schema: spec.schema,
            temperature: 0.2,
            maxTokens: 1500,
            pinnedModel: modelId,
            timeoutMs: 60_000,
          });
          return { i, ok: true, output: res.data, error: null, task: spec.label };
        } catch (error) {
          return { i, ok: false, output: null, error: String(error).slice(0, 200), task: spec.label };
        }
      });

      if (modelId.startsWith("zhipu:") || modelId.startsWith("opencode:")) {
        const okN = samples.filter((s) => s.ok).length;
        round.push({
          modelId, calls: samples.length, ok: okN,
          lastError: okN < samples.length ? (samples.find((s) => !s.ok)?.error ?? null) : null,
        });
      }

      const judgeInput = { model: modelId, capability, task: spec.label, samples };
      let outcome: JudgeOutcome | null = null;
      try {
        if (opts.judge) {
          outcome = await opts.judge(judgeInput);
        } else {
          const res = await chatJson({
            model: "default", // 判卷=付费模型（命主令：由付费模型验收）；直接走 default 预设不经免费路由
            purpose: "free_capability_judge",
            subject: `${modelId}|${capability}`,
            promptVersion: CAPABILITY_JUDGE_PROMPT_VERSION,
            system: JUDGE_SYSTEM,
            user: JSON.stringify(judgeInput),
            schema: JudgeSchema,
            temperature: 0.1,
            maxTokens: 2500,
          });
          outcome = { verdict: res.data.verdict, passCount: res.data.passCount, payload: { ...res.data, judgedModel: res.model }, receiptId: res.receiptId };
        }
      } catch (error) {
        summary.failedCombos++;
        summary.error = `${modelId}|${capability} 判卷失败：${String(error).slice(0, 150)}`;
        continue; // 判卷失败不写回：组合保持未验收，下轮再测
      }
      // 合格线代码强制（ym196 shoumen P1 销项）：判卷模型若输出 verdict=qualified 但
      // passCount 不足线，一律按 rejected 落表——verdict 以硬闸为准，不信任判卷自评。
      if (outcome.verdict === "qualified" && outcome.passCount < QUALIFY_LINE) {
        outcome = { ...outcome, verdict: "rejected", payload: { ...outcome.payload, overridden: `passCount ${outcome.passCount} < 合格线 ${QUALIFY_LINE}` } };
      }
      // 原始样本错误随验收落盘（判卷转述之外留一手，排障可直接看）。
      await saveCapabilityRoute({
        modelId, capability, verdict: outcome.verdict, passCount: outcome.passCount,
        payload: { ...outcome.payload, samplesRaw: samples.map((s) => ({ i: s.i, ok: s.ok, error: s.error })) },
        receiptId: outcome.receiptId,
      });
      await addEvent("capability_test", modelId, { capability, verdict: outcome.verdict, passCount: outcome.passCount });
      summary.tested++;
      if (outcome.verdict === "qualified") summary.qualified++;
      else summary.rejected++;
    }
    // ym438：智谱成员连续调用全失败的自动摘池收尾（置 filtered/池移除/事件留痕都在 pool 层）；
    // ym467：opencode 成员同口径（各自 pool 层按前缀过滤，互不牵连）。
    summary.retired = [
      ...(await recordZhipuRoundOutcomes(round, now)).retired,
      ...(await recordOpencodeRoundOutcomes(round, now)).retired,
    ];
    summary.ok = summary.combos === 0 || summary.tested > 0;
    return summary;
  } catch (error) {
    summary.error = String(error).slice(0, 300);
    throw error;
  }
}

/** 能力位 → 真实提示词文件名（与 industry/prompts/ 对应；无独立文件的用所在族文件）。 */
function promptNameFor(capability: string): string {
  const map: Record<string, string> = {
    prefilter: "prefilter", score: "selection-score", understand: "content-understanding", summarize: "summarize-article",
    structure: "structure", group: "group-pair", groupReview: "group-pair", digest: "story-digest", report: "report-daily-lead",
    translate: "translate-body", monitor: "understand", brandProfile: "brand-profile", insight: "report-insights",
    deepread: "deep-read", ossDigest: "oss-watch", zhipuDigest: "zhipu-watch",
  };
  return map[capability] ?? "understand";
}
