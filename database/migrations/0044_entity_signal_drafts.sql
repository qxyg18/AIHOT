-- Entity signal drafts (ym82 信息串联): structured facts extracted from article headlines and
-- excerpts (store openings / revenue figures / store counts), awaiting human review before they
-- enrich a brand profile. Idempotent per (article, entity, kind, value, unit) — re-running the
-- extractor never duplicates a fact. Approved brand rows are mirrored into
-- brand_profiles.entity_signals (JSONB, append-only); mall rows stay archived here because the
-- mall seed file remains hand-maintained (seed discipline).
CREATE TABLE entity_signal_drafts (
  id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('brand', 'mall')),
  entity_slug text NOT NULL,
  entity_name text NOT NULL,
  -- openings = 新开店数; revenue = 业绩数字（人民币亿/万元）; stores = 门店数（总数或净增，见 caliber）.
  kind text NOT NULL CHECK (kind IN ('openings', 'revenue', 'stores')),
  value numeric NOT NULL,
  unit text NOT NULL,
  caliber text,
  -- The sentence the number came from — the review decision's evidence.
  quote text NOT NULL,
  article_hash text,
  -- pending = awaiting review; approved/rejected are terminal (re-review goes through a new row).
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX entity_signal_drafts_unique_idx ON entity_signal_drafts (article_id, entity_slug, kind, value, unit);
CREATE INDEX entity_signal_drafts_status_idx ON entity_signal_drafts (status, created_at);
CREATE INDEX entity_signal_drafts_entity_idx ON entity_signal_drafts (entity_type, entity_slug, status);

-- Approved brand signals are appended here by the review action: an array of
-- {id, kind, value, unit, caliber, quote, articleId, at} objects.
ALTER TABLE brand_profiles ADD COLUMN entity_signals jsonb NOT NULL DEFAULT '[]'::jsonb;
