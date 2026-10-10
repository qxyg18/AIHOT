-- ym436 销项 P1（shoumen 审计 2026-10-08）：免费通道 budgets 行入迁移——此前仅手工补入
-- 生产库，环境重建/测试库重备会重现「免费池 0 调用」fail-closed 静默拒发（receipts.ts
-- requireBudget 无行即拒）。值与生产手工行一致：zhipu-free 覆盖实测峰值 69 次/分+补试
-- 余量；openrouter 与 ym249 测试口径（freeBudget 60/100/500）对齐。
INSERT INTO budgets (service, per_minute, per_hour, per_day)
VALUES
  ('zhipu-free', 90, 5000, 100000),
  ('openrouter', 60, 100, 500)
ON CONFLICT (service) DO NOTHING;
