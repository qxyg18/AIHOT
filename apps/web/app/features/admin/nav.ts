// Admin NAV 清单与显隐判定（ym326：T06B 遗留③收口，从 routes/admin/layout.tsx 抽出）。
// 独立成无 react/DOM 依赖的文件，使 node:test（tests/admin-nav.test.ts）可直接导入钉显隐语义。
// 显隐仅是表现层：未渲染≠未授权，直访与 API 权限一律由服务端判（/api/admin/me 的
// capabilities 为权威源）。items 默认 admin:operate 单值门（channel 入口自带 cap）；
// anyOf=并集显示（任一能力即渲染）——入驻机会入口带 channel:read ∪ admin:operate，
// 与 /api/admin/opportunities 的路由层并集门（apps/api/src/routes/admin.ts）同语义。
import { FEATURES } from "@aihot/industry/features";
import type { AdminCapability } from "@aihot/contracts/site";

/** loader 里 nav-counts 的四个计数键（layout.tsx 的 Counts 以此为键域）。 */
export type NavCountKey = "feedback" | "sources" | "runs" | "monitor";

export interface NavItem {
  to: string;
  label: string;
  count?: NavCountKey;
  tone?: "bad" | "accent";
  cap?: AdminCapability;
  /** 并集显示：持有任一能力即渲染（默认走 cap 单值门）。 */
  anyOf?: readonly AdminCapability[];
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    group: "内容",
    items: [
      { to: "/admin/content", label: "内容诊断" },
      { to: "/admin/sources", label: "信源", count: "sources", tone: "bad" },
      ...(FEATURES.codexResetMonitor ? [{ to: "/admin/monitor", label: "Codex 重置", count: "monitor" as const, tone: "accent" as const }] : []),
      { to: "/admin/opportunities", label: "入驻机会", anyOf: ["channel:read", "admin:operate"] },
      { to: "/admin/feedback", label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "系统",
    items: [
      { to: "/admin/runs", label: "运行", count: "runs", tone: "bad" },
      { to: "/admin/models", label: "模型与评测" },
      { to: "/admin/llm-config", label: "API 接口" },
      { to: "/admin/model-watch", label: "免费模型信源" },
      { to: "/admin/oss-watch", label: "智谱关注 · 开源项目" },
      { to: "/admin/zhipu-watch", label: "智谱关注 · 智谱发布" },
      { to: "/admin/selectbench", label: "SelectBench" },
      { to: "/admin/settings", label: "设置" },
      { to: "/admin/audit", label: "审计记录" },
    ],
  },
];

/** 显隐判定的 principal 面：/api/admin/me 的权威判定；缺失=fail-closed（无任何入口）。 */
export interface NavPrincipal {
  capabilities?: readonly AdminCapability[];
}

// 与 features/admin/action.ts 的 meCan 同判定（capabilities 缺失按无能力处理），独立实现
// 是为了本文件不背 react 依赖链；tests/admin-nav.test.ts 钉住「缺失/空=不显」边界。
const can = (me: NavPrincipal, cap: AdminCapability): boolean => me.capabilities?.includes(cap) ?? false;

/** NAV 显隐：anyOf=任一能力即渲染，否则 cap 单值门（默认 admin:operate）；空组剔除。 */
export function navGroupsFor(me: NavPrincipal): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (i.anyOf ? i.anyOf.some((c) => can(me, c)) : can(me, i.cap ?? "admin:operate"))),
  })).filter((g) => g.items.length > 0);
}
