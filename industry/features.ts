// 可选模块。它们只对 AI 行业有意义，本档两项都已关闭。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。

export const FEATURES = {
  /** 排行榜：童装品牌榜+全国商业体榜，weighted v1 加权方法（/leaderboard）。zw12 改造后本档开启。 */
  leaderboard: true,
  /** Codex 重置监控：盯 OpenAI Codex 负责人的额度重置公告（/codex-reset）。AI 行业专属，本档关闭。 */
  codexResetMonitor: false,
} as const;
