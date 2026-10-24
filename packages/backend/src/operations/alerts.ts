// Operations alerts. The person reading them is the site owner, not an engineer: each
// message says what readers see, whether it heals by itself and what, if anything, the owner must do.
//   now    — readers are affected and it has not healed: sent at once, repeated hourly, recovery reported.
//   today  — money at risk or only the owner can act: sent at once, repeated at most daily, recovery reported.
//   digest — follow-ups without reader impact: one 09:00 message a day, meant to be handed to the AI.
// Delivery goes through sendAlert (ops chat, internal-chat fallback; off unless FEISHU_INTERNAL_ENABLED).
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { beijingDay, beijingStamp, duration, formatAlert, formatRecovery, sendAlert, type Finding, type Level } from "../notify/feishu.ts";
import { backupConfigured } from "./backup.ts";
import { envPositiveNumber } from "./env-number.ts";
import { zhipuCircuitState } from "../providers/zhipu.ts";
import { openRouterCircuitState } from "../modelwatch/routing.ts";

const REPEAT_MS: Record<Exclude<Level, "digest">, number> = { now: 3600_000, today: 24 * 3600_000, later: 7 * 24 * 3600_000 };

const collecting = () => process.env.COLLECT_ENABLED !== "false";
const modelsOn = () => process.env.MODEL_CALLS_ENABLED !== "false";
/** How long the site may go without a new article before it counts as stalled (small source lists are quieter). */
const QUIET_MS = envPositiveNumber("ALERT_QUIET_MINUTES", 360) * 60_000;

/** Everything wrong right now, with its level. */
export async function collectFindings(now = Date.now()): Promise<Finding[]> {
  const out: Finding[] = [];

  // ---- Readers affected now ----------------------------------------------------------------------
  // Content flow, judged by outcome: whatever broke (worker, egress proxy, models, queues), readers see
  // a site that stops changing. Skipped for 20 minutes after the worker starts, and where the valves are off.
  const [hb] = await sql<{ value: { startedAt?: string } }[]>`SELECT value FROM settings WHERE key = 'heartbeat.worker'`;
  const settled = !hb?.value.startedAt || now - Date.parse(hb.value.startedAt) > 20 * 60_000;
  if (settled && collecting()) {
    const [last] = await sql<{ at: Date | null }[]>`SELECT max(discovered_at) AS at FROM articles WHERE discovered_at > ${new Date(now - 4 * QUIET_MS)}`;
    const [anySource] = await sql`SELECT 1 FROM sources WHERE enabled LIMIT 1`;
    if (anySource && (!last?.at || now - last.at.getTime() > QUIET_MS)) {
      out.push({
        key: "content.collect",
        level: "now",
        title: "网站停止收录新内容",
        impact: last?.at ? `最后一篇新文章收录于 ${beijingStamp(last.at)}，之后网站不会出现新内容` : "很久没有收录任何新文章",
        heals: "没有",
        action: "转给 AI 立即处理",
        detail: `articles.discovered_at 超过 ${Math.round(QUIET_MS / 60_000)} 分钟没有新值（ALERT_QUIET_MINUTES）；查 sources.schedule、出网代理与采集失败`,
        since: last?.at ?? undefined,
      });
    }
  }
  if (settled && collecting() && modelsOn()) {
    const [p] = await sql<{ waiting: number; oldest: Date | null; failed: number }[]>`
      SELECT count(*) FILTER (WHERE processing_state = 'new' AND discovered_at < now() - interval '2 hours')::int AS waiting,
             min(discovered_at) FILTER (WHERE processing_state = 'new') AS oldest,
             count(*) FILTER (WHERE processing_state = 'failed' AND discovered_at > now() - interval '3 hours')::int AS failed
      FROM articles WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '2 days'`;
    if (p!.waiting >= 10 || p!.failed >= 20) {
      const errors = await sql<{ error: string; n: number }[]>`
        SELECT left(coalesce(processing_error, '（无）'), 120) AS error, count(*)::int AS n FROM articles
        WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '3 hours' AND processing_error IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 3`;
      out.push({
        key: "content.process",
        level: "now",
        title: "新内容卡住了，进不了网站",
        impact: [p!.waiting >= 10 && `${p!.waiting} 篇新文章等了 2 小时以上还没处理完`, p!.failed >= 20 && `最近 3 小时 ${p!.failed} 篇新文章处理失败`]
          .filter(Boolean)
          .join("；") + "，精选和热点会缺内容",
        heals: p!.waiting >= 10 ? "服务恢复后会自动补处理" : "不会，需要修好后重新处理这些文章",
        action: "转给 AI 处理",
        detail: errors.map((e) => `${e.error}（${e.n}）`).join("；") || "没有记录错误",
        since: p!.waiting >= 10 && p!.oldest ? p!.oldest : undefined,
      });
    }
    // The daily report is composed at 07:10 and caught up hourly.
    if (Number(beijingTime(now).slice(0, 2)) >= 10) {
      const [r] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${beijingDate(now)}`;
      if (!r) {
        out.push({
          key: "report.daily",
          level: "now",
          title: "今天的日报还没生成",
          impact: "读者看不到今天的日报",
          heals: "系统每小时补做一次，到现在还没成功",
          action: "转给 AI 处理",
          detail: `reports daily ${beijingDate(now)} 不存在；看 reports.daily / reports.catch-up 的运行记录`,
        });
      }
    }
  }

  // ---- Money, and things only the owner can do --------------------------------------------------
  out.push(...(await providerFindings()));

  // Content-group pushes the Feishu webhook refused (a removed bot, a changed address); nothing resends them.
  const [refused] = await sql<{ n: number; target: string | null; response: string | null }[]>`
    SELECT count(*)::int AS n, max(t.note) AS target, left(max(d.response), 200) AS response FROM deliveries d JOIN notify_targets t ON t.key = d.target_key
    WHERE d.status = 'failed' AND d.updated_at > now() - interval '1 day'`;
  if (refused!.n > 0) {
    out.push({
      key: "deliveries.failed",
      level: "today",
      title: "飞书内容群有推送没发出去",
      impact: `过去 24 小时 ${refused!.n} 条精选或重置通知没进${refused!.target ?? "内容群"}`,
      heals: "不会自动重发",
      action: "转给 AI 处理；如果推送机器人被移出了群，需要你把它加回去",
      detail: refused!.response ?? "",
    });
  }

  // Reset monitor: posts are recognized in order, so one that keeps failing holds up every later one.
  const [stuck] = await sql<{ url: string; collected_at: Date; failures: { count: number; error?: string } | null }[]>`
    SELECT p.url, p.collected_at, s.value AS failures FROM monitor_posts p LEFT JOIN monitor_state s ON s.key = 'failures:' || p.id
    WHERE p.processed_at IS NULL ORDER BY p.published_at, p.id LIMIT 1`;
  if (stuck && now - stuck.collected_at.getTime() > 60 * 60_000) {
    out.push({
      key: "monitor.stuck",
      level: "today",
      title: "Codex 重置监控卡住了",
      impact: "新的重置消息确认不了，内容群收不到重置通知",
      heals: "暂时没有",
      action: "转给 AI 处理",
      detail: `${stuck.url} 等待 ${duration(now - stuck.collected_at.getTime())}${stuck.failures ? `，识别失败 ${stuck.failures.count} 次：${stuck.failures.error ?? ""}` : ""}；后台“Codex 重置 → 帖子与识别 → 待识别”可跳过`,
      since: stuck.collected_at,
    });
  }
  // Claims held back from a post (a quote not in it, an unsure confirmation) wait for a person.
  const held = await sql<{ url: string }[]>`
    SELECT url FROM monitor_posts WHERE processed_at > ${new Date(now - 48 * 3600_000)} AND jsonb_array_length(coalesce(recognition->'held', '[]'::jsonb)) > 0
      AND (recognition->>'reviewed')::boolean IS NOT TRUE ORDER BY published_at DESC LIMIT 5`;
  if (held.length) {
    out.push({
      key: "monitor.review",
      level: "today",
      title: "有 Codex 重置消息需要你确认",
      impact: "系统对这几条帖子的判断没把握，结论暂时没有生效，也没有推送",
      heals: "不会",
      action: "到后台“Codex 重置 → 帖子与识别 → 需复核”看一下；确认后需要的话在群里说明",
      detail: held.map((h) => h.url).join(" "),
    });
  }

  if (backupConfigured()) {
    const [b] = await sql<{ value: { at: string; uploaded: boolean; filesError?: string } }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
    const age = b ? now - Date.parse(b.value.at) : Infinity;
    const state = b?.value.filesError ? `数据库已上传，附件打包失败：${b.value.filesError}` : b?.value.uploaded === false ? "未上传" : "";
    if (b?.value.uploaded && age > 50 * 3600_000) {
      out.push({
        key: "backup.failed",
        level: "today",
        title: "数据库备份连续两天没成功",
        impact: "平时没有影响；万一服务器出事，最多会丢两天的数据",
        heals: "不会",
        action: "转给 AI 处理",
        detail: `最近一次成功 ${beijingStamp(b.value.at)}；看 ops.backup 的运行记录`,
        since: new Date(b.value.at),
      });
    } else if (!b || !b.value.uploaded || age > 30 * 3600_000) {
      out.push({ key: "backup.stale", level: "digest", title: "数据库备份超过一天没成功", detail: b ? `最近一次 ${beijingStamp(b.value.at)}${state ? `（${state}）` : ""}；看 ops.backup` : "还没有成功的备份记录" });
    }
  }

  // ---- Follow-ups for the daily digest ------------------------------------------------------------
  const [r] = await sql<{ receipts: number; services: string | null; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS receipts,
           (SELECT string_agg(DISTINCT service || '/' || purpose, '、') FROM receipts WHERE status = 'unknown') AS services,
           (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS deliveries`;
  if (r!.receipts > 0) {
    out.push({ key: "receipts.unknown", level: "digest", title: `${r!.receipts} 个付费请求自动重试过一次，结果仍未知`, detail: `${r!.services}；后台“运行”页核对后放行` });
  }
  if (r!.deliveries > 0) out.push({ key: "deliveries.unknown", level: "digest", title: `${r!.deliveries} 条飞书内容群推送不确定是否送达`, detail: "后台“运行”页核对群里有没有，再标记或重发" });

  // ym438：免费通道每日可观测（承接次数/占比/证书覆盖/池水位），有模型调用即出一行。
  const free = await freeChannelDigest(now);
  if (free) out.push(free);
  // ym438：窗口公告解析歧义未自动写（S03「即人工候裁」的露出面）。窗口候选面=free_window 定点页
  // 与 /notice/ 公告页（与 signals.classifyItem 同口径；ym438 首日实锚：改版后的 usage-revision
  // 公告正是一例歧义）。静默判定=歧义的「动作时刻」（routing_action.at——存量回填行的动作时刻
  // ≠行 created_at，ym438 首日实锚踩中）已被更新的窗口规则取代（人工写 manual 或后续解析成功
  // 写入）——否则未处置会一直提醒，已处置不纠缠。
  const [wr] = await sql<{ title: string; url: string; reason: string | null }[]>`
    SELECT title, url, routing_action->>'reason' AS reason FROM zhipu_updates wr
    WHERE wr.routing_action->>'action' = 'window_refused'
      AND (wr.kind = 'free_window' OR (wr.kind = 'plan_promo' AND wr.url LIKE '%/notice/%'))
      AND NOT EXISTS (
        SELECT 1 FROM settings s WHERE s.key = 'zhipu.plan_window'
          AND (s.value->>'updatedAt')::timestamptz > (wr.routing_action->>'at')::timestamptz)
    ORDER BY (wr.routing_action->>'at')::timestamptz DESC LIMIT 1`;
  if (wr) {
    out.push({
      key: "zhipuwatch.window_manual",
      level: "digest",
      title: "智谱窗口公告的日期解析不了，窗口规则需要人工确认",
      detail: `《${wr.title}》：${wr.reason ?? "解析歧义"}；确认后把口径写进 settings 键 zhipu.plan_window（mode=manual），自动解析就不会再覆盖`,
    });
  }

  // Runnable jobs (deferred ones excluded) that have waited more than two hours.
  const queues = await sql<{ name: string; n: number; oldest: Date }[]>`
    SELECT name, count(*)::int AS n, min(start_after) AS oldest FROM pgboss.job
    WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT LIKE 'cron.%' GROUP BY 1`;
  for (const q of queues) {
    if (now - q.oldest.getTime() > 2 * 3600_000) {
      out.push({ key: `queue.${q.name}`, level: "digest", title: `后台任务排队超过 2 小时：${q.name}`, detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}` });
    }
  }

  // A leaderboard source keeps its last snapshot while failing.
  const [lb] = await sql<{ value: { sources?: Record<string, { ok: boolean; lastOkAt: string | null; error?: string }> } }[]>`SELECT value FROM settings WHERE key = 'leaderboard.fetch'`;
  const stale = Object.entries(lb?.value.sources ?? {}).filter(([, s]) => !s.ok && s.lastOkAt && now - Date.parse(s.lastOkAt) > 26 * 3600_000);
  if (stale.length) {
    out.push({
      key: "leaderboard.fetch",
      level: "digest",
      title: `模型榜有 ${stale.length} 个评测来源超过一天没抓到，榜单暂用上一份数据`,
      detail: stale.slice(0, 6).map(([k, s]) => `${k}：${s.error ?? "失败"}（上次成功 ${beijingStamp(s.lastOkAt!)}）`).join("；"),
    });
  }

  // 精选干旱：收录和处理照常、但评分链整体退化时（模型路由劣化、门槛与通道错配、免费档
  // 静默断供），首页可以数天没有新入选而上面任何一条都不响（2026-10-16…21 迁云窗口实例）。
  // 只在收录仍在进新文章时判，收录停摆由 content.collect 报；digest 起步观察误报率，稳了再议调级。
  if (collecting() && modelsOn()) {
    const DROUGHT_MS = envPositiveNumber("ALERT_SELECTED_DROUGHT_HOURS", 36) * 3600_000;
    const [drought] = await sql<{ at: Date | null; fresh: number }[]>`
      SELECT (SELECT max(selected_ready_at) FROM publications WHERE selected) AS at,
             (SELECT count(*)::int FROM articles WHERE discovered_at > now() - interval '6 hours') AS fresh`;
    if (drought?.at && drought.fresh > 0 && now - drought.at.getTime() > DROUGHT_MS) {
      out.push({
        key: "content.selected",
        level: "digest",
        title: "首页精选很久没有新入选",
        detail: `最近一次入选 ${beijingStamp(drought.at)}，近 6 小时仍收录了 ${drought.fresh} 篇；评分链疑似整体退化（模型路由/门槛/通道），对照今日 analyses 的评分分布排查（ym768）`,
      });
    }
  }

  return out;
}

const MODEL_STOPS = "用到这家模型的步骤停了（看后台“模型与评测”），新内容可能进不了精选";
const PROVIDERS: Record<string, { name: string; stops: string; where: string }> = {
  llm: { name: "默认模型服务", stops: "新文章的精选、摘要、归组和日报停了", where: "模型服务商的控制台" },
  zhipu: { name: "智谱", stops: MODEL_STOPS, where: "智谱开放平台" },
  dashscope: { name: "阿里云百炼", stops: MODEL_STOPS, where: "阿里云百炼控制台" },
  deepseek: { name: "DeepSeek", stops: MODEL_STOPS, where: "DeepSeek 开放平台" },
  mimo: { name: "小米 MiMo", stops: MODEL_STOPS, where: "小米 MiMo 开放平台" },
  socialdata: { name: "SocialData", stops: "X（推特）上的新内容收不到", where: "SocialData 后台" },
  jina: { name: "Jina", stops: "部分文章取不到正文", where: "Jina 后台" },
  dajiala: { name: "极致了（Dajiala）", stops: "公众号新文章收不到", where: "极致了后台" },
};
export const providerName = (service: string) => PROVIDERS[service]?.name ?? service;
export const providerStops = (service: string) => PROVIDERS[service]?.stops ?? "相关功能停了";
export const providerConsole = (service: string) => PROVIDERS[service]?.where ?? `${service} 后台`;

/** Paid services that refuse us (no balance, a dead key), and daily budgets used up. */
async function providerFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const refused = await sql<{ service: string; n: number; last: string }[]>`
    SELECT service, count(*)::int AS n, (array_agg(left(error, 200) ORDER BY started_at DESC))[1] AS last FROM receipt_attempts
    WHERE status = 'failed' AND started_at > now() - interval '1 hour'
      AND error ~* '(HTTP 40[123]\\M|insufficient|balance|arrear|good standing|欠费|余额)'
    GROUP BY 1 HAVING count(*) >= 3`;
  for (const p of refused) {
    out.push({
      key: `provider.refused.${p.service}`,
      level: "today",
      title: `${providerName(p.service)} 拒绝服务，可能欠费或账号失效`,
      impact: providerStops(p.service),
      heals: "不会",
      action: `去${providerConsole(p.service)}看余额和账号状态；充值或恢复后系统会自动继续`,
      detail: `最近 1 小时被拒 ${p.n} 次：${p.last}`,
    });
  }
  const capped = await sql<{ service: string; per_day: number; used: number }[]>`
    SELECT b.service, b.per_day, count(a.id)::int AS used FROM budgets b
    JOIN receipt_attempts a ON a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day'
    WHERE b.per_day > 0 GROUP BY 1, 2 HAVING count(a.id) >= b.per_day`;
  for (const c of capped) {
    out.push({
      key: `budget.day.${c.service}`,
      level: "today",
      title: `${providerName(c.service)} 过去 24 小时的调用额度用完了`,
      impact: `${providerStops(c.service)}，直到额度随时间腾出来`,
      heals: "会，额度按 24 小时滚动恢复",
      action: "这次不用处理；如果经常出现，再决定要不要调高额度",
      detail: `24 小时内 ${c.used} 次，上限 ${c.per_day}（budgets 表）`,
    });
  }
  return out;
}

/** ym438/ym472 免费通道日报行（S04「免费通道每日满载可观测」）：过去 24 小时
 *  zhipu-free+openrouter+opencode-free 承接次数与占全部实时调用的比例、合格证书覆盖的能力
 *  位数、OpenRouter 池水位（对照 budgets 日限）与熔断状态。口径：origin=live 且按类统一剔除
 *  验收/演练调用（一类一策，ym472；三通道分子同窗剔除）——free_capability_test=能力验收轮
 *  （shoumen P2-1 销项·承接面=业务流量）、modelwatch.certify.*=第三方通道认证批（ym467
 *  opencode 认证）、*.drill=演练（ym467.drill，智谱侧 2 条同剔）；OpenRouter 池水位按 budgets
 *  实际计数口径含验收，与真实限额对齐，故单独子查询不过该过滤。 */
async function freeChannelDigest(now: number): Promise<Finding | null> {
  const [calls] = await sql<{ zhipu: number; openrouter: number; opencode: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE a.service = 'zhipu-free')::int AS zhipu,
           count(*) FILTER (WHERE a.service = 'openrouter')::int AS openrouter,
           count(*) FILTER (WHERE a.service = 'opencode-free')::int AS opencode,
           count(*)::int AS total
    FROM receipt_attempts a JOIN receipts rc ON rc.id = a.receipt_id
    WHERE a.origin = 'live'
      AND rc.purpose <> 'free_capability_test'
      AND rc.purpose NOT LIKE 'modelwatch.certify.%'
      AND rc.purpose NOT LIKE '%.drill'
      AND a.started_at > ${new Date(now - 24 * 3600_000)}`;
  if (!calls || calls.total === 0) return null;
  const free = calls.zhipu + calls.openrouter + calls.opencode;
  const share = Math.round((free / calls.total) * 100);
  const [certs] = await sql<{ zhipu: number; openrouter: number; total: number }[]>`
    SELECT count(DISTINCT c.capability) FILTER (WHERE c.model_id LIKE 'zhipu:%')::int AS zhipu,
           count(DISTINCT c.capability) FILTER (WHERE c.model_id NOT LIKE 'zhipu:%')::int AS openrouter,
           count(DISTINCT c.capability)::int AS total
    FROM model_free_capabilities c JOIN model_watch_models m ON m.model_id = c.model_id
    WHERE c.verdict = 'qualified' AND m.status NOT IN ('ended', 'filtered')`;
  const [orBudget] = await sql<{ per_day: number; used: number }[]>`
    SELECT b.per_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '24 hours') AS used
    FROM budgets b WHERE b.service = 'openrouter'`;
  const parts = [
    `智谱免费 ${calls.zhipu} 次、OpenRouter ${calls.openrouter} 次、opencode ${calls.opencode} 次，合计 ${free}/${calls.total}（占 ${share}%）`,
    `合格证书覆盖 ${certs!.total} 个能力位（智谱 ${certs!.zhipu} / OpenRouter ${certs!.openrouter}）`,
  ];
  if (orBudget && orBudget.per_day > 0) {
    const ratio = orBudget.used / orBudget.per_day;
    parts.push(`OpenRouter 池 ${orBudget.used}/${orBudget.per_day}${ratio >= 1 ? "（已耗尽，等 24 小时滚动恢复）" : ratio >= 0.8 ? "（接近上限）" : ""}`);
  } else if (!orBudget) {
    parts.push("OpenRouter 无 budgets 日限行（免费调用会被 fail-closed 拒发，查 budgets 表）");
  }
  const zc = await zhipuCircuitState();
  if (zc.open) parts.push(`智谱通道熔断中（至 ${beijingStamp(zc.until!)}：${zc.reason ?? ""}）`);
  const oc = await openRouterCircuitState();
  if (oc.open) parts.push(`OpenRouter 熔断中（至 ${beijingStamp(oc.until!)}：${oc.reason ?? ""}）`);
  return {
    key: "free.share",
    level: "digest",
    title: `免费通道过去 24 小时承接 ${free} 次调用（占 ${share}%）${share === 0 ? "，一个免费调用都没有" : ""}`,
    detail: parts.join("；"),
  };
}

interface AlertState {
  [key: string]: { title: string; level?: Level; since: string; sentAt: string };
}

/** Every 10 minutes: new problems and recoveries of the now/today levels go out; digest items wait for 09:00. */
export async function checkAlerts(now = Date.now()) {
  const found = (await collectFindings(now)).filter((f) => f.level !== "digest");
  const [row] = await sql<{ value: AlertState }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  const state: AlertState = { ...(row?.value ?? {}) };
  const sent: string[] = [];
  for (const f of found) {
    const level = f.level as Exclude<Level, "digest">;
    const open = state[f.key]?.level ? state[f.key] : undefined;
    if (open && now - Date.parse(open.sentAt) <= REPEAT_MS[level]) continue;
    const since = open ? new Date(open.since) : (f.since ?? new Date(now));
    const msg = formatAlert(f, since, now, !!open);
    await sendAlert(msg.title, msg.lines);
    state[f.key] = { title: f.title, level, since: since.toISOString(), sentAt: new Date(now).toISOString() };
    sent.push(f.key);
  }
  for (const key of Object.keys(state)) {
    if (found.some((f) => f.key === key)) continue;
    // Entries without a level predate this scheme (2026-09-29) and close without a message.
    if (state[key]!.level) {
      const msg = formatRecovery(state[key]!.title, new Date(state[key]!.since), now);
      await sendAlert(msg.title, msg.lines);
      sent.push(`${key}:recovered`);
    }
    delete state[key];
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json(state as never)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return { open: Object.keys(state), sent };
}

/** 09:00: one message with the follow-ups that do not touch readers; nothing when there are none. */
export async function sendDigest(now = Date.now()) {
  const items = (await collectFindings(now)).filter((f) => f.level === "digest");
  const lines = items.map((f, i) => `${i + 1}. ${f.title}${f.detail ? `\n   ${f.detail}` : ""}`);
  if (!lines.length) return { items: 0 };
  await sendAlert(`📋 系统日报 · ${beijingDay(now)}`, ["以下事项不影响读者，你不用处理；需要的话把整条转给 AI。", ...lines]);
  return { items: lines.length };
}

/** A follow-up someone judged not worth fixing: who, when and why (upstream port for ops/reports). */
export interface DismissedFollowUp { title: string; reason: string; by: string; at: string }

/** The follow-ups closed as not to be fixed, by key. */
async function savedDismissals(): Promise<Record<string, DismissedFollowUp>> {
  const [row] = await sql<{ value: Record<string, DismissedFollowUp> }[]>`SELECT value FROM settings WHERE key = 'alerts.dismissed'`;
  return row?.value ?? {};
}

/** Only observations covered by the closure stay quiet; a new failure reopens the same key. */
export async function dismissedFollowUps(findings?: Array<{ key: string; observedAt?: Date | null }>): Promise<Record<string, DismissedFollowUp>> {
  const current = findings ?? [];
  return Object.fromEntries(Object.entries(await savedDismissals()).filter(([key, closed]) => {
    const finding = current.find((f) => f.key === key);
    return finding && (!finding.observedAt || finding.observedAt.getTime() <= Date.parse(closed.at));
  }));
}
