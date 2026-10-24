-- Brand store archive (ym118): per-store rows collected from the Amap expansion line
-- (scripts/collectors/collect_amap_expand.py scenario=brands, output brand-stores.json),
-- and the per-city search counts (brand-store-counts.json) behind the brand page's
-- province statistics. Reserve data for the future store-address page.
CREATE TABLE brand_stores (
  brand_slug text NOT NULL,
  poi_id text NOT NULL,
  name text NOT NULL,
  poi_type text,
  province text,
  city text,
  district text,
  address text,
  lng double precision,
  lat double precision,
  -- Mall signal: mall_hint = the chain word found in the store name/address (e.g. 万达广场);
  -- mall_slug = resolved to a specific directory mall (seed slug or candidate poi_id);
  -- mall_match = how it was resolved: name-embed | proximity | proximity-weak (150–400m)
  -- | chain (chain-level hint only, no specific project); distance_m = metres to the
  -- matched mall POI (proximity matches only).
  mall_hint text,
  mall_slug text,
  mall_match text,
  distance_m double precision,
  -- sample = first-round page-capped sample rows; full = complete pagination round.
  source text NOT NULL DEFAULT 'sample',
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_slug, poi_id)
);

CREATE INDEX brand_stores_brand_idx ON brand_stores (brand_slug);
CREATE INDEX brand_stores_brand_province_idx ON brand_stores (brand_slug, province);
CREATE INDEX brand_stores_brand_mall_idx ON brand_stores (brand_slug, mall_slug);

-- Per brand × city search counts: count = the Amap "收录" hit count (an upper bound;
-- deep pagination returns fewer), province lets the brand page aggregate by province.
CREATE TABLE brand_store_counts (
  brand_slug text NOT NULL,
  city text NOT NULL,
  province text,
  listed_count integer NOT NULL DEFAULT 0,
  count_capped boolean NOT NULL DEFAULT false,
  page_capped boolean NOT NULL DEFAULT false,
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_slug, city)
);

CREATE INDEX brand_store_counts_brand_idx ON brand_store_counts (brand_slug);
