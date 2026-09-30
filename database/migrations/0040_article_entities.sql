-- Article ↔ entity links (zx18): which brands / malls / mall chains / retail channels an article
-- mentions, found by deterministic keyword matching over title + excerpt + body head. Directory
-- entities come from the seed keywords; chains and channels from the entity-extras seed. Rows are
-- rebuildable at any time (annotate is idempotent per article content hash).
CREATE TABLE article_entities (
  id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('brand', 'mall', 'mall-chain', 'channel')),
  entity_slug text NOT NULL,
  entity_name text NOT NULL,
  matched_via text NOT NULL,
  article_hash text,
  annotated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX article_entities_unique_idx ON article_entities (article_id, entity_type, entity_slug);
CREATE INDEX article_entities_entity_idx ON article_entities (entity_type, entity_slug);
