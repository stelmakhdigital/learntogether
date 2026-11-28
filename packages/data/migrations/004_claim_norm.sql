-- Dedup of claim wording has to fold Cyrillic, and SQLite does not: COLLATE NOCASE
-- and lower() touch ASCII letters only, so «Скорость» and «скорость» were two nodes
-- (caught by the graph test). The folded form is therefore computed where the row is
-- written, in the language that knows Unicode case folding, and stored beside it.

ALTER TABLE claim ADD COLUMN norm TEXT NOT NULL DEFAULT '';
UPDATE claim SET norm = lower(trim(text));
-- Partial: a row written outside the repository can carry an empty norm, and a
-- pile of those must not collide. The app always writes the folded form.
CREATE UNIQUE INDEX claim_norm_unique ON claim (norm) WHERE norm <> '';

ALTER TABLE claim_alias ADD COLUMN norm TEXT NOT NULL DEFAULT '';
UPDATE claim_alias SET norm = lower(trim(text));
CREATE UNIQUE INDEX claim_alias_norm_unique ON claim_alias (norm) WHERE norm <> '';
