-- Brand profiles (zw14): per-brand encyclopedia facts and the eight-question ≤50-char summary.
-- Brand list SSOT = database/seeds/lb-brands-2026-10.json; rows are keyed by its slug.
CREATE TABLE brand_profiles (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  -- Eight-question answers (null = source material did not answer it; never invented).
  origin text,
  channels text,
  audience text,
  price_range text,
  main_category text,
  scale text,
  philosophy text,
  strength text,
  -- Collected facts.
  founded_year integer,
  listed_at text,
  summary text NOT NULL DEFAULT '',
  summary_chars integer NOT NULL DEFAULT 0,
  -- Which sources fed this row: any combination of wiki (zh or en), baike, seed.
  evidence text NOT NULL DEFAULT 'seed',
  wiki_url text,
  baike_url text,
  source_text text,
  source_hash text,
  -- pending = collected, waiting for the summary; ready = summarised; failed = summary rejected twice.
  status text NOT NULL DEFAULT 'pending',
  model text,
  receipt_id text,
  error text,
  collected_at timestamptz,
  summarized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brand_profiles_status_idx ON brand_profiles (status);
