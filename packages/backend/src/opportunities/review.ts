// 机会人工核验写入（TZR-20261003 T19/ym251，plan §13）：后台把人工核验结论落到
// opportunity_reviews（UPSERT，唯一键 entity_type+entity_slug）。两动作分权（卡面）：
// feedback=登记内部反馈/缺项/HUB 引用（channel:feedback ∪ admin:operate），
// confirm=人工判定五状态（channel:confirm ∪ admin:operate；名单内未检出不得确认在营
// 之外的状态由人工负责，服务端只收五状态词汇）。纪律：零模型调用、零自动评分、
// 不调私有数据外部模型；新增采集/自动生成材料走各自 source policy+T15，不进本接口。
import { sql } from "../db.ts";
import type {
  AdminCapability,
  AdminOpportunityReview,
  AdminOccupancyState,
} from "@aihot/contracts/site";
import { ADMIN_OCCUPANCY_STATES } from "@aihot/contracts/site";

export type ReviewAction = "feedback" | "confirm";

const ACTION_CAPABILITIES: Record<ReviewAction, readonly AdminCapability[]> = {
  feedback: ["channel:feedback", "admin:operate"],
  confirm: ["channel:confirm", "admin:operate"],
};

/**
 * capability 门（fail-closed）：无未撤销 grant 行即拒（500 capability_required 是设计）。
 * 与 read.ts 同款双层门：路由层（apps/api/src/routes/admin.ts opportunities/review）另有
 * 并集门含 admin@local compat 兜底，compat operator 过路由层后被本门拒属纵深防御第二层；
 * 消除缝隙的正解是授 admin_cap_grants 行（ym326 审计 P1-1/P2-1），勿改本门为 compat 兜底。
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

export interface ReviewOpportunityInput {
  /** 服务端认证上下文派生的操作者（reviewed_by 落档）；客户端自报无效。 */
  principal: string;
  entityType: "brand" | "mall";
  entitySlug: string;
  action: ReviewAction;
  /** confirm 必填：人工判定的五状态；feedback 不改状态。 */
  state?: AdminOccupancyState;
  /** 人工核出的缺项（人话短语，不猜补）。 */
  missing?: string[];
  feedback?: string | null;
  /** HUB 承接引用（决定/任务回链）。 */
  hubRef?: string | null;
}

/** 人工核验写入：feedback 只更新文本面（保留既有状态），confirm 更新五状态。 */
export async function reviewOpportunity(input: ReviewOpportunityInput): Promise<AdminOpportunityReview> {
  const { principal, entityType, entitySlug, action } = input;
  if (!entityType || !entitySlug) throw new Error("entity_required");
  await requireCapability(principal, ACTION_CAPABILITIES[action]);

  let state: AdminOccupancyState | null = null;
  if (action === "confirm") {
    if (!input.state || !(ADMIN_OCCUPANCY_STATES as readonly string[]).includes(input.state)) {
      throw new Error("invalid_state");
    }
    state = input.state;
  }
  // 文本面语义：undefined=保留既有值（feedback 不误清人工缺项），显式传值才覆盖；
  // confirm 的 state 必填由上文校验。
  const missing = input.missing === undefined ? null : input.missing.filter((m) => typeof m === "string" && m.length > 0);
  const feedback = input.feedback ?? null;
  const hubRef = input.hubRef ?? null;

  const [row] = await sql<{ review_state: string; missing: unknown; feedback: string | null; hub_ref: string | null; reviewed_by: string | null; updated_at: string }[]>`
    INSERT INTO opportunity_reviews (entity_type, entity_slug, review_state, missing, feedback, hub_ref, reviewed_by)
    VALUES (${entityType}, ${entitySlug}, ${state ?? "pending_review"}, ${missing === null ? sql.json([]) : sql.json(missing)}, ${feedback}, ${hubRef}, ${principal})
    ON CONFLICT (entity_type, entity_slug) DO UPDATE SET
      review_state = ${state === null ? sql`opportunity_reviews.review_state` : sql`${state}`},
      missing = ${missing === null ? sql`opportunity_reviews.missing` : sql.json(missing)},
      feedback = ${feedback === null && input.feedback === undefined ? sql`opportunity_reviews.feedback` : sql`${feedback}`},
      hub_ref = ${hubRef === null && input.hubRef === undefined ? sql`opportunity_reviews.hub_ref` : sql`${hubRef}`},
      reviewed_by = ${principal},
      updated_at = now()
    RETURNING review_state, missing, feedback, hub_ref, reviewed_by, updated_at::text`;

  return {
    entity: { type: entityType, slug: entitySlug },
    state: row.review_state as AdminOccupancyState,
    missing: Array.isArray(row.missing) ? row.missing.filter((m): m is string => typeof m === "string") : [],
    feedback: row.feedback,
    hubRef: row.hub_ref,
    reviewedBy: row.reviewed_by,
    updatedAt: row.updated_at,
  };
}
