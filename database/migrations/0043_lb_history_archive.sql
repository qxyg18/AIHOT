-- Leaderboard history archive (ym25, 2026-09-30 owner ruling: keep run history at the DB level).
-- Rows deleted from lb_scores/lb_rankings are first copied into sibling archive tables by
-- BEFORE DELETE row triggers, so no deletion path — model cleanup, cascade from lb_runs or
-- lb_snapshots, or manual SQL (the kb4 loss of 2026-09-30: deleting 5 brand models silently took
-- 107 history rows, unrecoverable) — can destroy run history without a trace.
-- Archives deliberately carry no foreign keys and no unique constraints: they must survive any
-- upstream deletion and must accept a re-deleted id. Updates never rewrite score/ranking rows in
-- this codebase (insert-only), so DELETE is the only destructive path; a schema change to
-- lb_scores/lb_rankings must mirror its columns here (LIKE copies at creation time only).
-- TRUNCATE bypasses row triggers — nothing truncates these tables; keep it that way.

CREATE TABLE lb_scores_archived (LIKE lb_scores);
ALTER TABLE lb_scores_archived ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX lb_scores_archived_model_idx ON lb_scores_archived (model_id, archived_at DESC);
CREATE INDEX lb_scores_archived_snapshot_idx ON lb_scores_archived (snapshot_id, archived_at DESC);

CREATE TABLE lb_rankings_archived (LIKE lb_rankings);
ALTER TABLE lb_rankings_archived ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX lb_rankings_archived_run_idx ON lb_rankings_archived (run_id, board, archived_at DESC);
CREATE INDEX lb_rankings_archived_model_idx ON lb_rankings_archived (model_id, archived_at DESC);

CREATE FUNCTION lb_scores_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lb_scores_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

CREATE TRIGGER lb_scores_archive_del BEFORE DELETE ON lb_scores
  FOR EACH ROW EXECUTE FUNCTION lb_scores_archive_del();

CREATE FUNCTION lb_rankings_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lb_rankings_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

CREATE TRIGGER lb_rankings_archive_del BEFORE DELETE ON lb_rankings
  FOR EACH ROW EXECUTE FUNCTION lb_rankings_archive_del();
