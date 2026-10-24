// Admin「智谱关注 · 智谱发布」：盯智谱开放平台的模型发布、订阅优惠、免费窗口、价格变动与公告
// 改版（5 个定点页 .md 直取 + sitemap 差分，日扫一轮 06:53）。每条出刊配一条 AI 大白话解读，
// 含「对本站模型路由与订阅的影响提示」（ym437 命主点名需求②，为动态联动供感知）。这里看现状、
// 立即扫描、立即复核。
import { SITE } from "@aihot/industry/site";
import type { Route } from "./+types/zhipu-watch";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Json, Time } from "../../features/admin/ui";

type ZhipuKind = "model_release" | "plan_promo" | "free_window" | "pricing_change" | "community" | "other";

interface DigestItem { title: string; plain: string }
interface ZhipuDigest { overview: string; items: DigestItem[]; adopt: string[]; caution: string[]; confidence: number }
interface ZhipuReview { verdict: "passed" | "issues"; issues: string[]; confidence: number; reviewReceiptId: number | null; reviewedAt: string }

interface ZhipuUpdate {
  id: number;
  kind: ZhipuKind;
  title: string;
  url: string;
  published_at: string | null;
  payload: Record<string, unknown>;
  digest_status: "pending" | "done";
  digest: (ZhipuDigest & Record<string, unknown>) | { error: string } | null;
  receipt_id: number | null;
  digested_at: string | null;
  review_status: "passed" | "issues" | null;
  review: ZhipuReview | null;
  created_at: string;
}

interface Overview {
  lastRun: { at: string; ok: boolean; error: string | null; sources: number; updates: number; digested: number; pending: number; notes: string[] } | null;
  updates: ZhipuUpdate[];
  counts: { pending: number; unreviewed: number };
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Overview>(request, "/api/admin/zhipu-watch");
}

export const meta: Route.MetaFunction = () => [{ title: `智谱关注 · 智谱发布 · ${SITE.name} 后台` }];

const KIND_LABEL: Record<ZhipuKind, string> = {
  model_release: "模型发布", plan_promo: "套餐优惠", free_window: "免费窗口",
  pricing_change: "价格变动", community: "社区动态", other: "文档动态",
};
const KIND_TONE: Record<ZhipuKind, "ok" | "accent" | "muted" | "warn"> = {
  model_release: "ok", plan_promo: "accent", free_window: "warn",
  pricing_change: "accent", community: "muted", other: "muted",
};
const TRIGGER_LABEL: Record<string, string> = { baseline: "首轮基线", new: "新条目", updated: "条目更新" };

const payloadLine = (u: ZhipuUpdate): string => {
  const p = u.payload as { sourceLabel?: string; trigger?: string; publishedAt?: string | null };
  const parts = [p.sourceLabel ?? String((u.payload as { source?: string }).source ?? "")];
  if (p.trigger) parts.push(TRIGGER_LABEL[p.trigger] ?? p.trigger);
  if (p.publishedAt) parts.push(String(p.publishedAt).slice(0, 10));
  return parts.filter(Boolean).join(" · ");
};

function DigestView({ u }: { u: ZhipuUpdate }) {
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
            {d.adopt.map((a, i) => <div key={`a${i}`} className="text-ok">值得行动：{a}</div>)}
            {d.caution.map((c, i) => <div key={`c${i}`} className="text-amber">需要警惕：{c}</div>)}
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

export default function ZhipuWatchAdmin({ loaderData: w }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();

  const scan = () => run("POST", "/api/admin/zhipu-watch/scan", undefined, { label: "zhipu-scan", success: "扫描完成（有更新才出刊，解读失败标 pending 下轮补）" });
  const review = () => run("POST", "/api/admin/zhipu-watch/review", undefined, { label: "zhipu-review", success: "复核完成（结果写回每条解读）" });

  return (
    <AdminPage
      title="智谱关注 · 智谱发布"
      subtitle="盯智谱开放平台的模型发布、订阅优惠、免费窗口、价格变动与公告改版：5 个定点页（docs.bigmodel.cn 的 .md 直取）+ sitemap lastmod 差分，日扫一轮 06:53，有料才出刊。每条出刊由免费通道模型先写大白话解读（含对本站模型路由与订阅的影响提示），23:36 复核轮用强模型对照原始材料复核。页面结构变化解析不出时该页记错误停扫（不猜测解析），下轮自动重试。"
    >
      <div className="grid gap-5">
        <Card
          title="扫描"
          right={
            <div className="flex gap-2">
              <Button tone="ghost" busy={pending === "zhipu-review"} onClick={review} disabled={w.counts.unreviewed === 0}>立即复核（{w.counts.unreviewed}）</Button>
              <Button busy={pending === "zhipu-scan"} onClick={scan}>立即扫描</Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-3">
            <span>上次扫描：</span><Time at={w.lastRun?.at ?? null} />
            {w.lastRun && (
              <span>
                {w.lastRun.ok ? `定点页 ${w.lastRun.sources} 个 · 出刊 ${w.lastRun.updates} 条 · 解读 ${w.lastRun.digested} 条` : `有错误：${w.lastRun.error?.slice(0, 80)}`}
                {w.lastRun.ok && w.lastRun.pending > 0 ? ` · 待补解读 ${w.lastRun.pending}` : ""}
              </span>
            )}
            <span className="text-ink-4">待补解读 {w.counts.pending} 条 · 待复核 {w.counts.unreviewed} 条（复核轮每日 23:36）</span>
          </div>
          {w.lastRun && w.lastRun.notes.length > 0 && (
            <div className="mt-3 grid gap-1 border-t border-line pt-3">
              {w.lastRun.notes.map((n, i) => <div key={i} className="text-[12px] text-ink-3">观察：{n}</div>)}
            </div>
          )}
        </Card>

        <Card title="出刊流水（每条一条大白话解读）">
          <div className="grid gap-3">
            {w.updates.length === 0 && <div className="text-[13px] text-ink-4">暂无出刊（等下一轮扫描，或点「立即扫描」）</div>}
            {w.updates.map((u) => (
              <div key={u.id} className="grid gap-1.5 border-b border-line pb-3 last:border-none last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                  <Time at={u.created_at} />
                  <Badge tone={KIND_TONE[u.kind]}>{KIND_LABEL[u.kind] ?? u.kind}</Badge>
                  <span className="text-ink">{u.title}</span>
                  <a className="text-ink-4 underline decoration-dotted" href={u.url} target="_blank" rel="noreferrer">原文</a>
                  <Badge tone={u.digest_status === "done" ? "ok" : "warn"}>{u.digest_status === "done" ? "已解读" : "待解读"}</Badge>
                  {u.digest_status === "done" && (u.review_status === "passed" ? <Badge tone="ok">复核过</Badge> : u.review_status === "issues" ? <Badge tone="warn">复核有问题</Badge> : <Badge>待复核</Badge>)}
                </div>
                <div className="text-[12px] text-ink-4">{payloadLine(u)}</div>
                <DigestView u={u} />
                {u.review_status === "issues" && u.review && (
                  <div className="grid gap-0.5 border-l-2 border-amber/40 pl-2">
                    {u.review.issues.map((it, i) => <div key={i} className="text-[12px] text-amber">复核指出：{it}</div>)}
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
