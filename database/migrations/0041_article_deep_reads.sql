-- Article deep reads (ka4): one plain-language reading per article for visitors who never open
-- the source — what it says and what it means, grounded in the site's own memory (past coverage
-- of the same brand/mall, the brand profile, the mall directory facts). Owner rules 2026-09-30:
-- articles matching no brand, mall or market-wide signal keep the AI 导读 as the only copy, so
-- those are recorded as skipped and the sweep never revisits them.
CREATE TABLE article_deep_reads (
  article_id       text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  -- ready = interpretation stored; skipped = no entity/market signal (owner rule 4);
  -- failed = the model output was unusable twice-worth of evidence, backfill --force retries.
  status           text NOT NULL CHECK (status IN ('ready', 'skipped', 'failed')),
  skip_reason      text,
  -- brand / mall / mixed / macro
  kind             text,
  -- what the reading matched, as [{type: 'brand'|'mall', slug, name}]
  entities         jsonb NOT NULL DEFAULT '[]',
  -- which writing the model used (see industry/prompts/deep-read.md)
  angle            text CHECK (angle IN ('history', 'analogy', 'direct', 'macro')),
  interpretation   text,
  model            text,
  prompt_version   text,
  receipt_id       bigint,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
