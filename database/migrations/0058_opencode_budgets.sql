-- ym467（2026-10-10）：opencode 免费档 budgets 行入迁移。requireBudget 对免费通道 fail-closed
-- （receipts.ts 无行即拒发——ym436 P1 同源教训：手工补行不经迁移，环境重建即重现「免费池 0 调用」）。
-- 值与实测口径：S01 实测顺序 6/6、并发 4/8 全 200 零 429，并发≥4 呈服务端软排队（尾部 23.6/28.8s）；
-- 夜批能力验收峰值 ~10-20 次/分（10 样本 mapLimited 5），此处给 3 倍余量；日次为 runaway 兜底
-- （平台未公布日次上限，自设 12000 仅防失控重试打满客户端）。
INSERT INTO budgets (service, per_minute, per_hour, per_day)
VALUES
  ('opencode-free', 60, 1200, 12000)
ON CONFLICT (service) DO NOTHING;
