// 已核官方来源准入 policy（TZR-20261003 T01/ym239 冻结合同；消费者=T05 探源准入引擎）。
// 判据来自 plan §5 准入门；具体比例/样本数属业务校准参数——未冻结时一律 null，
// 缺参数自动关闭（自动启用恒 false），不猜值（plan §5「具体比例和样本数不得伪造，
// G00用标注样本校准后由高级方案负责人冻结；缺值时 AUTO_ACTIVATE 恒 false」）。
// 冻结（ym334，2026-10-05）：命主拍板 d-ym314-admission-tier=mid 中性档，依据=ym310
// 校准报告 §五/§六推导链（artifacts/2026-10-05/ym310-label-calibration/）+决策板拍板
// 条目；升版 source-policy/2，变更随 candidate.policy_version 留痕（ym311 起生效）。

export interface SourcePolicyThresholds {
  /** 试抓标注样本最少条数（ym310 校准冻结：中性档 5；未冻结=null）。 */
  minSamples: number;
  /** 样本中目标实体/渠道行动相关占比下限（0-1；ym310 校准冻结：中性档 0.6；未冻结=null）。 */
  minRelevanceRatio: number;
}

export interface SourcePolicyV1 {
  /** policy 版本（冻结后升版；变更随 candidate.policy_version 留痕）。 */
  version: string;
  updatedAt: string;
  /** 准入硬门（与阈值无关，永远生效；任一不满足即不许 eligible）。 */
  requireOfficialRoot: boolean;
  requireRightsEvidence: boolean;
  requireRobotsPass: boolean;
  /** 免费 GET、无认证头/账号、摘要+原文链接且全文阀关闭（plan §5）。 */
  requireFreeGet: boolean;
  forbidAuthHeaders: boolean;
  requireSummaryAndLink: boolean;
  fulltextValve: "off";
  /** 校准阈值：未冻结=null → 自动启用关闭。 */
  thresholds: SourcePolicyThresholds | null;
}

/** 已冻结（source-policy/2，中性档 5/0.6）：硬门照常，资格判定打开；
 *  激活接线（createSource 事务化）归 ym311、触发入口归 ym312，两层另卡治理。 */
export const SOURCE_POLICY_V1: SourcePolicyV1 = {
  version: "source-policy/2",
  updatedAt: "2026-10-05",
  requireOfficialRoot: true,
  requireRightsEvidence: true,
  requireRobotsPass: true,
  requireFreeGet: true,
  forbidAuthHeaders: true,
  requireSummaryAndLink: true,
  fulltextValve: "off",
  thresholds: { minSamples: 5, minRelevanceRatio: 0.6 },
};

/** 自动启用资格判定：阈值未冻结（null）或缺任一参数 → false（缺参数自动关闭；调用方不得默认放行）。 */
export function isSourcePolicyActivatable(policy: SourcePolicyV1): boolean {
  const t = policy.thresholds;
  if (!t) return false;
  return Number.isFinite(t.minSamples) && Number.isFinite(t.minRelevanceRatio);
}