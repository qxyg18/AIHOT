-- 开源项目跟踪·复核轮（2026-10-03 ym195 命主令）：白天免费模型先写先出，优惠窗用强模型
-- 对照原始材料复核白天的解读，问题提炼成教训（settings 键 osswatch.lessons）注入次日解读
-- ——上下文学习闭环。复核结果落本表两列；教训不放这里（跨项目共享，走 settings）。
ALTER TABLE oss_updates ADD COLUMN review_status text;  -- null=未复核 | passed | issues
ALTER TABLE oss_updates ADD COLUMN review jsonb;        -- {issues[],lessons[],confidence,reviewedAt}
