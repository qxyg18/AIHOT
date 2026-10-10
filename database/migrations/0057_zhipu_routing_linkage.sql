-- ym438 雷达智谱动态联动（2026-10-09）：zhipu_updates 增 routing_action jsonb——每条智谱信号
-- 处理后的路由动作留痕（免费池候选接入 / 窗口规则写入或拒写 / 仅记录 / 出错）。
-- 信号幂等：只处理 routing_action IS NULL 的行（同窗重扫零重复动作，撞 dedup_key 的新行不入
-- 重复处理）；部署时存量行由下一轮扫描按此列回填（本次即 27 行）。
ALTER TABLE zhipu_updates ADD COLUMN routing_action jsonb;
