-- 回滚 ym438（先撤代码再跑本脚本）：信号处理逻辑删除后，routing_action 列无消费者。
ALTER TABLE zhipu_updates DROP COLUMN IF EXISTS routing_action;
