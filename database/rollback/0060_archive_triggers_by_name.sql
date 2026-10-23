-- 回滚 yn42（0060_archive_triggers_by_name.sql）：把 publications/analyses 的归档触发器恢复为
-- 0045 的按列位置 COPY 形态，并撤掉 entity_signal_drafts 留底（表 + 触发器 + 守卫函数）。
--
-- 注意顺序与后果：
--   1. 恢复位置 COPY 后，「主表加列 → DELETE 硬失败」的结构性隐患回到原状；只在确实需要回到
--      0060 之前的行为时才跑本脚本（例如 0060 在某环境引发归档链回归）。
--   2. DROP TABLE entity_signal_drafts_archived 会丢弃已留底的行。若表内已有行，先导出再删
--      （SELECT * FROM entity_signal_drafts_archived），本脚本不代做备份。

BEGIN;

-- 1. publications 触发器恢复位置 COPY（0045 原形）
CREATE OR REPLACE FUNCTION publications_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO publications_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

-- 2. analyses 触发器恢复位置 COPY（0045 原形）
CREATE OR REPLACE FUNCTION analyses_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analyses_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

-- 3. 撤 entity_signal_drafts 留底
DROP TRIGGER IF EXISTS entity_signal_drafts_archive_del ON entity_signal_drafts;
DROP FUNCTION IF EXISTS entity_signal_drafts_archive_del();

DROP TRIGGER IF EXISTS entity_signal_drafts_archived_append_only ON entity_signal_drafts_archived;
DROP FUNCTION IF EXISTS entity_signal_drafts_archived_append_only_guard();
DROP TABLE IF EXISTS entity_signal_drafts_archived;

COMMIT;
