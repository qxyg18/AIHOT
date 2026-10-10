// T15/ym248：文章/日报审核面（BUILD 禁用态）——单位/币种/期间/基准保留校验、聚簇独立性、
// 渠道关联证据与宏观推断隔离、冲突并列。纯函数零模型调用（ADR rationale：自动能力未认证时
// 仅待核/人工，不把模型判断当事实）；审核结果随 report content 落库（无新迁移）；样本集通道
// 预留（AC4 已由命主 2026-10-05 改向为 AI 自观测校准闭环 ym375：词表/闸条件按对拍台账逐轮校准）。
import { sha256, stableJson } from "../lib/ids.ts";

/** 审核输入=条目原文材料（title/summary/来源名/正文切片）。 */
export interface ReviewInput {
  itemId: string;
  title: string;
  summary: string;
  sourceName: string;
  bodyExcerpt?: string;
  /** 同事件聚簇键（fact/story 公开 id）：同簇多条=同事件，不作多源独立佐证。 */
  sameEventKey?: string | null;
  /** 条目分类（宏观/市场数据类条目触发推断隔离）。 */
  category?: string | null;
}

/** 数值/单位/币种快照：原文出现即记录，禁止下游转写丢失或换算（£≠$、名义≠固定汇率）。 */
export interface MetricSnapshot {
  raw: string;
  value: number | null;
  /** 邻近基准词（名义/固定汇率/同比/环比/财年/季度…），两值基准不同=并列不平均。 */
  basisContext: string[];
}

export type ReviewFlag =
  | "unit_mismatch" // 下游文本引用了数值但单位/币种与原文快照不一致
  | "missing_unit" // 原文数值无单位上下文（无法验证口径）
  | "conflict_pending" // 同主体同指标不同值并列待核
  | "ungrounded_action" // 点评含渠道行动指令但条目材料无渠道关联证据
  | "macro_inference_unqualified"; // 宏观类条目的点评缺「不确定/待核/下一步核验」限定

export interface ReviewResult {
  inputHash: string;
  itemId: string;
  metrics: MetricSnapshot[];
  flags: ReviewFlag[];
  /** 冲突并列值（同主体同指标多值）：逐值保留，不平均造结论。 */
  conflicts: Array<{ subject: string; values: string[] }>;
  sameEventKey: string | null;
}

// 无状态正则：模块级 /g 正则的 lastIndex 跨调用残留会让 matchAll/test 漏匹配——每次现造。
// 审计 P2 销项：\b 在 CJK 下永不匹配（基于 \w），中文计价词去词边界；英文缩写保留边界。
const CURRENCY_SRC = "[£$￥¥]|（?\\b(?:CNY|USD|GBP|RMB)\\b|亿元|万元|亿|万";
const PERCENT_SRC = "-?\\d+(?:\\.\\d+)?\\s*%";
const NUMBER_SRC = "-?\\d+(?:\\.\\d+)?";
const percentRe = () => new RegExp(PERCENT_SRC, "gu");
const currencyRe = () => new RegExp(CURRENCY_SRC, "gu");
const numberRe = () => new RegExp(NUMBER_SRC, "u");
const BASIS_WORDS = ["名义", "固定汇率", "同比", "环比", "财年", "季度", "经调整", "剔除汇率", "不变价", "报告期"];
/** 会计口径基准词（同指标不同会计口径=并列冲突候选）；期间词（同比/环比/财年/季度）不触发冲突——
 *  ym375 首轮对拍：原「多值即记」9/9 为期间词/无基准误报（台账 calibration-ledger.json）。 */
const ACCOUNTING_BASIS_WORDS = ["名义", "固定汇率", "经调整", "剔除汇率", "不变价", "报告期"];
/** 渠道行动动词（AC2：点评出现即须有条目材料里的渠道关联证据，否则转待核）。
 *  ym375 校准 +压库存/上调/铺货（首轮对拍 S-004/S-024 应拦未拦实证；进货不加：S-002 观察句误伤）。 */
const ACTION_WORDS = ["调价", "涨价", "降价", "扩店", "开店", "关店", "闭店", "入驻", "加盟", "签约", "拓店", "收缩", "压库存", "上调", "铺货"];
/** 配对动词（审计 P2-2）：仅与价/陈列面词共现才计行动指令——「机构上调目标价/盈利预测」属财务
 *  观察语，不带配对词不触发行动闸（S-024 实证形态=上调+陈列/定价/占比）。 */
const ACTION_PAIR_WORDS: Record<string, string[]> = { 上调: ["定价", "价格", "售价", "陈列", "占比"] };
/** 行动词判定（含配对守卫），行动有据/宏观限定两闸共用。 */
function hasActionWord(soWhat: string): boolean {
  return ACTION_WORDS.some((w) => {
    const need = ACTION_PAIR_WORDS[w];
    return soWhat.includes(w) && (!need || need.some((p) => soWhat.includes(p)));
  });
}
/** 渠道关联证据词（出现在条目自身材料里才算有据）。ym375 校准 +奥特莱斯/奥莱（复判 S-002 渠道词实证）。 */
const CHANNEL_EVIDENCE = ["门店", "渠道", "加盟", "入驻", "商场", "商业体", "经销", "直营", "专柜", "店铺", "零售", "渠道商", "购物中心", "开业", "选址", "奥特莱斯", "奥莱"];
/** 宏观/市场数据类目（编辑部分类 key；点评须带限定词）。ym375 校准：生产类目键实测含 statistics/industry
 *  （原集合与生产键零交集=闸失明，宏观限定在生产从不触发）。industry 复判证据偏弱（d_is_macro 1/5），
 *  凭「材料面含渠道事实词豁免」兜底，二轮按类目补证（审计 P2-1）。 */
const MACRO_CATEGORIES = new Set(["market-data", "macro", "statistics", "industry"]);
const QUALIFIERS = ["不确定", "待核", "下一步核验", "尚待", "待确认", "参考"];

/** 审核输入哈希（幂等键：同输入同哈希，结果可复算对拍）。 */
export function reviewHash(input: ReviewInput): string {
  return sha256(stableJson({ itemId: input.itemId, title: input.title, summary: input.summary, sourceName: input.sourceName, bodyExcerpt: input.bodyExcerpt ?? "", sameEventKey: input.sameEventKey ?? null, category: input.category ?? null }));
}

function basisAround(text: string, idx: number): string[] {
  const window = text.slice(Math.max(0, idx - 24), idx + 24);
  return BASIS_WORDS.filter((w) => window.includes(w));
}

/** 基准词就近归属（ym375 审计 M-1 修复）：按标点（，。；！？、）切句片段，基准词归属**所在片段内**
 *  距离最近的百分比出现（片段内无百分比则不归属，半径 24 字）。修复 ±24 全量窗口的相邻同染：
 *  真实文本「22%（名义），按固定汇率口径则增长 26%」中「固定汇率」按窗口距离反而更近 22%，
 *  两值基准同染致会计口径互异判定在真实管线必败（ym248 既有测试件实测 12/13 红）。 */
function ownBasisByNearest(text: string, pctIndexes: number[]): Map<number, string[]> {
  const owned = new Map<number, string[]>();
  for (const i of pctIndexes) owned.set(i, []);
  const isSplit = (ch: string) => "，。；！？、".includes(ch);
  const emit = (start: number, end: number) => {
    const idxs = pctIndexes.filter((i) => i >= start && i < end);
    if (!idxs.length) return;
    for (const bw of BASIS_WORDS) {
      let pos = start;
      for (;;) {
        const next = text.indexOf(bw, pos);
        if (next === -1 || next >= end) break;
        let best = idxs[0];
        let bestDist = Infinity;
        for (const i of idxs) {
          const d = Math.abs(i - next);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        if (bestDist <= 24) {
          const arr = owned.get(best)!;
          if (!arr.includes(bw)) arr.push(bw);
        }
        pos = next + bw.length;
      }
    }
  };
  let fragStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSplit(text[i]!)) { emit(fragStart, i); fragStart = i + 1; }
  }
  emit(fragStart, text.length);
  return owned;
}

/** 原文数值/单位/基准快照（机械抽取，不做语义判断）。百分比基准词按就近归属（ownBasisByNearest），
 *  币种/计价 token 沿用窗口上下文（仅展示面，无消费方）。 */
export function snapshotMetrics(text: string): MetricSnapshot[] {
  const out: MetricSnapshot[] = [];
  const seen = new Set<string>();
  const pcts = [...text.matchAll(percentRe())];
  const owned = ownBasisByNearest(text, pcts.map((m) => m.index ?? 0));
  for (const m of pcts) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ raw, value: Number(raw.replace(/\s|%/g, "")) || null, basisContext: owned.get(m.index ?? 0) ?? [] });
  }
  for (const m of text.matchAll(currencyRe())) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ raw, value: null, basisContext: basisAround(text, m.index ?? 0) });
  }
  return out;
}

/** 下游文本（头条导语/点评句）引用的数值是否保真：每个引用百分比须与原文快照同值（保留各自
 *  基准：22% 与 26% 是两条快照，引用其一不得混写）；币种符号跨币种换写（£→$、亿元→$）=unit_mismatch。
 *  审计 P1 销项：照抄原文同值百分比是合规引用，不判 missing_unit（口径不可验证只记原文侧快照缺失）。 */
export function checkUnitPreservation(downstream: string, metrics: MetricSnapshot[]): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const origPct = new Set(metrics.filter((m) => m.raw.includes("%")).map((m) => m.value));
  const origCur = new Set(metrics.filter((m) => /[£$￥¥]/.test(m.raw)).map((m) => m.raw.match(/[£$￥¥]/)?.[0]));
  const downCur = new Set([...[...downstream.matchAll(/[£$￥¥]/gu)]].map((m) => m[0]));
  // 下游出现原文快照没有的币种符号=换写失真（原文只有中文计价词「亿元」而下游写 $ 同样成立；
  //  审计 P2 补：去掉空集守卫——原文无任何币种上下文时下游引入符号也属口径改写）。
  for (const c of downCur) if (!origCur.has(c)) flags.push("unit_mismatch");
  // 下游百分比须与原文某值同值（保留各自基准）
  for (const m of downstream.matchAll(percentRe())) {
    const v = Number(m[0].replace(/\s|%/g, ""));
    if (!origPct.has(v)) flags.push("unit_mismatch");
  }
  return [...new Set(flags)];
}

/** 冲突并列：同主体（粗粒度=同条目）内同指标不同值——ym375 校准：仅当 ≥2 个不同值携带互异的
 *  会计口径基准词（名义 vs 固定汇率 vs 经调整…）才判并列，逐值保留不平均（AC1 典型=22%名义与
 *  26%固定汇率）；期间词多值/无基准多值不触发（首轮对拍 9/9 误报销项）。 */
export function detectConflicts(metrics: MetricSnapshot[], subject: string): Array<{ subject: string; values: string[] }> {
  const pcts = metrics.filter((m) => m.raw.includes("%"));
  const byValue = new Map<number, string[]>();
  for (const m of pcts) {
    if (m.value == null) continue;
    byValue.set(m.value, [...(byValue.get(m.value) ?? []), ...m.basisContext]);
  }
  const accByValue = [...byValue.entries()].map(([v, bases]) => [...new Set(bases.filter((b) => ACCOUNTING_BASIS_WORDS.includes(b)))]);
  let divergent = false;
  for (let i = 0; i < accByValue.length && !divergent; i++) {
    if (!accByValue[i].length) continue;
    for (let j = i + 1; j < accByValue.length; j++) {
      if (!accByValue[j].length) continue;
      if (accByValue[i].every((w) => !accByValue[j].includes(w))) { divergent = true; break; }
    }
  }
  if (!divergent) return [];
  const values = [...byValue.entries()].map(([v, bases]) => (bases.length ? `${v}%（${[...new Set(bases)].join("/")}）` : `${v}%`));
  return [{ subject, values }];
}

/** AC2 渠道关联证据：点评句含行动动词（hasActionWord，含配对守卫），但条目事实材料无渠道证据词
 *  且无实体渠道主体 → ungrounded_action（句级丢弃，宁缺勿错）。材料面由调用方按口径 v1.1 传入
 *  （标题+摘要；来源名不作文案事实，ym375 P3-1 校准）。 */
export function checkGroundedAction(soWhat: string, entryMaterial: string): boolean {
  const hasAction = hasActionWord(soWhat);
  if (!hasAction) return true;
  return CHANNEL_EVIDENCE.some((w) => entryMaterial.includes(w));
}

/** AC2 宏观推断隔离：宏观/市场数据类条目的点评须带限定词才不出闸（不生成经营指令）。
 *  ym375 校准：①材料面含渠道证据词=落得到具体渠道动作，豁免（口径「落不到具体渠道动作」语义）；
 *  ②仅有点评含行动指令时才闸（观察句不生成指令，首轮对拍 S-002/S-008/S-015 复判均放/待核实证）。 */
export function checkMacroQualified(soWhat: string, category: string | null | undefined, entryMaterial?: string): boolean {
  if (!category || !MACRO_CATEGORIES.has(category)) return true;
  if (entryMaterial && CHANNEL_EVIDENCE.some((w) => entryMaterial.includes(w))) return true;
  return QUALIFIERS.some((w) => soWhat.includes(w));
}

/** 单条目审核（机械面）：快照+单位保持基线+冲突并列。 */
export function reviewArticleEvidence(input: ReviewInput): ReviewResult {
  const text = `${input.title} ${input.summary} ${input.bodyExcerpt ?? ""}`;
  const metrics = snapshotMetrics(`${input.title} ${input.summary}`);
  const conflicts = detectConflicts(metrics, input.itemId);
  const flags: ReviewFlag[] = [];
  if (conflicts.length) flags.push("conflict_pending");
  for (const m of metrics) {
    if (m.raw.includes("%") && !m.basisContext.length && numberRe().test(m.raw)) {
      // 百分比无任何基准词上下文：口径待核（不阻断，快照已保留原样）
      flags.push("missing_unit");
      break;
    }
  }
  return { inputHash: reviewHash(input), itemId: input.itemId, metrics, flags: [...new Set(flags)], conflicts, sameEventKey: input.sameEventKey ?? null };
}

/** 点评句级审核（compose 消费）：三闸全过才可发布；不过=丢弃（AC2「可停车」）。
 *  ym375 校准：行动有据/宏观限定两闸的材料面=标题+摘要（口径 v1.1 材料面约定；来源名不作文案
 *  事实——首轮实录 S-007 来源名「商业体」曾放行无据扩店指令，P3-1 销项）；单位保真仍用全材料
 *  快照（原文侧从宽保留）。 */
export function reviewSoWhatLine(soWhat: string, entry: { title: string; summary: string; sourceName: string; category?: string | null }): { ok: boolean; flags: ReviewFlag[] } {
  const flags: ReviewFlag[] = [];
  const factMaterial = `${entry.title} ${entry.summary}`;
  const material = `${factMaterial} ${entry.sourceName}`;
  if (!checkGroundedAction(soWhat, factMaterial)) flags.push("ungrounded_action");
  if (hasActionWord(soWhat) && !checkMacroQualified(soWhat, entry.category, factMaterial)) flags.push("macro_inference_unqualified");
  const entryMetrics = snapshotMetrics(material);
  flags.push(...checkUnitPreservation(soWhat, entryMetrics));
  return { ok: flags.length === 0, flags: [...new Set(flags)] };
}

/** 审计 P1 销项：头条导语（writeLead 产物）同闸审核——导语是头版 600 字文本，单位/币种保真与
 *  行动有据/宏观限定与点评句同口径；不过=导语降级不出（lead 可 null，页面已有无导语路径，
 *  与「出刊不能等」兼容：条目/看点/简讯照常出刊，丢的只是失真导语）。 */
export function reviewLeadParagraph(leadParagraph: string, entries: Array<{ title: string; summary: string; sourceName: string; category?: string | null }>): { ok: boolean; flags: ReviewFlag[] } {
  const flags: ReviewFlag[] = [];
  const factMaterial = entries.map((e) => `${e.title} ${e.summary}`).join(" ");
  const material = entries.map((e) => `${e.title} ${e.summary} ${e.sourceName}`).join(" ");
  const metrics = snapshotMetrics(material);
  flags.push(...checkUnitPreservation(leadParagraph, metrics));
  if (!checkGroundedAction(leadParagraph, factMaterial)) flags.push("ungrounded_action");
  const macroOnly = entries.length > 0 && entries.every((e) => e.category && MACRO_CATEGORIES.has(e.category));
  if (macroOnly && hasActionWord(leadParagraph) && !checkMacroQualified(leadParagraph, "macro", factMaterial)) flags.push("macro_inference_unqualified");
  return { ok: flags.length === 0, flags: [...new Set(flags)] };
}

/** 聚簇独立性（AC1 后半）：同 sameEventKey 的引用集合只算一个独立事件；报告 metrics 的
 *  sourcesCount 不得把同簇多条计为多源佐证（compose 侧消费本判定收口口径）。 */
export function independentEventCount(entries: Array<{ sameEventKey?: string | null; itemId: string }>): number {
  const seen = new Set<string>();
  let n = 0;
  for (const e of entries) {
    const key = e.sameEventKey ?? `a:${e.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
  }
  return n;
}
