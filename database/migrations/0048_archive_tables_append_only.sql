-- Append-only archives (ym146, 2026-10-03): ym141 proved a manual batch DELETE can wipe the
-- 0045 archives after the fact — the "delete, then clean the archives" playbook ran at least
-- twice (ym109 and the unknown 170-article round), so the archive tables were a ledger in
-- name only. These statement triggers make DELETE/TRUNCATE on the three *_archived tables
-- fail outright. Archives are append-only by definition: the 0045 row triggers are the only
-- writer, and re-deleting an already-archived id stays possible (INSERT path unchanged).
-- A table owner bypasses REVOKE, so a grant-level guard is worthless here; this trigger is
-- not bypassable by ordinary DML. The connecting role is usually also the table owner and
-- could ALTER TABLE ... DISABLE TRIGGER or drop it — DDL that log_statement='mod' does NOT
-- capture (only pgaudit or log_statement='ddl' would); until then that escape is the known
-- blind spot disclosed in the ym146 report §七. If a future cleanup genuinely needs an
-- archive row gone, that is an owner-approved exception: drop the trigger deliberately in a
-- reviewed change, never clean archives as a side effect.

CREATE FUNCTION archive_tables_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (ym146): DELETE/TRUNCATE on archive tables is forbidden; rows arrive via the 0045 archive triggers, deletions go through scripts/delete-articles.ts', TG_TABLE_NAME;
END $$;

CREATE TRIGGER articles_archived_append_only BEFORE DELETE OR TRUNCATE ON articles_archived
  FOR EACH STATEMENT EXECUTE FUNCTION archive_tables_append_only_guard();

CREATE TRIGGER publications_archived_append_only BEFORE DELETE OR TRUNCATE ON publications_archived
  FOR EACH STATEMENT EXECUTE FUNCTION archive_tables_append_only_guard();

CREATE TRIGGER analyses_archived_append_only BEFORE DELETE OR TRUNCATE ON analyses_archived
  FOR EACH STATEMENT EXECUTE FUNCTION archive_tables_append_only_guard();
