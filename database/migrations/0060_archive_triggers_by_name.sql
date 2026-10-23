-- Archive triggers by column name (yn42, 2026-10-24; 48h audit M2):
-- 0045's BEFORE DELETE triggers copied rows with `INSERT INTO <t>_archived SELECT OLD.*, now()`,
-- a position-mapped copy. 0052 already rewrote articles_archive_del() into an explicit column
-- list (because the 0052 ALTER on articles shifted the archive table's column order); the
-- publications and analyses triggers were left position-mapped. Two consequences remain:
--   1. Any future ALTER TABLE publications/analyses ADD COLUMN makes the copy fail with a type
--      mismatch — and because the trigger is BEFORE DELETE, the DELETE itself fails, which takes
--      down the whole deletion path (scripts/delete-articles.ts, source/site cleanup, test sweep).
--   2. A column appended to the main table but not to the archive table would be silently
--      dropped from the archive row (or, with matching types, silently mis-mapped).
-- This migration rewrites both functions to name every column explicitly, mirroring 0052's
-- treatment of articles. Consequences of the explicit form, by design:
--   · Column order no longer matters: the archive table may carry archived_at anywhere.
--   · A future main-table column that is not mirrored here degrades (that one column is not
--     archived) instead of breaking every DELETE.
--   · The archive tables keep their append-only guard from 0048 — this only changes the writer.
--
-- entity_signal_drafts review trail (same card, step 2): 0044 declares ON DELETE CASCADE from
-- articles, and 0045's header called the table "recomputable by existing jobs". The review
-- columns (status/review_note/reviewed_at) are NOT recomputable: they are human decisions.
-- Production measurement at 2026-10-24 (read-only, aihot-db-1): 12 rows total, of which
-- 6 carry reviewed_at + review_note (2 approved, 4 rejected) across 10 distinct articles.
-- Approved brand rows are also mirrored into brand_profiles.entity_signals, but the mall
-- approved row and all four rejections exist only here. So a deleted article would silently
-- take human review decisions with it. This migration adds a BEFORE DELETE copy into
-- entity_signal_drafts_archived, same shape as the 0045 archives (no FKs, no unique
-- constraints, append-only by 0048's guard pattern).
--
-- Both changes are DDL-only and idempotent-safe to re-run: the archive table is created with
-- IF NOT EXISTS, the function is CREATE OR REPLACE, and the trigger is dropped first.

-- ---------------------------------------------------------------------------
-- 1. publications: copy by column name
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION publications_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO publications_archived (
    article_id, analysis_id, revision, visibility, eligible, selected, title, original_title,
    summary, reason, category, tags, score, source_id, channel, first_party, url, published_at,
    discovered_at, timeline_at, backfill, selected_ready_at, visible_after, body_mode, syndicate,
    indexable, story_id, fact_id, search_text, updated_at, sort_at, seo_indexed_at,
    seo_excluded_at, archived_at
  ) SELECT
    OLD.article_id, OLD.analysis_id, OLD.revision, OLD.visibility, OLD.eligible, OLD.selected,
    OLD.title, OLD.original_title, OLD.summary, OLD.reason, OLD.category, OLD.tags, OLD.score,
    OLD.source_id, OLD.channel, OLD.first_party, OLD.url, OLD.published_at, OLD.discovered_at,
    OLD.timeline_at, OLD.backfill, OLD.selected_ready_at, OLD.visible_after, OLD.body_mode,
    OLD.syndicate, OLD.indexable, OLD.story_id, OLD.fact_id, OLD.search_text, OLD.updated_at,
    OLD.sort_at, OLD.seo_indexed_at, OLD.seo_excluded_at, now();
  RETURN OLD;
END $$;

-- ---------------------------------------------------------------------------
-- 2. analyses: copy by column name
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analyses_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analyses_archived (
    id, article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance,
    category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected, output,
    created_at, archived_at
  ) SELECT
    OLD.id, OLD.article_id, OLD.input_revision, OLD.origin, OLD.model, OLD.prompt_version,
    OLD.receipt_ids, OLD.relevance, OLD.category, OLD.tags, OLD.subjects, OLD.title_zh,
    OLD.summary_zh, OLD.reason_zh, OLD.score, OLD.selected, OLD.output, OLD.created_at, now();
  RETURN OLD;
END $$;

-- ---------------------------------------------------------------------------
-- 3. entity_signal_drafts: keep the human review trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_signal_drafts_archived (LIKE entity_signal_drafts);
ALTER TABLE entity_signal_drafts_archived ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS entity_signal_drafts_archived_article_idx
  ON entity_signal_drafts_archived (article_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS entity_signal_drafts_archived_status_idx
  ON entity_signal_drafts_archived (status, archived_at DESC);

CREATE OR REPLACE FUNCTION entity_signal_drafts_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO entity_signal_drafts_archived (
    id, article_id, entity_type, entity_slug, entity_name, kind, value, unit, caliber, quote,
    article_hash, status, review_note, reviewed_at, created_at, archived_at
  ) SELECT
    OLD.id, OLD.article_id, OLD.entity_type, OLD.entity_slug, OLD.entity_name, OLD.kind, OLD.value,
    OLD.unit, OLD.caliber, OLD.quote, OLD.article_hash, OLD.status, OLD.review_note,
    OLD.reviewed_at, OLD.created_at, now();
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS entity_signal_drafts_archive_del ON entity_signal_drafts;
CREATE TRIGGER entity_signal_drafts_archive_del BEFORE DELETE ON entity_signal_drafts
  FOR EACH ROW EXECUTE FUNCTION entity_signal_drafts_archive_del();

-- The new archive table is append-only on the same terms as the 0045 archives (0048 pattern).
CREATE OR REPLACE FUNCTION entity_signal_drafts_archived_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (yn42): DELETE/TRUNCATE on the drafts archive is forbidden; rows arrive via the entity_signal_drafts_archive_del trigger', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS entity_signal_drafts_archived_append_only ON entity_signal_drafts_archived;
CREATE TRIGGER entity_signal_drafts_archived_append_only BEFORE DELETE OR TRUNCATE ON entity_signal_drafts_archived
  FOR EACH STATEMENT EXECUTE FUNCTION entity_signal_drafts_archived_append_only_guard();
