// Admin「开源项目跟踪」：盯 GitHub 上游开源项目的更新节奏（releases / tags / commits 三面
// 差分，日扫一轮 06:47）。每期出刊配一条 AI 大白话解读，含「对施工的适配提示」（可借鉴/需警惕），
// 解读与知识件是后续 ZCode 相关施工的参考底座（命主 2026-10-03）。这里看现状、立即扫描、登记新项目。
import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import type { Route } from "./+types/oss-watch";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Field, Input, Json, Time, type Column } from "../../features/admin/ui";

interface OssProject {
  slug: string;
  name: string;
  repo_url: string;
  vendor: string;
  active: boolean;
  created_at: string;
}

interface DigestItem { title: string; plain: string }
interface OssDigest { overview: string; items: DigestItem[]; adopt: string[]; caution: string[]; confidence: number }
interface OssReview { verdict: "passed" | "issues"; issues: string[]; lessons: string[]; confidence: number; reviewReceiptId: number | null; reviewedAt: string }

interface OssUpdate {
  id: number;
  project_slug: string;
  kind: "release" | "tag" | "commit_batch";
  payload: Record<string, unknown>;
  digest_status: "pending" | "done";
  digest: (OssDigest & Record<string, unknown>) | { error: string } | null;
  receipt_id: number | null;
  digested_at: string | null;
  review_status: "passed" | "issues" | null;
  review: OssReview | null;
  created_at: string;
}

interface Overview {
  lastRun: { at: string; ok: boolean; error: string | null; projects: number; updates: number; digested: number; pending: number } | null;
  projects: OssProject[];
  updates: OssUpdate[];
  lessons: Array<{ date: string; lesson: string }>;
  counts: { projects: number; pending: number; unreviewed: number };
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Overview>(request, "/api/admin/oss-watch");
}

export const meta: Route.MetaFunction = () => [{ title: `开源项目跟踪 · ${SITE.name} 后台` }];

const KIND_LABEL: Record<OssUpdate["kind"], string> = { release: "版本发布", tag: "标签", commit_batch: "提交批次" };
const KIND_TONE: Record<OssUpdate["kind"], "ok" | "accent" | "muted"> = { release: "ok", tag: "muted", commit_batch: "accent" };

const payloadLine = (u: OssUpdate): string => {
  const p = u.payload as { tag?: string; tags?: string[]; total?: number; folded?: number; window?: string; commits?: Array<{ title: string }> };
  if (u.kind === "release") return `${p.tag ?? "?"} · ${(p as { name?: string }).name ?? ""}`;
  if (u.kind === "tag") return (p.tags ?? []).join("、");
  const titles = (p.commits ?? []).map((c) => c.title).slice(0, 3).join("；");
  return `${p.total ?? 0} 笔（折叠 ${p.folded ?? 0}）${p.window === "baseline" ? " · 基线" : ""}：${titles}${(p.commits ?? []).length > 3 ? "…" : ""}`;
};

function DigestView({ u }: { u: OssUpdate }) {
  if (u.digest_status === "done" && u.digest && "overview" in u.digest) {
    const d = u.digest;
    return (
      <div className="grid gap-1.5 text-[12.5px]">
        <div className="text-ink">{d.overview}</div>
        {d.items.map((it, i) => (
          <div key={i} className="text-ink-3">
            <span className="font-medium text-ink">{it.title}</span>——{it.plain}
          </div>
        ))}
        {(d.adopt.length > 0 || d.caution.length > 0) && (
          <div className="grid gap-0.5 border-t border-line pt-1.5">
            {d.adopt.map((a, i) => <div key={`a${i}`} className="text-ok">可借鉴：{a}</div>)}
            {d.caution.map((c, i) => <div key={`c${i}`} className="text-amber">需警惕：{c}</div>)}
          </div>
        )}
        <div className="text-ink-4">置信度 {Math.round(d.confidence * 100)}% · 回执 #{u.receipt_id ?? "—"} · 解读于 <Time at={u.digested_at} /></div>
      </div>
    );
  }
  if (u.digest && "error" in u.digest && !("overview" in u.digest)) {
    return <div className="text-[12.5px] text-amber">解读失败待下轮补：{String(u.digest.error)}</div>;
  }
  return <div className="text-[12.5px] text-ink-4">待解读（下一轮扫描补）</div>;
}

export default function OssWatchAdmin({ loaderData: w }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [form, setForm] = useState({ slug: "", name: "", repoUrl: "", vendor: "" });

  const scan = () => run("POST", "/api/admin/oss-watch/scan", undefined, { label: "oss-scan", success: "扫描完成（有更新才出刊，解读失败标 pending 下轮补）" });
  const review = () => run("POST", "/api/admin/oss-watch/review", undefined, { label: "oss-review", success: "复核完成（教训已沉淀，次日解读自动带上）" });
  const register = () =>
    run("POST", "/api/admin/oss-watch/projects", form, { label: "oss-register", success: "项目已登记（下轮扫描出基线刊）" })
      .then((ok) => ok !== null && setForm({ slug: "", name: "", repoUrl: "", vendor: "" }));

  const columns: Column<OssProject>[] = [
    {
      key: "project",
      label: "项目",
      render: (p) => (
        <div>
          <div className="text-[13px] font-medium text-ink">{p.name} {!p.active && <Badge>已停用</Badge>}</div>
          <div className="font-mono text-[12px] text-ink-4">{p.repo_url}</div>
        </div>
      ),
    },
    { key: "slug", label: "键", render: (p) => <span className="font-mono text-[12px]">{p.slug}</span> },
    { key: "vendor", label: "维护方", render: (p) => <span className="text-[12.5px] text-ink-3">{p.vendor || "—"}</span> },
    { key: "created", label: "登记于", render: (p) => <Time at={p.created_at} /> },
  ];

  return (
    <AdminPage
      title="开源项目跟踪"
      subtitle="盯 GitHub 上游开源项目的更新节奏（releases / tags / 默认分支 commits 三面水位差分）。双轮闭环（ym195 命主令）：白天轮 06:47 扫描后免费模型立即写解读（免费窗口未开回落 MIMO 付费班次）；复核轮 23:33 强模型对照原始材料审白天的解读，问题提炼成教训回灌（下方教训池），次日解读自动带上教训持续改进。chore/CI 类提交折叠计数不出刊；解读失败标 pending 下轮补，不阻塞采集。"
    >
      <div className="grid gap-5">
        <Card
          title="扫描"
          right={
            <div className="flex gap-2">
              <Button tone="ghost" busy={pending === "oss-review"} onClick={review} disabled={w.counts.unreviewed === 0}>立即复核（{w.counts.unreviewed}）</Button>
              <Button busy={pending === "oss-scan"} onClick={scan}>立即扫描</Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-3">
            <span>上次扫描：</span><Time at={w.lastRun?.at ?? null} />
            {w.lastRun && (
              <span>
                {w.lastRun.ok ? `项目 ${w.lastRun.projects} 个 · 出刊 ${w.lastRun.updates} 期 · 解读 ${w.lastRun.digested} 条` : `失败：${w.lastRun.error?.slice(0, 80)}`}
                {w.lastRun.ok && w.lastRun.pending > 0 ? ` · 待补解读 ${w.lastRun.pending}` : ""}
              </span>
            )}
            <span className="text-ink-4">在跟 {w.counts.projects} 个项目 · 待补解读 {w.counts.pending} 条 · 教训池 {w.lessons.length} 条（每日 23:33 复核轮回灌）</span>
          </div>
          {w.lessons.length > 0 && (
            <div className="mt-3 grid gap-1 border-t border-line pt-3">
              {w.lessons.slice(0, 8).map((l, i) => (
                <div key={i} className="text-[12px] text-ink-3"><span className="font-mono text-ink-4">{l.date}</span> {l.lesson}</div>
              ))}
              {w.lessons.length > 8 && <div className="text-[12px] text-ink-4">…共 {w.lessons.length} 条</div>}
            </div>
          )}
        </Card>

        <Card title="登记新跟踪项目">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="键（slug，小写字母/数字/连字符）">
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="zcode" />
            </Field>
            <Field label="项目名称">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ZCode" />
            </Field>
            <Field label="仓库地址（github.com）">
              <Input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} placeholder="https://github.com/zai-org/ZCode" />
            </Field>
            <Field label="维护方（可选）">
              <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="Z.ai" />
            </Field>
          </div>
          <div className="mt-3">
            <Button tone="ghost" busy={pending === "oss-register"} onClick={register}>登记</Button>
          </div>
          <div className="mt-3">
            <DataTable rows={w.projects} columns={columns} rowKey={(p) => p.slug} empty="还没有登记跟踪项目" />
          </div>
        </Card>

        <Card title="更新流水（每期一条大白话解读）">
          <div className="grid gap-3">
            {w.updates.length === 0 && <div className="text-[13px] text-ink-4">暂无出刊（等下一轮扫描，或点「立即扫描」）</div>}
            {w.updates.map((u) => (
              <div key={u.id} className="grid gap-1.5 border-b border-line pb-3 last:border-none last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                  <Time at={u.created_at} />
                  <Badge tone={KIND_TONE[u.kind]}>{KIND_LABEL[u.kind]}</Badge>
                  <span className="font-mono text-[12px] text-ink-3">{u.project_slug}</span>
                  <span className="text-ink">{payloadLine(u)}</span>
                  <Badge tone={u.digest_status === "done" ? "ok" : "warn"}>{u.digest_status === "done" ? "已解读" : "待解读"}</Badge>
                  {u.digest_status === "done" && (u.review_status === "passed" ? <Badge tone="ok">复核过</Badge> : u.review_status === "issues" ? <Badge tone="warn">复核有问题</Badge> : <Badge>待复核</Badge>)}
                </div>
                <DigestView u={u} />
                {u.review_status === "issues" && u.review && (
                  <div className="grid gap-0.5 border-l-2 border-amber/40 pl-2">
                    {u.review.issues.map((it, i) => <div key={i} className="text-[12px] text-amber">复核指出：{it}</div>)}
                    {u.review.lessons.map((l, i) => <div key={`l${i}`} className="text-[12px] text-ink-4">沉淀教训：{l}</div>)}
                  </div>
                )}
                <Json value={u.payload} label="原始材料" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AdminPage>
  );
}
