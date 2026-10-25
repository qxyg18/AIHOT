-- Production code still reads and writes state that 0050/0051 dropped on the upstream side. The merge
-- kept the production (migrate/linux) code for the leaderboard read path and the metadata regroup
-- branch, so the columns and the queue table must exist again: without them the leaderboard detail
-- query fails and a metadata fill cannot arm a regroup. Regression: tests/leaderboard-related-gate and
-- tests/meta-enrich (both sides' test files assert the production behaviour).
--
-- Idempotent on purpose: a database that never applied 0050/0051 already has them (production does),
-- and a fresh database applies 0050/0051 first and then gets them back here.

ALTER TABLE lb_rankings
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS metric_count integer,
  ADD COLUMN IF NOT EXISTS component_scores jsonb;

CREATE TABLE IF NOT EXISTS regroup_pending (
  article_id   text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);
