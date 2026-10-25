// 智谱关注主循环（日扫一轮，worker 的 zhipu.watch 调度；后台页可手动触发）：
//   5 定点页 .md 拉取 + sitemap.xml lastmod 差分 → 整页 content-hash 快路径 → 条目级差分
//   （水位里没有的键=新条目；已知键指纹变了=更新条目）→ 入库 → 逐条大白话解读（免费通道优先，
//   失败标 pending 下轮补）。口径（ym437 卡面）：
//   - 有料才出刊：整页没动零模型成本；条目级没动只推进水位；
//   - 水位幂等：同窗重跑零重复出刊（撞 dedup_key 唯一约束兜底，水位丢失也不重出）；
//   - 失败即停不猜测：页面结构解析不出 → 该页记错误、水位不动（下轮重试），绝不落猜测条目；
//   - 首轮基线：new-releases 最新 12 条（覆盖 GLM-4.7-Flash 实锚）、活动/免费行全量封顶 12、
//     公告页整页 1 条；sitemap 首轮只记水位，差分自下一轮起。
import { createHash } from "node:crypto";
import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { mdPlain, pageTitle, parseSitemap, type ParsedItem } from "./parse.ts";
import { applySignalActions } from "./linkage.ts";
import {
  docsFetchText, INCREMENTAL_CAP, SITEMAP_PER_RUN_CAP, WATCHED_PATH_PREFIXES,
  ZHIPU_SITEMAP_URL, ZHIPU_SOURCES, type ZhipuKind, type ZhipuSource,
} from "./sources.ts";
import { beijingDate } from "@aihot/contracts/time";
import {
  getWatermarks, insertUpdate, listPendingUpdates, listRowsMissingRoutingAction, saveDigest,
  saveDigestError, saveLastRun, saveWatermarks,
  type PageWatermark, type ZhipuUpdateRow, type ZhipuWatermarks,
} from "./store.ts";

export const ZHIPU_WATCH_PROMPT_VERSION = promptVersion("zhipu-watch");

const SYSTEM = promptText("zhipu-watch");

/** ym438：存量信号回填每轮上限（部署首轮即补齐历史 27 行；此后新行随出刊即时处理）。 */
const SIGNAL_BACKFILL_CAP = 50;

/** 模型偶尔把字符串数组写成对象数组（如 [{"action":"…","reason":"…"}]，2026-10-08 生产首扫
 *  MIMO 14/27 次如此）：宽容归一为字符串——把对象各字段按序拼起来，内容不丢，形状归位。 */
export const strList = z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).transform((list) =>
  list.map((item) =>
    typeof item === "string"
      ? item
      : Object.values(item).filter((v): v is string => typeof v === "string" && v.trim().length > 0).join("——") ||
        JSON.stringify(item),
  ),
);

export const ZhipuDigestSchema = z.object({
  overview: z.string().min(1),
  items: z.array(z.object({ title: z.string().min(1), plain: z.string().min(1) })).min(1),
  adopt: strList,
  caution: strList,
  confidence: z.number().min(0).max(1),
});
export type ZhipuDigest = z.infer<typeof ZhipuDigestSchema>;

export interface DigestOutcome {
  ok: boolean;
  digest: ZhipuDigest | null;
  receiptId: number | null;
  error: string | null;
}

const DIGEST_MAX_TOKENS = 3000;

/** 消费方背景（user 消息里带给模型）：「影响提示」面面向站长的订阅与模型路由决策。 */
const CONSUMER_CONTEXT =
  "站长是智谱编码套餐（GLM Coding Plan）用户；本站（童装行业情报站）的模型路由已接入智谱开放平台" +
  "免费档（GLM-4.7-Flash / GLM-4-Flash-250414 等，走站长自己的开放平台 key），另有 MIMO 按量档与" +
  "折扣套餐档按时间窗切换。「值得行动 / 需要警惕」请面向：订阅怎么买、免费额度/活动窗口怎么用、" +
  "要不要调整本站在役的模型路由与排程。";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

export interface ScanOptions {
  /** 注入文本拉取（测试/演练）；入参是完整 URL。 */
  fetchText?: (url: string) => Promise<string>;
  /** 注入单条解读（测试）；缺省走 chatJson（免费通道优先）。 */
  digestOne?: (row: Pick<ZhipuUpdateRow, "id" | "kind" | "title" | "payload">) => DigestOutcome | Promise<DigestOutcome>;
  now?: Date;
}

export interface ScanSummary {
  at: string;
  ok: boolean;
  error: string | null;
  sources: number;
  updates: number;
  digested: number;
  pending: number;
  /** ym438：本轮写入的信号→路由动作数（新出刊行 + 存量回填，条件写回零重复）。 */
  actions: number;
  notes: string[];
  errors: string[];
}

/** 单条出刊的大白话解读（免费通道优先：modelFor + chatJson，永不抛错，失败由调用方标 pending）。 */
export async function digestUpdate(row: Pick<ZhipuUpdateRow, "id" | "kind" | "title" | "payload">): Promise<DigestOutcome> {
  try {
    const model = await modelFor("zhipuDigest");
    // 北京日期进材料：活动到期与否要按「今天」判断（提示词铁律 5）。
    const today = beijingDate(Date.now());
    const user = `今天：${today}（北京时间）\n` +
      `信源：智谱开放平台文档站（docs.bigmodel.cn）·「${String(row.payload.sourceLabel ?? "")}」\n` +
      `站长背景：${CONSUMER_CONTEXT}\n` +
      `本期条目：kind=${row.kind}，title=${row.title}，url=${String(row.payload.url ?? "")}\n` +
      `材料原文（唯一事实来源）：\n${String(row.payload.text ?? "")}`;
    const res = await chatJson({
      model,
      purpose: "zhipu_digest",
      subject: `zhipuwatch#${row.id}`,
      promptVersion: ZHIPU_WATCH_PROMPT_VERSION,
      system: SYSTEM,
      user,
      schema: ZhipuDigestSchema,
      temperature: 0.2,
      maxTokens: DIGEST_MAX_TOKENS,
    });
    return { ok: true, digest: res.data, receiptId: res.receiptId, error: null };
  } catch (error) {
    return { ok: false, digest: null, receiptId: null, error: String(error).slice(0, 300) };
  }
}

interface Candidate {
  item: ParsedItem;
  trigger: "baseline" | "new" | "updated";
}

/** 一个定点页的条目差分与出刊。首轮基线：整页条目记水位、只出最新 cap 条（老页不追全历史，
 *  依据=卡面「有料才出刊」+oss 先例，见 artifact decisions.md D2）；增量：只记本轮处理过的条目，
 *  超限留哨兵 hash 下轮续出（绝不静默丢新料），幂等靠 dedup_key 兜底。 */
async function publishPage(
  src: ZhipuSource, items: ParsedItem[], wm: PageWatermark | undefined, pageHash: string,
  marks: ZhipuWatermarks, summary: ScanSummary,
): Promise<ZhipuUpdateRow[]> {
  const known = wm?.items ?? {};
  const baseline = !wm;
  const cap = baseline ? src.baselineCap : INCREMENTAL_CAP;

  let candidates: Candidate[];
  if (baseline) {
    // 全量进候选再按上限截批（overflow 如实计数，供基线截取观察）。
    candidates = items.map((item) => ({ item, trigger: "baseline" as const }));
  } else {
    const fresh = items.filter((it) => !(it.key in known)).map((item) => ({ item, trigger: "new" as const }));
    const updated = items.filter((it) => it.key in known && known[it.key] !== it.hash).map((item) => ({ item, trigger: "updated" as const }));
    candidates = [...fresh, ...updated];
  }

  // 退出清单观察（已知键不在本页了，如活动下线）：只记 note 不出刊（卡面未要求删除追踪）。
  const removed = Object.keys(known).filter((k) => !items.some((it) => it.key === k));
  if (removed.length > 0) summary.notes.push(`${src.key}：${removed.length} 条退出清单（${removed.slice(0, 3).join("、")}${removed.length > 3 ? "…" : ""}）`);

  const batch = candidates.slice(0, cap);
  const overflow = candidates.length - batch.length;
  const rows: ZhipuUpdateRow[] = [];
  for (const { item, trigger } of batch) {
    const row = await insertUpdate({
      kind: src.kind,
      title: item.title,
      url: src.url,
      publishedAt: item.publishedAt,
      dedupKey: `${src.key}|${item.key}|${item.hash}`,
      payload: {
        source: src.key, sourceLabel: src.label, trigger, url: src.url,
        publishedAt: item.publishedAt, text: item.body,
      },
    });
    if (row) rows.push(row); // null = dedup_key 已在库（重跑兜底），零重复
  }

  const nextItems: Record<string, string> = { ...known };
  if (baseline) {
    // 首轮基线：整页条目全部记水位（老页不追全历史，只出最新 cap 条）。
    for (const item of items) nextItems[item.key] = item.hash;
  } else {
    // 增量：只记本轮处理过的条目；超限部分不记（下轮续出，绝不静默丢新料）。
    for (const { item } of batch) nextItems[item.key] = item.hash;
  }
  const fullyProcessed = baseline || overflow === 0;
  marks.pages[src.key] = { hash: fullyProcessed ? pageHash : (wm?.hash ?? ""), items: nextItems };
  if (!baseline && overflow > 0) summary.notes.push(`${src.key}：还有 ${overflow} 条待下轮（每轮上限 ${cap}）`);
  if (baseline && overflow > 0) summary.notes.push(`${src.key}：首轮只出最新 ${cap} 条，其余 ${overflow} 条只记水位（不追全历史）`);
  if (baseline && !marks.baselineAt) marks.baselineAt = summary.at;
  return rows;
}

/** sitemap 差分（新页/改版公告发现）。处理过才推进该 url 的 lastmod；拉取/解析失败保持旧值下轮重试。 */
async function scanSitemap(
  fetchText: (url: string) => Promise<string>,
  marks: ZhipuWatermarks,
  summary: ScanSummary,
  runDigest: (row: ZhipuUpdateRow) => Promise<void>,
  touched: ZhipuUpdateRow[],
): Promise<void> {
  const entries = parseSitemap(await fetchText(ZHIPU_SITEMAP_URL));
  // 定点页已在逐页精细解析，sitemap 对它们的 lastmod 变化不再重复出刊（防同源双发）。
  const fixedUrls = new Set(ZHIPU_SOURCES.map((s) => s.url));
  const watched = entries.filter((e) =>
    WATCHED_PATH_PREFIXES.some((p) => new URL(e.url).pathname.startsWith(p)) && !fixedUrls.has(`${e.url}.md`));
  if (watched.length === 0) throw new Error("sitemap 受盯路径（/cn/update/、/cn/coding-plan/）为 0，前缀面变化");
  const prev = marks.sitemap;
  if (!prev) {
    marks.sitemap = { lastmods: Object.fromEntries(watched.map((e) => [e.url, e.lastmod ?? ""])), baselineAt: summary.at };
    summary.notes.push(`sitemap 首轮基线：受盯路径 ${watched.length} 条记水位（差分自下一轮起）`);
    return;
  }
  const changed = watched.filter((e) => prev.lastmods[e.url] !== (e.lastmod ?? ""));
  if (changed.length === 0) return;
  changed.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  for (const e of changed.slice(0, SITEMAP_PER_RUN_CAP)) {
    try {
      const md = await fetchText(`${e.url}.md`);
      const title = pageTitle(md) ?? e.url;
      const kind: ZhipuKind = e.url.includes("/notice/") ? "plan_promo" : "other";
      const trigger = prev.lastmods[e.url] === undefined ? "new" : "updated";
      const row = await insertUpdate({
        kind, title, url: e.url, publishedAt: e.lastmod,
        dedupKey: `sitemap|${e.url}|${e.lastmod ?? title}`,
        payload: {
          source: "sitemap", sourceLabel: `sitemap 发现：${new URL(e.url).pathname}`, trigger,
          url: e.url, publishedAt: e.lastmod, text: mdPlain(md).slice(0, 1200),
        },
      });
      if (row) {
        summary.updates++;
        touched.push(row);
        await runDigest(row);
      }
      prev.lastmods[e.url] = e.lastmod ?? "";
    } catch (error) {
      summary.errors.push(`sitemap ${new URL(e.url).pathname}: ${String(error).slice(0, 150)}`);
    }
  }
  const rest = changed.length - Math.min(changed.length, SITEMAP_PER_RUN_CAP);
  if (rest > 0) summary.notes.push(`sitemap：还有 ${rest} 条变化待下轮（每轮上限 ${SITEMAP_PER_RUN_CAP}）`);
}

/** 单轮扫描。单页失败不打断其他页（错误进 summary.errors）；全部失败才向上抛由 job_runs 兜底。 */
export async function scanZhipuWatch(opts: ScanOptions = {}): Promise<ScanSummary> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();
  const fetchText = opts.fetchText ?? docsFetchText;
  const digestOne = opts.digestOne ?? digestUpdate;
  const summary: ScanSummary = {
    at: startedAt, ok: false, error: null,
    sources: ZHIPU_SOURCES.length, updates: 0, digested: 0, pending: 0, actions: 0, notes: [], errors: [],
  };

  const runDigest = async (row: ZhipuUpdateRow): Promise<void> => {
    const out = await digestOne(row);
    if (out.ok && out.digest) {
      await saveDigest(row.id, out.digest, out.receiptId ?? 0);
      summary.digested++;
    } else {
      await saveDigestError(row.id, out.error ?? "digest failed");
      summary.pending++;
    }
  };

  /** ym438：本轮新出刊行（信号动作的处理面之一；另一面是存量回填）。 */
  const touched: ZhipuUpdateRow[] = [];

  const attempted = ZHIPU_SOURCES.length + 1; // 5 定点页 + sitemap

  try {
    // 先补上一轮 pending 的解读（水位不动、不出新刊）。
    for (const row of await listPendingUpdates()) await runDigest(row);

    const marks = await getWatermarks();
    for (const src of ZHIPU_SOURCES) {
      try {
        const raw = await fetchText(src.url);
        const pageHash = sha(raw);
        const wm = marks.pages[src.key];
        if (wm && wm.hash === pageHash) continue; // 整页没动：零解析零模型成本
        const items = src.parser(raw); // 解析不出即抛错 → 该页记错误、水位不动
        const rows = await publishPage(src, items, wm, pageHash, marks, summary);
        summary.updates += rows.length;
        for (const row of rows) {
          touched.push(row);
          await runDigest(row);
        }
        await saveWatermarks(marks); // 每页推进一次，进程中断最多丢当页水位（dedup_key 兜底零重复）
      } catch (error) {
        summary.errors.push(`${src.key}: ${String(error).slice(0, 200)}`);
      }
    }

    try {
      await scanSitemap(fetchText, marks, summary, runDigest, touched);
    } catch (error) {
      summary.errors.push(`sitemap: ${String(error).slice(0, 200)}`);
    }
    await saveWatermarks(marks);

    // ym438：信号→路由动作（新出刊行 + 存量未处理行回填；条件写回，同窗重扫零重复动作）。
    // 免费池接入 / 套餐窗规则写入 / 拒写留痕都落行 routing_action；观察进 notes。
    const signals = [...touched, ...(await listRowsMissingRoutingAction(SIGNAL_BACKFILL_CAP))];
    summary.actions = await applySignalActions(signals, { now, note: (t) => summary.notes.push(t) });

    if (summary.errors.length >= attempted) throw new Error(summary.errors[0]!);
    summary.ok = summary.errors.length === 0;
    summary.error = summary.errors[0] ?? null;
    await saveLastRun({
      at: summary.at, ok: summary.ok, error: summary.error,
      sources: summary.sources, updates: summary.updates, digested: summary.digested,
      pending: summary.pending, actions: summary.actions, notes: summary.notes,
    });
    return summary;
  } catch (error) {
    summary.error = String(error).slice(0, 300);
    summary.ok = false;
    await saveLastRun({
      at: summary.at, ok: false, error: summary.error,
      sources: summary.sources, updates: summary.updates, digested: summary.digested,
      pending: summary.pending, actions: summary.actions, notes: summary.notes,
    }).catch(() => {});
    throw error;
  }
}
