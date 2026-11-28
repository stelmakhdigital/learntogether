-- Compaction state (docs/architecture.md «Хранилище»: one active summary per
-- session plus a watermark). A table of its own rather than a transcript entry:
-- the watermark is a number the prompt assembly needs as a field, and the summary
-- is the teacher's working state, not a message the learner said or was said.
-- History is never edited — folding only moves the watermark and writes a summary.

CREATE TABLE compaction (
	session_id  TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
	watermark   INTEGER NOT NULL,
	summary     TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);
