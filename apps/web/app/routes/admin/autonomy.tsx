// Admin「自治闭环」（TZR-20261003 T17/ym258）：HUB 权威的自治状态与决策队列只读投影。
// 本文件在 T06C 注册路由/接真实接口/验鉴权之前只是预览骨架：loader 对未接线（404）或
// 暂不可达（503）回落离线预览态（hubAvailable=false，横幅说明），不冒称上线；
// 组件/loader 用独立签名（不引用尚未生成的路由类型，AC6），路由类型由 T06C
// 注册后生成。六态口径=editing-manual §8：defined/enabled/active/verified/stale/unknown
// 对应「已定义/已启用/运行中/已验证/已过期/未知」，一态一色，不用单个绿点覆盖全部含义。
// HUB 为唯一治理权威：本页只读投影，无执行/批准任何影子接口（AC4）。
import { SITE } from "@aihot/industry/site";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Badge, Card, Empty } from "../../features/admin/ui";

// ---- 冻结 DTO（T17 交付；T06C 接真实接口时按此契约对接）----

export type AutonomyState = "defined" | "enabled" | "active" | "verified" | "stale" | "unknown";

export interface AutonomyCapabilityItem {
  /** 组件/乘客键（如 passenger/radar-autonomy） */
  key: string;
  title: string;
  state: AutonomyState;
  detail: string;
  updatedAt: string | null;
}

export interface AutonomyDecisionItem {
  id: string;
  title: string;
  /** 大白话版本优先，缺失时回退技术原文 */
  question: string;
  status: "pending" | "decided" | "suspended";
  options: Array<{ id: string; label: string; gain: string; risk: string; recommended: boolean }>;
  taskId: string | null;
  decidedAt: string | null;
  history: string[];
}

export interface AutonomyProjection {
  source: "hub";
  generatedAt: string;
  /** false=HUB 不可达/未接线：各状态一律按未知展示 */
  hubAvailable: boolean;
  capabilities: AutonomyCapabilityItem[];
  decisions: AutonomyDecisionItem[];
}

interface AutonomyLoaderData {
  projection: AutonomyProjection;
  /** 非 null=预览态（接口未接线），横幅说明；null=真实投影。 */
  preview: string | null;
}

const STATE_LABELS: Record<AutonomyState, string> = {
  defined: "已定义", enabled: "已启用", active: "运行中", verified: "已验证", stale: "已过期", unknown: "未知",
};
const STATE_TONE: Record<AutonomyState, "ok" | "warn" | "bad" | "accent" | "muted"> = {
  defined: "muted", enabled: "accent", active: "ok", verified: "ok", stale: "warn", unknown: "muted",
};

const PREVIEW_PROJECTION: AutonomyProjection = {
  source: "hub",
  generatedAt: new Date().toISOString(),
  hubAvailable: false,
  capabilities: [
    { key: "passenger/radar-autonomy", title: "自治闭环·有界自检→提案", state: "unknown",
      detail: "预览骨架：接线后显示 HUB 侧真实状态（提示与跟进）", updatedAt: null },
    { key: "passenger/openrouter-watch", title: "免费模型信源投喂", state: "unknown",
      detail: "预览骨架：接线后显示 HUB 侧真实状态（提示与跟进）", updatedAt: null },
  ],
  decisions: [],
};

export async function loader({ request }: { request: Request }): Promise<AutonomyLoaderData> {
  try {
    const data = await adminGet<AutonomyProjection>(request, "/api/admin/autonomy");
    return { projection: data, preview: null };
  } catch (err) {
    // adminGet 的 404 走 react-router data() 抛出（DataWithResponseInit，非 Response 实例，
    // status 藏在 .init.status）；5xx 重抛为 data(..., {status:503})。两形态都要接住，
    // 否则未接线时整页 500 而非预览态（T17 VERIFY 实证修补）。
    const status = err instanceof Response ? err.status : (err as { init?: { status?: number } })?.init?.status;
    if (status === 404 || status === 503) {
      return {
        projection: PREVIEW_PROJECTION,
        preview: "自治投影接口未接线（T06C 承接注册与鉴权）——以下为离线预览骨架，状态一律按未知展示",
      };
    }
    throw err;
  }
}

export const meta = () => [{ title: `自治闭环 · ${SITE.name} 后台` }];

export default function AutonomyPage({ loaderData }: { loaderData: AutonomyLoaderData }) {
  const d = loaderData.projection;
  return (
    <AdminPage title="自治闭环" subtitle={`HUB 自治投影（只读，HUB 为权威） · 生成于 ${d.generatedAt}${d.hubAvailable ? "" : " · HUB 暂不可达"}`}>
      {loaderData.preview && (
        <div className="mb-4 rounded-card border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{loaderData.preview}</div>
      )}
      <div className="grid gap-4">
        <Card title="自治组件状态" right={<Badge tone={d.hubAvailable ? "accent" : "muted"}>{d.capabilities.length}</Badge>}>
          {d.capabilities.length === 0 ? (
            <Empty>接线后展示自治组件状态（未接线时为空）</Empty>
          ) : (
            <div className="grid gap-2">
              {d.capabilities.map((c) => (
                <div key={c.key} className="flex items-start gap-3 rounded-card border border-line px-3 py-2">
                  <Badge tone={STATE_TONE[d.hubAvailable ? c.state : "unknown"]}>
                    {STATE_LABELS[d.hubAvailable ? c.state : "unknown"]}
                  </Badge>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{c.title}</div>
                    <div className="text-[12px] text-ink-4">{c.detail}</div>
                    <div className="text-[11.5px] text-ink-4">最近更新：{c.updatedAt ?? "—"} · 键：{c.key}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="待拍板事项（只读投影）" right={<Badge tone={d.decisions.length > 0 ? "warn" : "muted"}>{d.decisions.length}</Badge>}>
          <div className="mb-2 text-[12px] text-ink-4">投影 HUB 决策队列现状；拍板与跟进在 HUB 侧进行，本页不提供操作。</div>
          {d.decisions.length === 0 ? (
            <Empty>{d.hubAvailable ? "当前无待拍板事项" : "HUB 暂不可达——待拍板事项显示为空（未知，非零）"}</Empty>
          ) : (
            <div className="grid gap-2">
              {d.decisions.map((it) => (
                <div key={it.id} className="rounded-card border border-line px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={it.status === "pending" ? "warn" : "muted"}>
                      {it.status === "pending" ? "待拍板" : it.status === "decided" ? "已拍板" : "暂停"}
                    </Badge>
                    <span className="text-[13px] font-medium">{it.title}</span>
                  </div>
                  <div className="mt-1 text-[12.5px] text-ink-3">{it.question}</div>
                  <div className="mt-1 grid gap-0.5">
                    {it.options.map((o) => (
                      <div key={o.id} className="text-[12px] text-ink-4">
                        {o.recommended ? "推荐 · " : ""}{o.label}（益：{o.gain}；险：{o.risk}）
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[11.5px] text-ink-4">
                    承接卡：{it.taskId ?? "—"} · 拍板时间：{it.decidedAt ?? "—"}{it.history.length > 0 ? ` · ${it.history.join("；")}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
