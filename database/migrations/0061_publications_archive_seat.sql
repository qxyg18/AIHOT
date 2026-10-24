-- The archive trigger (0060) copies publications by column name so a dropped/renamed column cannot
-- silently mis-map the history. The upstream seat column (0043_publication_seat) arrived after the
-- archive table itself and is NOT NULL without a default there (CREATE TABLE ... LIKE copies NOT NULL
-- but not defaults), so every publication delete raised
--   null value in column "seat" of relation "publications_archived"
-- and the delete transaction aborted. Copy seat like every other column, and give the archive its own
-- default for any other insert path (a manual restore, an older function still in place).
ALTER TABLE publications_archived ALTER COLUMN seat SET DEFAULT true;

CREATE OR REPLACE FUNCTION publications_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO publications_archived (
    article_id, analysis_id, revision, visibility, eligible, selected, title, original_title,
    summary, reason, category, tags, score, source_id, channel, first_party, url, published_at,
    discovered_at, timeline_at, backfill, selected_ready_at, visible_after, body_mode, syndicate,
    indexable, story_id, fact_id, search_text, updated_at, sort_at, seo_indexed_at,
    seo_excluded_at, seat, archived_at
  ) SELECT
    OLD.article_id, OLD.analysis_id, OLD.revision, OLD.visibility, OLD.eligible, OLD.selected,
    OLD.title, OLD.original_title, OLD.summary, OLD.reason, OLD.category, OLD.tags, OLD.score,
    OLD.source_id, OLD.channel, OLD.first_party, OLD.url, OLD.published_at, OLD.discovered_at,
    OLD.timeline_at, OLD.backfill, OLD.selected_ready_at, OLD.visible_after, OLD.body_mode,
    OLD.syndicate, OLD.indexable, OLD.story_id, OLD.fact_id, OLD.search_text, OLD.updated_at,
    OLD.sort_at, OLD.seo_indexed_at, OLD.seo_excluded_at, OLD.seat, now();
  RETURN OLD;
END $$;
