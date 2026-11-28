-- A side question is not a turn of the lesson (D-078): it is a short exchange with
-- a helper that may run while the teacher is busy, so it lives apart from the
-- transcript and is never replayed into the lesson as the learner's message.
-- Thread is bound to the session and to the step it was asked about, so the answer
-- stays reopenable from that step later.

CREATE TABLE side_thread (
	id         TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	step_id    TEXT REFERENCES step(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	closed_at  TEXT
);
CREATE INDEX side_thread_session ON side_thread (session_id, created_at);

CREATE TABLE side_message (
	thread_id  TEXT NOT NULL REFERENCES side_thread(id) ON DELETE CASCADE,
	ordinal    INTEGER NOT NULL,
	role       TEXT NOT NULL CHECK (role IN ('learner', 'helper')),
	text       TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (thread_id, ordinal)
);
