-- Poi mall/brand distribution (2026-10-13 命主令：商业体+品类词反推品牌分布):
-- mall_brand_pois = per-mall kids-category POI rows collected by collect_amap_expand
-- scenario=mall-cat (query 「商业体名+品类词」, attributed to the mall or a surrounding one),
-- poi_id deduped across rounds with seen_count accumulating ("不断统计").
-- poi_found_brands = category-scan store names not matched to the tracked brand table;
-- repeated ones (≥3 stores or ≥2 malls, promoted=true) join the brand leaderboard view.
CREATE TABLE mall_brand_pois (
  mall_ref text NOT NULL,          -- seed mall slug or candidate poi_id
  poi_id text NOT NULL,
  poi_name text NOT NULL,
  word text,                       -- category word searched (童装/童鞋)
  brand_slug text,                 -- tracked brand slug; null = not in brand table
  brand_name text,                 -- display name (tracked brand name or store-name core)
  lng double precision,
  lat double precision,
  distance_m double precision,     -- to attributed mall (proximity matches only)
  match_kind text,                 -- name-embed | proximity | proximity-weak
  first_seen timestamptz,
  last_seen timestamptz,
  seen_count integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mall_ref, poi_id)
);

CREATE INDEX mall_brand_pois_brand_idx ON mall_brand_pois (brand_slug);
CREATE INDEX mall_brand_pois_mall_idx ON mall_brand_pois (mall_ref);

CREATE TABLE poi_found_brands (
  norm_name text PRIMARY KEY,      -- upper-cased store-name core (dedupe key)
  brand_name text NOT NULL,
  poi_count integer NOT NULL DEFAULT 0,
  mall_count integer NOT NULL DEFAULT 0,
  city_count integer NOT NULL DEFAULT 0,
  first_seen timestamptz,
  last_seen timestamptz,
  promoted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
