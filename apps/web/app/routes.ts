import { type RouteConfig, type RouteConfigEntry, index, layout, route } from "@react-router/dev/routes";
import type { ModulePage } from "@aihot/contracts/modules";
import { MODULES } from "@aihot/site/modules";

/** A module's route module, from the app directory. */
const file = (module: string, path: string) => `../../../modules/${module}/${path}`;
const page = (module: string, p: ModulePage) => route(p.path, file(module, p.file), p.id ? { id: p.id } : {});

/** The site's modules' pages, after the engine's. */
const modulePages: RouteConfigEntry[] = MODULES.flatMap((m) =>
  (m.pages ?? []).map((p) => ("layout" in p ? layout(file(m.name, p.layout), p.id ? { id: p.id } : {}, p.pages.map((c) => page(m.name, c))) : page(m.name, p))),
);
const moduleAdminPages: RouteConfigEntry[] = MODULES.flatMap((m) => (m.adminPages ?? []).map((p) => page(m.name, p)));

export default [
  index("routes/home.tsx"),
  route("all", "routes/all.tsx"),
  route("all/search-busy", "routes/search-busy.tsx", { id: "all-search-busy" }),
  route("search-busy", "routes/search-busy.tsx", { id: "search-busy" }),
  route("items/:id", "routes/item.tsx"),
  route("items/:id/original", "routes/item-original.tsx", { id: "item-original" }),
  route("hot", "routes/hot.tsx"),
  route("macro", "routes/macro.tsx"),
  route("story/:publicId", "routes/story.tsx"),
  route("daily", "routes/report-latest.tsx", { id: "daily-latest" }),
  route("daily/archive", "routes/daily-archive.tsx"),
  route("daily/:key", "routes/report-detail.tsx", { id: "daily-detail" }),
  route("weekly", "routes/report-latest.tsx", { id: "weekly-latest" }),
  route("weekly/:key", "routes/report-detail.tsx", { id: "weekly-detail" }),
  route("monthly", "routes/report-latest.tsx", { id: "monthly-latest" }),
  route("monthly/:key", "routes/report-detail.tsx", { id: "monthly-detail" }),
  route("topics", "routes/topics.tsx"),
  route("topics/:slug", "routes/topic.tsx", { id: "topic" }),
  route("topics/:slug/page/:page", "routes/topic.tsx", { id: "topic-page" }),
  route("about", "routes/about.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("changelog", "routes/changelog.tsx"),
  route("feedback", "routes/feedback.tsx"),
  route("more", "routes/more.tsx"),
  route("starred", "routes/starred.tsx"),
  route("entity/:type/:slug", "routes/entity.tsx"),
  route("agent", "routes/agent.tsx"),
  ...modulePages,
  route("codex-reset", "routes/codex-reset.tsx"),
  route("codex-reset/history/:date", "routes/codex-reset.tsx", { id: "codex-reset-day" }),
  layout("routes/leaderboard-boards.tsx", [
    route("leaderboard", "routes/leaderboard.tsx", { id: "leaderboard" }),
    route("leaderboard/category/:key", "routes/leaderboard.tsx", { id: "leaderboard-category" }),
    route("leaderboard/sub/:sub", "routes/leaderboard-sub.tsx", { id: "leaderboard-sub" }),
  ]),
  route("leaderboard/sources", "routes/leaderboard-sources.tsx"),
  route("leaderboard/sources/:key", "routes/leaderboard-source.tsx"),
  route("leaderboard/rules", "routes/leaderboard-rules.tsx"),
  route("leaderboard/:slug", "routes/leaderboard-model.tsx"),
  route("admin/login", "routes/admin-login.tsx"),
  layout("routes/admin/layout.tsx", { id: "admin-layout" }, [
    route("admin", "routes/admin/index.tsx"),
    route("admin/content", "routes/admin/content.tsx"),
    route("admin/content/:id", "routes/admin/content-item.tsx"),
    route("admin/sources", "routes/admin/sources.tsx"),
    route("admin/sources/new", "routes/admin/source-new.tsx"),
    route("admin/sources/:id", "routes/admin/source.tsx"),
    route("admin/monitor", "routes/admin/monitor.tsx"),
    route("admin/feedback", "routes/admin/feedback.tsx"),
    route("admin/opportunities", "routes/admin/opportunities.tsx"),
    route("admin/autonomy", "routes/admin/autonomy.tsx"),
    route("admin/runs", "routes/admin/runs.tsx"),
    route("admin/models", "routes/admin/models.tsx"),
    route("admin/llm-config", "routes/admin/llm-config.tsx"),
    route("admin/model-watch", "routes/admin/model-watch.tsx"),
    route("admin/oss-watch", "routes/admin/oss-watch.tsx"),
    route("admin/zhipu-watch", "routes/admin/zhipu-watch.tsx"),
    route("admin/selectbench", "routes/admin/selectbench.tsx"),
    route("admin/selectbench/:runId", "routes/admin/selectbench-run.tsx"),
    route("admin/settings", "routes/admin/settings.tsx"),
    route("admin/audit", "routes/admin/audit.tsx"),
    ...moduleAdminPages,
  ]),
] satisfies RouteConfig;
