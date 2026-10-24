-- Macro market board (ka7): indicator observations for the 宏观市场 page (/macro).
-- Data SSOT = scripts/seed-macro.ts; every value carries its source and caliber there.
-- Indicators: retail (社零当月值), apparel (服装类当月值), kids (儿童市场,机构估算),
--   population-birth / population-net (年度), age-single / age-bands (年龄结构).
CREATE TABLE IF NOT EXISTS macro_indicators (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  unit         text NOT NULL,
  granularity  text NOT NULL CHECK (granularity IN ('month', 'quarter', 'year', 'band')),
  caliber      text NOT NULL,
  source_name  text NOT NULL,
  source_urls  text[] NOT NULL DEFAULT '{}',
  -- Official year-to-date for the corner pill (ka7 revision): value + published yoy, null when not applicable.
  ytd_value    numeric(16,2),
  ytd_yoy      numeric(6,2),
  ytd_label    text,
  sort_order   integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS macro_observations (
  indicator_key text NOT NULL REFERENCES macro_indicators (key) ON DELETE CASCADE,
  -- Axis label exactly as shown: "1–2月"/"8月"/"Q3"/"2025"/"9岁"/"17–21岁". The label repeats across
  -- years on purpose (2026-8月 vs 2025-8月), so identity is (indicator, year, seq), not the label.
  period        text NOT NULL,
  -- Sort anchor within a year: month number (1–2月=1), quarter 1–4, the year itself, band order 0….
  seq           integer NOT NULL,
  year          integer NOT NULL,
  value         numeric(14,2) NOT NULL,
  -- published = official number; derived = computed from official pairs (e.g. prior-month = value/(1+yoy)); estimate = 机构估算.
  quality       text NOT NULL DEFAULT 'published' CHECK (quality IN ('published', 'derived', 'estimate')),
  yoy           numeric(6,2),
  note          text,
  PRIMARY KEY (indicator_key, year, seq)
);

CREATE INDEX IF NOT EXISTS macro_obs_order_idx ON macro_observations (indicator_key, year, seq);
