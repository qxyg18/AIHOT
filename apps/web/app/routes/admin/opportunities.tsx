// Admin「入驻机会」（TZR-20261003 T19/ym251，plan §13）：渠道 MVP 的后台候选预览——
// 名录 × 人工核准桥 × 人工审阅的五状态分组。本文件在 T06B 注册路由/接 API/验鉴权之前
// 只是预览骨架：loader 对未接线（404）或暂不可达（503）回落空态横幅，不冒称上线；
// 组件/loader 用独立签名（禁引用未生成的 ./+types/opportunities，AC6），路由类型由
// T06B 注册后生成。私有桥资料只在本后台出现，公开面零暴露（AC5）。
import { SITE } from "@aihot/industry/site";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Badge, Card, DataTable, Empty, type Column } from "../../features/admin/ui";
import {
  ADMIN_OCCUPANCY_STATE_LABELS,
  type AdminOpportunitiesResponse,
  type AdminOpportunityRow,
  type AdminOccupancyState,
} from "@aihot/contracts/site";

interface OpportunitiesLoaderData extends AdminOpportunitiesResponse {
  /** 非 null=预览态（API 未接线），横幅说明；null=真实数据。 */
  preview: string | null;
}

export async function loader({ request }: { request: Request }) {
  try {
    const data = await adminGet<AdminOpportunitiesResponse>(request, "/api/admin/opportunities");
    return { ...data, preview: null };
  } catch (err) {
    if (err instanceof Response && (err.status === 404 || err.status === 503)) {
      return {
        rows: [],
        generatedAt: new Date().toISOString(),
        preview: "机会 API 未接线（T06B 承接注册与鉴权）——以下为预览骨架，空态不代表无候选",
      };
    }
    throw err;
  }
}

export const meta = () => [{ title: `入驻机会 · ${SITE.name} 后台` }];

const GROUP_ORDER: AdminOccupancyState[] = ["confirmed_open", "historical", "planned", "pending_review", "not_found"];
const GROUP_HINT: Record<AdminOccupancyState, string> = {
  confirmed_open: "已确认在营——已从纯新增候选排除",
  historical: "历史曾入驻——复入线索单列，复入须新证据",
  planned: "计划开业——核对日期与招商进度",
  pending_review: "待核——桥行/疑义全部留人工核验",
  not_found: "未检出档案（≠未入驻）——纯新增候选，人工核验前不作推荐",
};
const GROUP_TONE: Record<AdminOccupancyState, "ok" | "accent" | "muted" | "warn"> = {
  confirmed_open: "ok", historical: "muted", planned: "accent", pending_review: "warn", not_found: "muted",
};

const columns: Column<AdminOpportunityRow>[] = [
  { key: "entity", label: "实体", render: (r) => (
    <span>
      <span className="font-medium">{r.entity.name}</span>
      <span className="ml-1.5 text-ink-4">{r.entity.type === "mall" ? "商业体" : "品牌"}{r.city ? ` · ${r.city}` : ""}</span>
    </span>
  ) },
  { key: "state", label: "状态", render: (r) => <Badge tone={GROUP_TONE[r.occupancy]}>{ADMIN_OCCUPANCY_STATE_LABELS[r.occupancy]}</Badge> },
  { key: "missing", label: "缺项", render: (r) => r.missing.length === 0 ? <span className="text-ink-4">—</span> : (
    <div className="grid gap-0.5">
      {r.missing.map((m, i) => <div key={i} className="text-amber">{m}</div>)}
    </div>
  ) },
  { key: "next", label: "下一步核验", render: (r) => (
    <div className="grid gap-0.5">
      {r.nextChecks.map((n, i) => <div key={i} className="text-ink-3">{n}</div>)}
    </div>
  ) },
  { key: "hub", label: "HUB 引用", render: (r) => r.hubRef ? <span className="text-ink-3">{r.hubRef}</span> : <span className="text-ink-4">—</span> },
];

export default function OpportunitiesPage({ loaderData: d }: { loaderData: OpportunitiesLoaderData }) {
  const byState = new Map<AdminOccupancyState, AdminOpportunityRow[]>(
    GROUP_ORDER.map((s) => [s, d.rows.filter((r) => r.occupancy === s)]),
  );
  return (
    <AdminPage title="入驻机会" subtitle={`五状态人工核验桥 · 生成于 ${d.generatedAt ?? "—"}`}>
      {d.preview && (
        <div className="mb-4 rounded border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{d.preview}</div>
      )}
      <div className="grid gap-4">
        {GROUP_ORDER.map((state) => {
          const rows = byState.get(state) ?? [];
          return (
            <Card key={state} title={ADMIN_OCCUPANCY_STATE_LABELS[state]} right={<Badge tone={GROUP_TONE[state]}>{rows.length}</Badge>}>
              <div className="mb-2 text-[12px] text-ink-4">{GROUP_HINT[state]}</div>
              {rows.length === 0
                ? <Empty>{d.preview ? "预览态（API 接线后展示真实候选）" : "暂无该状态行"}</Empty>
                : <DataTable rows={rows} columns={columns} rowKey={(r) => `${r.entity.type}:${r.entity.slug}`} dense />}
            </Card>
          );
        })}
      </div>
    </AdminPage>
  );
}
