// Admin "API 接口": the default model endpoint (base URL, key, model) configured from the admin UI.
// The effective values come from the backend (admin override first, credentials file as fallback),
// the key is only ever shown masked, and the test button makes one live call and shows the
// provider's own answer — a 1113 "余额不足" is readable here as it is.
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

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<LlmConfig>(request, "/api/admin/llm-config");
}

export const meta: Route.MetaFunction = () => [{ title: `API 接口 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台配置", file: "环境文件" } as const;

export default function LlmConfigAdmin({ loaderData: c }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);

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

  return (
    <AdminPage
      title="API 接口"
      subtitle="模型调用走哪个接口：填好后保存在这里，对之后的新调用生效（后台各进程最长约 1 分钟内全面切换）；留空的项保持原值不动，没配置的项继续用部署时的环境文件值。改动前可先用下方按钮实测一次。"
    >
      <div className="grid gap-5">
        <Card title="当前生效配置">
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

        <Card title="修改配置">
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
            <div className="text-[13px] text-ink-4">用当前生效的接口地址、Key 和模型名发一次最小调用；接口侧的原始报错（比如「余额不足」）会原样显示在这里。</div>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
