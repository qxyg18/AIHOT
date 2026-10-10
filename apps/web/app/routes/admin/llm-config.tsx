// Admin "API 接口": the default model endpoint (base URL, key, model) configured from the admin UI,
// plus the unified API router (owner directive 2026-10-05): a weighted provider chain per module —
// 免费模型池 > MIMO > GLM by default — that switches on breaks / 5-minute error streaks / quota
// exhaustion and resets to the first provider every quota day (UTC, 08:00 Beijing). Weights and the
// free daily cap are editable here and apply to the next call (≤1 min cache).
import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import type { Route } from "./+types/llm-config";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Field, Input } from "../../features/admin/ui";

interface LlmConfig {
  effective: {
    baseUrl: string | null;
    apiKey: string | null;
    model: string;
    sources: { baseUrl: "admin" | "file"; apiKey: "admin" | "file"; model: "admin" | "file" };
  };
  configured: {
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };
}

interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  model: string;
  baseUrl: string;
  reply: string | null;
  error: string | null;
  ms: number;
}

interface RouterProvider {
  key: "free" | "mimo" | "glm";
  label: string;
  modelKey: string;
  weight: number;
  configured: boolean;
  usable: boolean;
  todayCount: number;
  down: boolean;
  downAt: string | null;
  reason: string | null;
}

interface ApiRouter {
  config: { enabled: boolean; weights: Record<"free" | "mimo" | "glm", number>; freeDailyCap: number; updatedAt: string | null; updatedBy: string | null };
  providers: RouterProvider[];
  freePool: Array<{ model: string; todayCount: number; exhausted: boolean }>;
  todayFreeTotal: number;
}

export async function loader({ request }: Route.LoaderArgs) {
  const [llm, router] = await Promise.all([
    adminGet<LlmConfig>(request, "/api/admin/llm-config"),
    adminGet<ApiRouter>(request, "/api/admin/api-router"),
  ]);
  return { llm, router };
}

export const meta: Route.MetaFunction = () => [{ title: `API 接口 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台配置", file: "环境文件" } as const;

export default function LlmConfigAdmin({ loaderData }: Route.ComponentProps) {
  const c = loaderData.llm;
  const r = loaderData.router;
  const { run, pending } = useAdminAction();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [weights, setWeights] = useState(r.config.weights);
  const [cap, setCap] = useState(String(r.config.freeDailyCap));

  const save = () =>
    run("PUT", "/api/admin/llm-config", {
      // Empty fields are simply not stored: a value stays until it is overwritten by a new one.
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    }, { label: "llm-config-save", success: "已保存，立即生效（后续新调用走新配置）" })
      .then(() => { setBaseUrl(""); setApiKey(""); setModel(""); });

  const clearAll = () =>
    // The explicit signal keeps "clear everything" separate from a plain empty save, which merges.
    run("PUT", "/api/admin/llm-config", { clear: true }, { label: "llm-config-clear", success: "后台配置已清空，回到环境文件的值" });

  const runTest = async () => {
    setTest(null);
    const res = await run<TestResult>("POST", "/api/admin/llm/test", undefined, { label: "llm-test", revalidate: false });
    if (res) setTest(res);
  };

  const saveRouter = () =>
    run("PUT", "/api/admin/api-router", {
      weights: { free: Number(weights.free) || 0, mimo: Number(weights.mimo) || 0, glm: Number(weights.glm) || 0 },
      freeDailyCap: Number(cap) || undefined,
    }, { label: "router-save", success: "路由权重已保存，下一次调用生效（最长约 1 分钟缓存）" });

  const toggleRouter = () =>
    run("PUT", "/api/admin/api-router", { enabled: !r.config.enabled }, {
      label: "router-toggle",
      success: r.config.enabled ? "接口路由已停用：回到原单模型路由（免费证书桥 + MIMO 白班窗）" : "接口路由已启用：按权重链调度与自动切换",
    });

  const resetState = () =>
    run("POST", "/api/admin/api-router/reset", undefined, { label: "router-reset", success: "今日健康态已重置：切走的接口全部恢复，免费池清零重派" });

  return (
    <AdminPage
      title="API 接口"
      subtitle="模型调用走哪个接口：默认端点（GLM）在最上面配置；下面的「接口路由」决定各模块在 免费模型、MIMO、GLM 之间怎么选、坏了怎么切。改动的项保存后对之后的新调用生效（各进程最长约 1 分钟内全面切换）。"
    >
      <div className="grid gap-5">
        <Card
          title="接口路由权重"
          right={
            <div className="flex gap-2">
              <Button busy={pending === "router-toggle"} onClick={toggleRouter}>{r.config.enabled ? "停用路由" : "启用路由"}</Button>
              <Button tone="ghost" busy={pending === "router-reset"} onClick={resetState}>重置今日状态</Button>
            </div>
          }
        >
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              {r.config.enabled ? <Badge tone="ok">已启用</Badge> : <Badge tone="muted">未启用（各模块走单模型原路由）</Badge>}
              <span className="text-ink-4">
                每个模块按权重从高到低选接口；断链、连续 5 分钟请求异常或免费额度耗尽时自动切到下一个；
                每天早上 8 点（免费额度重置）自动回到权重最高的接口循环。免费模型池内部按「今日已用次数最少优先」轮流派发。
              </span>
            </div>
            <div className="grid gap-3">
              {r.providers.map((p) => (
                <div key={p.key} className="flex flex-wrap items-center gap-3 rounded-card border border-line px-3 py-2.5">
                  <div className="min-w-[7.5rem]">
                    <div className="text-[13.5px] text-ink">{p.label}</div>
                    <div className="font-mono text-[11.5px] text-ink-4">{p.modelKey}</div>
                  </div>
                  <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
                    权重
                    <Input
                      type="number" min={0} disabled={!r.config.enabled}
                      value={weights[p.key]} onChange={(e) => setWeights({ ...weights, [p.key]: Number(e.target.value) })}
                      className="w-20" autoComplete="off"
                    />
                  </label>
                  <span className="text-[12px] text-ink-4">今日 {p.todayCount} 次</span>
                  {!p.configured ? <Badge tone="muted">未配置密钥</Badge>
                    : p.down ? <Badge tone="bad" title={p.reason ?? undefined}>今日已切走 · {p.downAt?.slice(11, 19)}</Badge>
                    : p.usable ? <Badge tone="ok">正常</Badge> : <Badge tone="warn">暂不可用</Badge>}
                  {p.down && p.reason && <span className="basis-full truncate text-[11.5px] text-ink-4">{p.reason}</span>}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="免费模型日上限" hint="OpenRouter 未充值账户 50 次/天；充 $10 后为 1000 次/天。到上限当天免费位自动让位，次日自动回来。">
                <Input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!r.config.enabled} className="w-28" autoComplete="off" />
              </Field>
              <div className="flex items-end gap-2">
                <Button busy={pending === "router-save"} onClick={saveRouter} disabled={!r.config.enabled}>保存权重与上限</Button>
                <span className="text-[11.5px] text-ink-4">今日免费池已用 {r.todayFreeTotal} 次</span>
              </div>
            </div>
            {r.freePool.length > 0 && (
              <div className="rounded-card bg-bg-2 px-3 py-2.5">
                <div className="text-[12px] text-ink-4">免费模型池（按能力证书入池，今日已用次数）</div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-ink-3">
                  {r.freePool.map((m) => (
                    <span key={m.model}>
                      {m.model} · {m.todayCount} 次{m.exhausted ? "（今日已耗尽）" : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {r.config.updatedAt && (
              <div className="border-t border-line pt-3 text-[12px] text-ink-4">
                路由配置上次修改：{r.config.updatedAt.slice(0, 19).replace("T", " ")}（{r.config.updatedBy ?? "—"}）；权重 0 = 该接口不参与调度。
              </div>
            )}
          </div>
        </Card>

        <Card title="默认端点（GLM）当前生效配置">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-[12px] text-ink-4">接口地址</div>
              <div className="mt-1 break-all font-mono text-[12.5px] text-ink">{c.effective.baseUrl ?? "（未配置）"}</div>
              <div className="mt-1.5"><Badge tone={c.effective.sources.baseUrl === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.effective.sources.baseUrl]}</Badge></div>
            </div>
            <div>
              <div className="text-[12px] text-ink-4">模型名</div>
              <div className="mt-1 break-all font-mono text-[12.5px] text-ink">{c.effective.model || "（未配置）"}</div>
              <div className="mt-1.5"><Badge tone={c.effective.sources.model === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.effective.sources.model]}</Badge></div>
            </div>
            <div>
              <div className="text-[12px] text-ink-4">API Key</div>
              <div className="mt-1 break-all font-mono text-[12.5px] text-ink">{c.effective.apiKey ?? "（未配置）"}</div>
              <div className="mt-1.5"><Badge tone={c.effective.sources.apiKey === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.effective.sources.apiKey]}</Badge></div>
            </div>
          </div>
          {c.configured.updatedAt && (
            <div className="mt-4 border-t border-line pt-3 text-[12px] text-ink-4">
              后台配置上次修改：{c.configured.updatedAt.slice(0, 19).replace("T", " ")}（{c.configured.updatedBy ?? "—"}）；「清除后台配置」会三项全部回到环境文件的值。
            </div>
          )}
        </Card>

        <Card title="修改默认端点配置">
          <div className="grid gap-4">
            <Field label="接口地址（Base URL）" hint="例如 https://open.bigmodel.cn/api/paas/v4；留空 = 不改这一项。以 /anthropic 结尾的地址按 Claude 格式对接（该格式下看图调用会降级为纯文本）">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={c.effective.baseUrl ?? "https://…"} autoComplete="off" />
            </Field>
            <Field label="API Key" hint="只写一次即可，保存后页面上永远只显示打码值；留空 = 沿用现值">
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="留空不修改" autoComplete="new-password" />
            </Field>
            <Field label="模型名" hint="例如 glm-5.3-flash；留空 = 不改这一项">
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={c.effective.model || "glm-…"} autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button busy={pending === "llm-config-save"} onClick={save}>保存</Button>
              <Button tone="ghost" busy={pending === "llm-config-clear"} onClick={clearAll}>清除后台配置</Button>
            </div>
          </div>
        </Card>

        <Card title="测试对接" right={<Button busy={pending === "llm-test"} onClick={runTest}>测试对接</Button>}>
          {test ? (
            <div className="grid gap-2 text-[13px]">
              <div>
                {test.ok ? <Badge tone="ok">连通</Badge> : <Badge tone="bad">不通</Badge>}
                <span className="ml-2 text-ink-3">
                  {test.baseUrl} · {test.model} · {test.ms} ms{test.httpStatus ? ` · HTTP ${test.httpStatus}` : ""}
                </span>
              </div>
              {test.ok && test.reply && <div className="rounded-card bg-bg-2 px-3 py-2 text-ink">模型回复：{test.reply}</div>}
              {test.error && <div className="whitespace-pre-wrap break-all rounded-card bg-bg-2 px-3 py-2 font-mono text-[12px] text-bad">{test.error}</div>}
            </div>
          ) : (
            <div className="text-[13px] text-ink-4">用默认端点当前生效的接口地址、Key 和模型名发一次最小调用；接口侧的原始报错（比如「余额不足」）会原样显示在这里。</div>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
