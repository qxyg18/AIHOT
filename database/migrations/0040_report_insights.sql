-- 0040_report_insights.sql (ka2): structured viewpoints extracted from research-category articles.
-- One row per viewpoint: the entity it is about (taxonomy key, or NULL for industry-level),
-- the kind of claim, the stance, the statement with its figures (value+unit+caliber) and quote.
-- Re-extraction of the same article revision replaces previous rows (DELETE before INSERT in code).

CREATE TABLE report_insights (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL DEFAULT 1,
  entity_id text,
  entity_name text,
  kind text NOT NULL CHECK (kind IN ('rating', 'forecast', 'performance', 'expansion', 'product', 'risk', 'industry')),
  stance text CHECK (stance IN ('positive', 'neutral', 'negative')),
  statement text NOT NULL,
  figures jsonb NOT NULL DEFAULT '[]',
  quote text,
  org text,
  model text,
  prompt_version text,
  receipt_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_insights_entity_idx ON report_insights(entity_id, created_at DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX report_insights_article_idx ON report_insights(article_id);
