// T01/ym239 DTO 反例（AC3）：能力词表与五状态词表精确、未知值在类型层被拒；
// SourcePolicyV1 缺参数自动关闭；公开 DTO 不得含内部入驻字段（泄漏即 tsc 失败）。
// 本文件的类型层断言由 `npm run typecheck`（tsconfig tests include *.ts）机械执行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_CAPABILITIES, ADMIN_OCCUPANCY_STATE_LABELS, ADMIN_OCCUPANCY_STATES } from "@aihot/contracts/site";
import type {
  AdminCapability,
  AdminMeView,
  AdminOccupancyState,
  AdminOpportunitiesResponse,
  AdminOpportunityRow,
  AdminSourceQualityView,
  FeedItemSummary,
  ItemDetail,
  ItemSummary,
  SiteItemDetail,
} from "@aihot/contracts/site";
import { SOURCE_POLICY_V1, isSourcePolicyActivatable } from "@aihot/industry/source-policy";
import type { SourcePolicyThresholds, SourcePolicyV1 } from "@aihot/industry/source-policy";

test("capability 词表精确；未知能力在类型层被拒", () => {
  assert.deepEqual(
    [...ADMIN_CAPABILITIES],
    ["admin:operate", "channel:read", "channel:feedback", "channel:confirm"],
    "capability 词表须与 DB admin_cap_grants CHECK 单一词汇一致",
  );
  // @ts-expect-error 未知能力不得赋给 AdminCapability（新增能力须同步契约与迁移 CHECK）
  const bad: AdminCapability = "admin:superuser";
  assert.equal(bad as string, "admin:superuser");
});

test("五状态词表精确；未知状态在类型层被拒", () => {
  assert.deepEqual(
    Object.keys(ADMIN_OCCUPANCY_STATE_LABELS),
    [...ADMIN_OCCUPANCY_STATES],
    "五状态值域单源（ym326 审计 P2-2）：数组与 LABELS 键必须一致，乱序/缺项即红",
  );
  assert.deepEqual(
    [...ADMIN_OCCUPANCY_STATES],
    ["confirmed_open", "historical", "planned", "pending_review", "not_found"],
    "五状态词表须与 DB store_archive_bridge / opportunity_reviews 的 CHECK 单一词汇一致",
  );
  // @ts-expect-error 未知状态词不得赋给 AdminOccupancyState
  const bad: AdminOccupancyState = "maybe_open";
  assert.equal(bad as string, "maybe_open");
});

test("SourcePolicyV1 阈值已冻结（中性档 5/0.6）即可激活；缺参数或回滚 null 恒关闭", () => {
  // ym334 冻结落值：导出值与拍板档位逐字一致（d-ym314-admission-tier=mid）
  assert.deepEqual(SOURCE_POLICY_V1.thresholds, { minSamples: 5, minRelevanceRatio: 0.6 }, "冻结值=拍板中性档");
  assert.equal(SOURCE_POLICY_V1.version, "source-policy/2");
  assert.equal(isSourcePolicyActivatable(SOURCE_POLICY_V1), true, "阈值已冻结=资格判定打开");
  // 回滚态（thresholds 还原 null）恒关闭
  const unfrozen: SourcePolicyV1 = { ...SOURCE_POLICY_V1, thresholds: null };
  assert.equal(isSourcePolicyActivatable(unfrozen), false, "阈值还原 null=自动启用关闭");
  // 运行时缺键场景（程序化构筑的 policy）：任一参数缺失即拒绝
  const partial = { ...SOURCE_POLICY_V1, thresholds: { minSamples: 20 } as SourcePolicyThresholds };
  assert.equal(isSourcePolicyActivatable(partial), false, "缺任一参数=拒绝，不默认放行");
});

// —— 公开 DTO 泄漏守卫（类型层）：内部入驻字段名若混入公开 DTO（含嵌套子结构），以下断言编译失败 ——
type InternalFieldName = "occupancy" | "opportunity" | "mallSlug" | "storeArchive" | "hubRef" | "capabilities";
type LeakedInto<T> = Extract<keyof T, InternalFieldName>;
type MustBeNever<T extends never> = T;
export type PublicDtoLeakCheck1 = MustBeNever<LeakedInto<ItemSummary>>;
export type PublicDtoLeakCheck2 = MustBeNever<LeakedInto<FeedItemSummary>>;
export type PublicDtoLeakCheck3 = MustBeNever<LeakedInto<SiteItemDetail>>;
export type PublicDtoLeakCheck4 = MustBeNever<LeakedInto<ItemDetail>>;
type DeepReadKeys = Extract<keyof NonNullable<SiteItemDetail["deepRead"]>, InternalFieldName>;
export type PublicDtoLeakCheck5 = MustBeNever<DeepReadKeys>;

// —— 契约形状锚（编译期存在性断言）：后台 DTO 必须持续可构造/可消费 ——
export type AdminContractShapeAnchors = [
  AdminMeView,
  AdminOpportunityRow,
  AdminOpportunitiesResponse,
  AdminSourceQualityView,
];