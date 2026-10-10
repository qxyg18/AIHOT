// 后台入驻机会读取（TZR-20261003 T19/ym251，plan §13）：把人工确认的店仓档案桥
// （store_archive_bridge，mall_slug 由人工核发）与人工审阅（opportunity_reviews）
// 叠到名录（419 商业体/61 品牌种子）上，产出五状态后台候选。纪律（卡面）：
// ①capability fail-closed（channel:read ∪ admin:operate，无 grant 行一律拒绝）；
// ②五状态互斥，名录内未检出≠未入驻（not_found 行 missing 显式注记）；
// ③已确认在营从纯新增候选天然排除（occupancy 单值），历史单列可复入；
// ④events/evidence 只装公开事实（MVP 未接线留空+缺项注记，不拿私有桥资料冒充）；
// ⑤输出即 T01 冻结 DTO（AdminOpportunitiesResponse），零店仓编号/名称/主体era 等私有字段；
// ⑥零模型调用——纯确定性分组，不产推荐分不报适合签约。
import { readFileSync } from "node:fs";
import { sql } from "../db.ts";
import { BRANDS_FILE, MALLS_FILE } from "../leaderboard/directory.ts";
import type {
  AdminCapability,
  AdminOpportunitiesResponse,
  AdminOpportunityRow,
  AdminOccupancyState,
} from "@aihot/contracts/site";
import { ADMIN_OCCUPANCY_STATES } from "@aihot/contracts/site";

const READ_CAPABILITIES: readonly AdminCapability[] = ["channel:read", "admin:operate"];

/**
 * capability 门（fail-closed）：无未撤销 grant 行即拒（500 capability_required 是设计）。
 * 路由层（apps/api/src/routes/admin.ts opportunities 两路由）另有一道同语义并集门——
 * 含 admin@local compat 兜底，故 compat operator 能过路由层却被本门拒：这是纵深防御的
 * 第二层（防未来新路由漏配并集门时的硬边界），不是 bug；消除该缝隙的正解是给 operator
 * 授 admin_cap_grants 行（ym326 审计 P1-1/P2-1），勿把本门改成 compat 兜底——那会打开
 * 安全缺口。
 */
async function requireCapability(principal: string, capabilities: readonly AdminCapability[]): Promise<void> {
  const rows = await sql<{ capability: string }[]>`
    SELECT capability FROM admin_cap_grants
    WHERE principal = ${principal} AND revoked_at IS NULL
      AND capability IN ${sql(capabilities as string[])}`;
  if (rows.length === 0) {
    throw new Error(`capability_required:${capabilities.join("|")}`);
  }
}

interface MallSeed { slug: string; name: string; city?: string }
interface BrandSeed { slug: string; name: string }

interface BridgeRow {
  mall_slug: string | null;
  city: string;
  channel: string;
  open_state: string;
  state_basis: string;
}

interface ReviewRow {
  entity_type: string;
  entity_slug: string;
  review_state: string;
  missing: unknown;
  feedback: string | null;
  hub_ref: string | null;
}

function asOccupancy(value: string): AdminOccupancyState | null {
  return (ADMIN_OCCUPANCY_STATES as readonly string[]).includes(value) ? (value as AdminOccupancyState) : null;
}

function asMissing(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
}

/** 未接线公开事实面的统一缺项/核验线索（AC4：只给线索，不作签约结论）。 */
const MISSING_PUBLIC_EVIDENCE = "公开证据未接线（T05/T13 承接）";

const NEXT_CHECKS_BY_STATE: Record<AdminOccupancyState, string[]> = {
  not_found: [
    "人工按名称/城市比对店仓档案，确认是否漏检（档案无商业体ID专列）",
    "接入公开开业/合作报道后补证据（T05/T13）",
  ],
  pending_review: [
    "人工核对档案行归属与多主体疑义（按档案事实注记逐行核）",
    "人工确认状态与 mall 桥（channel:confirm）",
  ],
  confirmed_open: ["在营事实复核后仅在公开证据面变化时更新"],
  historical: ["核对退出原因与复入线索；复入须新证据，不自动恢复在营"],
  planned: ["核对计划开业日期与招商进度原始材料"],
};

function missingFor(occupancy: AdminOccupancyState, hasBridge: boolean, reviewMissing: string[]): string[] {
  const out = [...reviewMissing];
  if (occupancy === "not_found") {
    out.push("名录内未检出档案（未检出≠未入驻，plan §13）");
  } else if (occupancy === "pending_review" && hasBridge) {
    out.push("档案行待人工核验（闭店/合并/同名多城等疑义见状态依据）");
  }
  out.push(MISSING_PUBLIC_EVIDENCE);
  return [...new Set(out)];
}

/**
 * 鉴权后台机会候选（T19 主读）。principal 为服务端认证上下文派生的操作者，
 * 客户端自报无效；返回行仅含名录实体与五状态/缺项/核验线索，不含私有桥字段。
 */
export async function loadOpportunities(principal: string): Promise<AdminOpportunitiesResponse> {
  await requireCapability(principal, READ_CAPABILITIES);

  const malls = (JSON.parse(readFileSync(MALLS_FILE, "utf8")) as { malls: MallSeed[] }).malls;
  const brands = (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands: BrandSeed[] }).brands;
  const [bridge, reviews] = await Promise.all([
    sql<BridgeRow[]>`
      SELECT mall_slug, city, channel, open_state, state_basis
      FROM store_archive_bridge WHERE mall_slug IS NOT NULL`,
    sql<ReviewRow[]>`
      SELECT entity_type, entity_slug, review_state, missing, feedback, hub_ref
      FROM opportunity_reviews`,
  ]);

  const reviewByEntity = new Map<string, ReviewRow>();
  for (const r of reviews) reviewByEntity.set(`${r.entity_type}:${r.entity_slug}`, r);
  const bridgeByMall = new Map<string, BridgeRow[]>();
  for (const b of bridge) {
    const key = b.mall_slug ?? "";
    (bridgeByMall.get(key) ?? bridgeByMall.set(key, []).get(key)!).push(b);
  }
  const brandName = new Map(brands.map((b) => [b.slug, b.name]));

  const rows: AdminOpportunityRow[] = [];
  const mallSlugSet = new Set(malls.map((m) => m.slug));
  for (const m of malls) {
    const review = reviewByEntity.get(`mall:${m.slug}`);
    const bridged = bridgeByMall.get(m.slug);
    // 状态优先级：人工审阅 > 人工确认桥行（仍待核）> 名录内未检出。
    const occupancy: AdminOccupancyState =
      review && asOccupancy(review.review_state) && review.review_state !== "not_found"
        ? (review.review_state as AdminOccupancyState)
        : bridged
          ? (review && asOccupancy(review.review_state) ? (review.review_state as AdminOccupancyState) : "pending_review")
          : "not_found";
    rows.push({
      entity: { type: "mall", slug: m.slug, name: m.name },
      city: m.city ?? null,
      occupancy,
      events: [],   // 公开事件面未接线（T05/T13）；私有桥时间不冒充公开证据
      evidence: [], // 同上：只允许既有 published 公开事实
      missing: missingFor(occupancy, Boolean(bridged), review ? asMissing(review.missing) : []),
      nextChecks: NEXT_CHECKS_BY_STATE[occupancy],
      hubRef: review?.hub_ref ?? null,
    });
  }
  // 品牌维度行只在人工审阅存在时出现（档案无品牌专列，不自动按编号前缀归品牌）。
  for (const r of reviews) {
    if (r.entity_type !== "brand") continue;
    const state = asOccupancy(r.review_state);
    if (!state) continue;
    rows.push({
      entity: { type: "brand", slug: r.entity_slug, name: brandName.get(r.entity_slug) ?? r.entity_slug },
      city: null,
      occupancy: state,
      events: [],
      evidence: [],
      missing: missingFor(state, false, asMissing(r.missing)),
      nextChecks: NEXT_CHECKS_BY_STATE[state],
      hubRef: r.hub_ref ?? null,
    });
  }
  // 名录外 slug 的审阅行（未知新项目先入候选，plan §13）按原样输出待核。
  for (const r of reviews) {
    const inDirectory = r.entity_type === "brand" || (r.entity_type === "mall" && mallSlugSet.has(r.entity_slug));
    if (inDirectory) continue;
    const state = asOccupancy(r.review_state);
    if (!state) continue;
    rows.push({
      entity: { type: r.entity_type === "brand" ? "brand" : "mall", slug: r.entity_slug, name: r.entity_slug },
      city: null,
      occupancy: state,
      events: [],
      evidence: [],
      missing: [...asMissing(r.missing), "名录外实体（先入候选，不进正式比较池）"],
      nextChecks: NEXT_CHECKS_BY_STATE[state],
      hubRef: r.hub_ref ?? null,
    });
  }

  return { rows, generatedAt: new Date().toISOString() };
}

/** 纯新增候选（AC3）：未检出/待核的 mall 行——已确认在营与历史/计划均不在其列。 */
export function pureNewCandidates(rows: readonly AdminOpportunityRow[]): AdminOpportunityRow[] {
  return rows.filter((r) => r.entity.type === "mall" && (r.occupancy === "not_found" || r.occupancy === "pending_review"));
}
