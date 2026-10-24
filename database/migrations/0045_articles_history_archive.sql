-- Articles history archive (ym80, 2026-10-01 owner ruling: the domain-gate cleanup physically deletes
-- historical articles that the tightened prefilter blocks; every such row is kept at the DB level
-- first, mirroring 0043_lb_history_archive.sql).
-- Rows deleted from articles/publications/analyses are copied into sibling archive tables by BEFORE
-- DELETE row triggers, so no deletion path — the ym80 cleanup, a future cleanup, or manual SQL — can
-- destroy the material, its public projection or the paid judgement without a trace.
-- Scope: the three restore-critical tables (material + public projection + paid analysis). The other
-- cascading children (article_revisions, article_discoveries, translations, editorial_overrides,
-- fact_articles, story_signals, grouping_decisions, translation_attempts, pool_search,
-- grouping_overrides, regroup_pending, report_insights, article_deep_reads, article_entities,
-- entity_signal_drafts) are recomputable by existing jobs or bookkeeping; ym80 counts what cascades.
-- Archives deliberately carry no foreign keys, no unique constraints and no copied defaults: they must
-- survive any upstream deletion and must accept a re-deleted id. Updates never rewrite these rows in
-- this codebase except publications (rebuilt in place), which only matters for the pre-delete copy; a
-- schema change to articles/publications/analyses must mirror its columns here (LIKE copies at
-- creation time only).
-- TRUNCATE bypasses row triggers — nothing truncates these tables; keep it that way.

CREATE TABLE articles_archived (LIKE articles);
ALTER TABLE articles_archived ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX articles_archived_time_idx ON articles_archived (archived_at DESC);
CREATE INDEX articles_archived_source_idx ON articles_archived (source_id, archived_at DESC);

CREATE TABLE publications_archived (LIKE publications);
ALTER TABLE publications_archived ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX publications_archived_article_idx ON publications_archived (article_id, archived_at DESC);

CREATE TABLE analyses_archived (LIKE analyses);
ALTER TABLE analyses_archived ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX analyses_archived_article_idx ON analyses_archived (article_id, archived_at DESC);

CREATE FUNCTION articles_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO articles_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

CREATE TRIGGER articles_archive_del BEFORE DELETE ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_archive_del();

CREATE FUNCTION publications_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO publications_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

CREATE TRIGGER publications_archive_del BEFORE DELETE ON publications
  FOR EACH ROW EXECUTE FUNCTION publications_archive_del();

CREATE FUNCTION analyses_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analyses_archived SELECT OLD.*, now();
  RETURN OLD;
END $$;

CREATE TRIGGER analyses_archive_del BEFORE DELETE ON analyses
  FOR EACH ROW EXECUTE FUNCTION analyses_archive_del();