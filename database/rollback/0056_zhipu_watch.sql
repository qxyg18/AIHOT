-- 手动回滚脚本（ym437）：不参与自动迁移——scripts/migrate.ts 只扫 database/migrations/*.sql，
-- 本目录是人工回滚位，只有人显式执行才生效。
-- 用法（库内执行）：docker exec -i aihot-db-1 psql -U aihot -d aihot < database/rollback/0056_zhipu_watch.sql
-- 回滚面 = 表 + 迁移台账行（删掉才允许重新应用）+ 水位与每轮摘要两个 settings 键。
BEGIN;
DROP TABLE IF EXISTS zhipu_updates;
DELETE FROM schema_migrations WHERE name = '0056_zhipu_watch.sql';
DELETE FROM settings WHERE key IN ('zhipuwatch.watermarks', 'zhipuwatch.lastrun');
COMMIT;
