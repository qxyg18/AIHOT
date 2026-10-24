-- Deep read input identity, projection layer (T08A/ym316, decision d-ym245-deepread-pub-identity
-- option A, owner ruling 2026-10-05): a deep reading's validity is bound to a THREE-part input
-- identity —
--   input_revision = articles.revision      (content edits, owner layer)
--   pub_revision   = publications.revision  (re-analysis rewrites of summary/category/tags/
--                                            original_title, projection layer — publish.ts bumps
--                                            this while articles.revision stands still)
--   input_hash     = basis                  (prompt version + vocab seed bytes, see 0052 section C)
-- A re-analyzed publication (new summary, new entity tags) changes what the model reads, so it
-- voids the reading the same way a content edit does. Legacy rows (NULL, from 0052-era writes)
-- are never current — they read as a miss and get re-swept (0052's contract, unchanged).
ALTER TABLE article_deep_reads
  ADD COLUMN pub_revision integer;
