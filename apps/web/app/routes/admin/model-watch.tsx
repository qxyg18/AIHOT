// Admin「免费模型信源监控」：OpenRouter 免费（限时零价）模型的发现、24h 观察窗、质量判定
// 与全站路由（命主 2026-10-02：优惠期内免费模型优先支撑本站运行，质量差的只进简单能力位，
// 切换主力时上一任留作替补，免费窗口以价格翻正为准结束并自动回落）。每 24 小时自动扫描
// （每日 06:30），这里可以看现状、立即扫描、人工下判定、开关自动切换与钉选主力。
// 新免费模型同时会上 agent-hub 决策板候拍板（dp1 拍板后自动建「免费模型24小时观察窗」卡），
// 卡的验收结论就在本页「判定」里落。
import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import type { Route } from "./+types/model-watch";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Field, ReasonDialog, Select, Time, type Column } from "../../features/admin/ui";
import { num } from "../../features/admin/format";

interface WatchModel {
  model_id: string;
  name: string;
  vendor: string;
  tier: "promo" | "free_tier";
  context_length: number | null;
  status: "observing" | "vetted" | "simple" | "unusable" | "listed" | "filtered" | "ended";
  free_from: string | null;
  free_until_hint: string | null;
  verdict: "good" | "simple" | "unusable" | null;
  verdict_by: string | null;
  verdict_note: string | null;
  observe_until: string | null;
  probe: { failStreak?: number; json: { ok: boolean; ms: number; error: string | null }; summary: { ok: boolean; ms: number; error: string | null } } | null;
}

interface WatchEvent {
  id: number;
  model_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface Overview {
  configured: boolean;
  routing: { primary: string | null; fallback: string | null; simple: string | null };
  circuit: { open: boolean; until: string | null; reason: string | null };
  /** ym457：智谱免费通道观测三行（熔断 / budgets 用量 / 缺行告警）；旧 API 滚动期可缺省。 */
  zhipu?: {
    circuit: { open: boolean; until: string | null; reason: string | null };
    budget: { service: string; per_minute: number; per_hour: number; per_day: number } | null;
    budgetMissing: boolean;
    used24h: number;
  };
  config: { autoSwitch: boolean; pinned: string | null };
  lastRun: { at: string; ok: boolean; error: string | null; free: number; added: number; ended: number } | null;
  models: WatchModel[];
  events: WatchEvent[];
  counts: { free: number; observing: number; promo: number };
  capability?: {
    qualified: number;
    rejected: number;
    lastTestedAt: string | null;
    recent: Array<{ model_id: string; capability: string; verdict: string; pass_count: number; tested_at: string }>;
  };
  capabilityRoute?: Record<string, Array<{ model: string; vision: boolean; testedAt: string; passCount: number }>>;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Overview>(request, "/api/admin/model-watch");
}

export const meta: Route.MetaFunction = () => [{ title: `免费模型信源监控 · ${SITE.name} 后台` }];

const STATUS_LABEL: Record<WatchModel["status"], string> = {
  observing: "观察窗中",
  vetted: "质量过关",
  simple: "简单档",
  unusable: "不可用",
  listed: "常年免费陈列",
  filtered: "筛选未达标",
  ended: "免费已结束",
};
const STATUS_TONE: Record<WatchModel["status"], "ok" | "warn" | "bad" | "muted" | "accent"> = {
  observing: "warn", vetted: "ok", simple: "accent", unusable: "bad", listed: "muted", filtered: "muted", ended: "muted",
};
const VERDICT_LABEL: Record<string, string> = { good: "良好", simple: "只够简单", unusable: "不可用" };

const KIND_LABEL: Record<string, string> = {
  free_start: "免费开启", free_end: "免费结束", verdict: "自动判定", drift: "质量漂移降级",
  routing: "路由切换", probe: "探针", baseline: "基线登记", scan_error: "扫描失败",
};

export default function ModelWatchAdmin({ loaderData: w }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<WatchModel | null>(null);
  const [choice, setChoice] = useState<"good" | "simple" | "unusable">("good");
  const [pin, setPin] = useState("__none");

  const scan = () => run("POST", "/api/admin/model-watch/scan", undefined, { label: "mw-scan", success: "扫描完成（探针跟 24 小时节奏走，这里不跑）" });
  const toggleAuto = () =>
    run("PUT", "/api/admin/model-watch/config", { autoSwitch: !w.config.autoSwitch }, { label: "mw-auto", success: w.config.autoSwitch ? "已冻结自动切换（维持当前路由）" : "已恢复自动切换" });
  const applyPin = () =>
    run("PUT", "/api/admin/model-watch/config", { pinned: pin === "__none" ? null : pin }, { label: "mw-pin", success: "钉选已更新，立即生效" });

  const route = (id: string) => (id === w.routing.primary ? "主力" : id === w.routing.fallback ? "替补" : id === w.routing.simple ? "简单档" : "");

  const columns: Column<WatchModel>[] = [
    {
      key: "model",
      label: "模型",
      render: (m) => (
        <div>
          <div className="font-mono text-[12.5px] text-ink">{m.model_id}</div>
          <div className="text-[12px] text-ink-4">
            {m.name}
            {m.context_length ? ` · ${m.context_length >= 1e6 ? `${(m.context_length / 1e6).toFixed(1)}M` : `${Math.round(m.context_length / 1000)}k`}` : ""}
            {route(m.model_id) && <span className="ml-1 text-accent">（{route(m.model_id)}）</span>}
          </div>
        </div>
      ),
    },
    {
      key: "tier",
      label: "档",
      render: (m) => (m.tier === "promo" ? <Badge tone="accent">限时免费</Badge> : <Badge>常年免费档</Badge>),
    },
    {
      key: "status",
      label: "状态",
      render: (m) => (
        <div className="grid gap-1">
          <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
          {m.status === "observing" && m.observe_until && <span className="text-[11.5px] text-ink-4">窗至 {String(m.observe_until).slice(5, 16).replace("T", " ")}</span>}
          {m.status === "filtered" && m.verdict_note && <span className="text-[11.5px] text-ink-4">{m.verdict_note}</span>}
        </div>
      ),
    },
    {
      key: "window",
      label: "免费窗口",
      render: (m) => (
        <div className="text-[12.5px]">
          <div>{m.free_from ? String(m.free_from).slice(0, 10) : "—"} 起</div>
          <div className="text-ink-4">{m.tier === "free_tier" ? "无到期（限流档）" : m.free_until_hint ? `公告至 ${m.free_until_hint}（以价格为准）` : "持续监控，价格翻正即到期"}</div>
        </div>
      ),
    },
    {
      key: "quality",
      label: "质量",
      render: (m) => (
        <div className="grid gap-1 text-[12px]">
          {m.verdict ? (
            <span>{VERDICT_LABEL[m.verdict]} <span className="text-ink-4">（{m.verdict_by}）</span></span>
          ) : (
            <span className="text-ink-4">待判定</span>
          )}
          {m.probe && (
            <span className={m.probe.json.ok && m.probe.summary.ok ? "text-ok" : "text-ink-4"}>
              探针：结构 {m.probe.json.ok ? "过" : "挂"} / 摘要 {m.probe.summary.ok ? "过" : "挂"}
              {m.probe.failStreak ? ` · 连挂 ${m.probe.failStreak} 轮` : ""}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "人工判定",
      render: (m) =>
        m.status === "ended" ? (
          <span className="text-[12px] text-ink-4">已结束</span>
        ) : (
          <Button size="sm" tone="ghost" onClick={() => { setTarget(m); setChoice(m.verdict ?? "good"); }}>
            判定
          </Button>
        ),
    },
  ];

  return (
    <AdminPage
      title="免费模型信源监控"
      subtitle="盯 OpenRouter 的限时免费模型（只启用上下文 ≥1M 的，命中主口径 2026-10-02）：新窗口自动进 24 小时观察窗（探针打结构化+摘要两关）；过关的当全站主力，质量差的只进简单能力位（预筛/摘要/结构抽取）；切换主力时上一任留作替补；窗口结束（价格翻正）自动回落常规路由。每 24 小时自动扫描（每日 06:30），显式的后台/环境指派永远优先。"
    >
      <div className="grid gap-5">
        <Card
          title="当前路由"
          right={<Button busy={pending === "mw-scan"} onClick={scan}>立即扫描</Button>}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-[12px] text-ink-4">主力免费模型{!w.configured && "（未配置 OPENROUTER_API_KEY，路由不生效）"}</div>
              <div className="mt-1 font-mono text-[12.5px] text-ink">{w.routing.primary ?? "（无，全站走常规路由）"}</div>
            </div>
            <div>
              <div className="text-[12px] text-ink-4">替补（上一任）</div>
              <div className="mt-1 font-mono text-[12.5px] text-ink">{w.routing.fallback ?? "（无）"}</div>
            </div>
            <div>
              <div className="text-[12px] text-ink-4">简单档</div>
              <div className="mt-1 font-mono text-[12.5px] text-ink">{w.routing.simple ?? "（无）"}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[12.5px] text-ink-3">
            {w.circuit.open ? <Badge tone="bad">熔断中 · 至 {String(w.circuit.until).slice(11, 16)}（{w.circuit.reason?.slice(0, 60)}）</Badge> : <Badge tone="ok">熔断关闭</Badge>}
            <span>上次扫描：</span><Time at={w.lastRun?.at ?? null} />
            {w.lastRun && <span>{w.lastRun.ok ? `免费 ${w.lastRun.free} 个（新增 ${w.lastRun.added} / 结束 ${w.lastRun.ended}）` : `失败：${w.lastRun.error?.slice(0, 80)}`}</span>}
            <span className="text-ink-4">监控中 {w.counts.free} 个 · 观察窗 {w.counts.observing} 个 · 限时免费 {w.counts.promo} 个</span>
          </div>
          {w.zhipu && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[12.5px] text-ink-3">
              <span className="text-ink-4">智谱免费通道</span>
              {w.zhipu.circuit.open ? (
                <Badge tone="bad">熔断中 · 至 {String(w.zhipu.circuit.until).slice(11, 16)}（{w.zhipu.circuit.reason?.slice(0, 60)}）</Badge>
              ) : (
                <Badge tone="ok">熔断关闭</Badge>
              )}
              <span>
                近 24 小时用量 <span className="num">{num(w.zhipu.used24h)}</span> / 上限{" "}
                <span className="num">{w.zhipu.budget ? num(w.zhipu.budget.per_day) : "—"}</span>（每日）
              </span>
              {w.zhipu.budgetMissing ? (
                <Badge tone="bad">budgets 缺行 · 免费调用被拒发（fail-closed）</Badge>
              ) : (
                <Badge tone="ok">budgets 行在位</Badge>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
            <Button tone="ghost" busy={pending === "mw-auto"} onClick={toggleAuto}>{w.config.autoSwitch ? "冻结自动切换" : "恢复自动切换"}</Button>
            <Field label="钉选主力（免观察窗，仍要求免费期内）">
              <div className="flex items-center gap-2">
                <Select value={pin} onChange={(e) => setPin(e.target.value)}>
                  <option value="__none">（不钉选，自动选任）</option>
                  {w.models.filter((m) => m.status !== "ended" && m.status !== "unusable").map((m) => (
                    <option key={m.model_id} value={m.model_id}>{m.model_id}</option>
                  ))}
                </Select>
                <Button tone="ghost" busy={pending === "mw-pin"} onClick={applyPin}>应用</Button>
              </div>
            </Field>
            {w.config.pinned && <span className="text-[12px] text-ink-4">当前钉选：<span className="font-mono">{w.config.pinned}</span></span>}
          </div>
        </Card>

        <Card title="模型清单">
          <DataTable rows={w.models} columns={columns} rowKey={(m) => m.model_id} empty="还没有扫到免费模型（等下一轮 24 小时扫描，或点「立即扫描」）" />
        </Card>

        <Card title="能力级验收路由（ym196：分能力 10 次测试+付费判卷，≥9/10 合格进路由；付费=断链过渡档）">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-3">
            <span>合格 <span className="num text-ok">{w.capability?.qualified ?? 0}</span> 项</span>
            <span>不合格 <span className="num text-amber">{w.capability?.rejected ?? 0}</span> 项</span>
            <span className="text-ink-4">最近验收：<Time at={w.capability?.lastTestedAt ?? null} /></span>
            <span className="text-ink-4">滚动批每晚 23:40（每轮 8 组合，未测优先、7 天复测）</span>
          </div>
          {(w.capability?.recent?.length ?? 0) > 0 && (
            <div className="mt-3 grid gap-1 border-t border-line pt-3">
              {w.capability!.recent.map((r, i) => (
                <div key={i} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                  <Time at={r.tested_at} />
                  <span className="font-mono text-ink-3">{r.model_id}</span>
                  <Badge>{r.capability}</Badge>
                  <span className={r.verdict === "qualified" ? "text-ok" : "text-amber"}>{r.verdict === "qualified" ? `合格 ${r.pass_count}/10` : `不合格 ${r.pass_count}/10`}</span>
                </div>
              ))}
            </div>
          )}
          {Object.keys(w.capabilityRoute ?? {}).length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-1 text-[12px] text-ink-4">现役能力路由（合格模型按验收时间倒序，路由取第一个 vision 匹配的）</div>
              {Object.entries(w.capabilityRoute!).map(([cap, routes]) => (
                <div key={cap} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                  <Badge tone="accent">{cap}</Badge>
                  <span className="font-mono text-ink-3">{routes.map((r) => r.model).join(" → ")}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="事件流水">
          <div className="grid gap-1.5">
            {w.events.length === 0 && <div className="text-[13px] text-ink-4">暂无事件</div>}
            {w.events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                <Time at={e.created_at} />
                <Badge>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                <span className="font-mono text-[12px] text-ink-3">{e.model_id || "（全局）"}</span>
                <span className="text-ink-4">{JSON.stringify(e.payload).slice(0, 120)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`人工判定：${target?.model_id ?? ""}`}
        description="人工结论优先于 24h 观察窗（也可越过 1M 上下文线）：良好=可当全站主力；只够简单=仅预筛/摘要/结构抽取三个能力位；不可用=完全不路由。判定后立即重算路由。"
        confirmLabel="落判定"
        busy={pending === "mw-verdict"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) => {
          if (!target) return;
          const ok = await run("POST", `/api/admin/model-watch/models/${encodeURIComponent(target.model_id)}/verdict`, { verdict: choice, note: reason }, { label: "mw-verdict", success: "判定已落，路由已重算" });
          if (ok !== null) setTarget(null);
        }}
      >
        <Field label="结论">
          <Select value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
            <option value="good">良好（当主力）</option>
            <option value="simple">只够简单（简单能力位）</option>
            <option value="unusable">不可用（不路由）</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
