-- Initial schema. SQLite is the single source of truth (decision D-002): the
-- readable files a user sees are an export of these tables, never a store.
--
-- Conventions
--   * ids are text (uuidv7 strings) so exports and sync can reference them
--   * timestamps are ISO-8601 text in UTC
--   * FKs default to RESTRICT: losing a lesson's history because a graph node
--     was deleted is worse than a loud failure in the app
--   * JSON columns are named *_json and validated in code, not in SQL

PRAGMA foreign_keys = ON;

CREATE TABLE migration (
	name       TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
);

-- ─── goals and sessions ──────────────────────────────────────────────────────

CREATE TABLE goal (
	id          TEXT PRIMARY KEY,
	raw         TEXT NOT NULL,                 -- what the user typed
	statements_json TEXT NOT NULL DEFAULT '[]',-- refined target state
	ready_when  TEXT,
	created_at  TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);

CREATE TABLE session (
	id              TEXT PRIMARY KEY,
	kind            TEXT NOT NULL CHECK (kind IN ('teach', 'practice')),
	state           TEXT NOT NULL CHECK (state IN ('probing', 'planning', 'teaching', 'practicing', 'closed', 'failed')),
	goal_id         TEXT REFERENCES goal(id) ON DELETE RESTRICT,
	model_teacher   TEXT,                      -- "endpoint/model" as resolved at the time
	model_probe     TEXT,
	context_limit   INTEGER,                   -- measured, never assumed
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	closed_at       TEXT
);

-- Append-only per entry (decision D-020): one row per message part, so saving a
-- turn never rewrites the whole session.
CREATE TABLE transcript_entry (
	id         INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	ordinal    INTEGER NOT NULL,
	kind       TEXT NOT NULL CHECK (kind IN ('text', 'thinking', 'tool_call', 'tool_result', 'system_note', 'compaction')),
	role       TEXT NOT NULL CHECK (role IN ('teacher', 'learner', 'system')),
	text       TEXT NOT NULL DEFAULT '',
	thinking   TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (session_id, ordinal)
);
CREATE INDEX transcript_session_ordinal ON transcript_entry (session_id, ordinal);

CREATE TABLE tool_call (
	id             TEXT PRIMARY KEY,
	session_id     TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	entry_id       INTEGER REFERENCES transcript_entry(id) ON DELETE SET NULL,
	name           TEXT NOT NULL,
	raw_args       TEXT NOT NULL,
	canonical_args TEXT,
	state          TEXT NOT NULL CHECK (state IN ('started', 'args_ready', 'valid', 'repairing', 'failed', 'awaiting_learner', 'answered', 'dismissed')),
	error          TEXT,
	learner_answer TEXT,
	created_at     TEXT NOT NULL,
	answered_at    TEXT
);
CREATE INDEX tool_call_session ON tool_call (session_id, created_at);

-- Every applied coercion is recorded; an unrecorded change to arguments is
-- forbidden (docs/tool-contracts.md).
CREATE TABLE repair (
	id           INTEGER PRIMARY KEY,
	tool_call_id TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
	level        INTEGER NOT NULL CHECK (level IN (1, 2)),
	field        TEXT NOT NULL,
	from_text    TEXT NOT NULL,
	to_text      TEXT NOT NULL,
	server       TEXT
);

-- ─── probing, plan, steps, checks ───────────────────────────────────────────

CREATE TABLE probe_item (
	id           TEXT PRIMARY KEY,
	session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	goal_id      TEXT REFERENCES goal(id) ON DELETE RESTRICT,
	statement    TEXT NOT NULL,
	state        TEXT NOT NULL CHECK (state IN ('held', 'frontier', 'absent', 'contradicted')),
	confidence   INTEGER CHECK (confidence BETWEEN 1 AND 5),
	basis_entry_id INTEGER REFERENCES transcript_entry(id) ON DELETE SET NULL,
	created_at   TEXT NOT NULL
);
CREATE INDEX probe_item_session ON probe_item (session_id, state);

CREATE TABLE plan (
	id         TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	replaced_by TEXT REFERENCES plan(id) ON DELETE RESTRICT
);

-- why_needed is NOT NULL on purpose: a node without a reason is not allowed in
-- the plan (docs/teaching-method.md section 3).
CREATE TABLE plan_node (
	id         TEXT PRIMARY KEY,
	plan_id    TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
	node_id    TEXT NOT NULL,
	parent_id  TEXT,
	label      TEXT NOT NULL,
	why_needed TEXT NOT NULL,
	holds_dependency_of_json TEXT NOT NULL DEFAULT '[]',
	state      TEXT NOT NULL CHECK (state IN ('todo', 'done', 'skipped', 'pruned_held')),
	ordinal    INTEGER NOT NULL,
	UNIQUE (plan_id, node_id)
);

CREATE TABLE step (
	id            TEXT PRIMARY KEY,
	session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	plan_node_id  TEXT REFERENCES plan_node(id) ON DELETE RESTRICT,
	ordinal       INTEGER NOT NULL,
	statement     TEXT NOT NULL,
	kind          TEXT NOT NULL CHECK (kind IN ('derivation', 'foundation')),
	premises_json TEXT NOT NULL DEFAULT '[]',
	motivation    TEXT,
	state         TEXT NOT NULL CHECK (state IN ('planned', 'presented', 'accepted', 'repaired')),
	created_at    TEXT NOT NULL,
	UNIQUE (session_id, ordinal)
);
CREATE INDEX step_session ON step (session_id, ordinal);

-- One check per step is the method's contract; the DB allows several because a
-- repaired step gets a second one, and the app enforces "no acceptance without
-- a passed check". Table is step_check because CHECK is a SQL keyword.
CREATE TABLE step_check (
	id                TEXT PRIMARY KEY,
	step_id           TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
	kind              TEXT NOT NULL CHECK (kind IN ('single_choice', 'multi_choice', 'free_recall', 'predict', 'find_error', 'transfer')),
	question          TEXT NOT NULL,
	options_json      TEXT NOT NULL DEFAULT '[]',
	options_shuffled_json TEXT NOT NULL DEFAULT '[]',
	answer_json       TEXT NOT NULL,
	why               TEXT,
	ask_confidence    INTEGER NOT NULL DEFAULT 1 CHECK (ask_confidence IN (0, 1)),
	learner_answer_json TEXT,
	verdict           TEXT CHECK (verdict IN ('correct', 'incorrect', 'partial')),
	confidence        INTEGER CHECK (confidence BETWEEN 1 AND 5),
	hints             INTEGER NOT NULL DEFAULT 0 CHECK (hints >= 0),
	created_at        TEXT NOT NULL,
	answered_at       TEXT
);
CREATE INDEX step_check_step ON step_check (step_id);

-- ─── knowledge graph ────────────────────────────────────────────────────────

CREATE TABLE claim (
	id         TEXT PRIMARY KEY,
	text       TEXT NOT NULL,
	area       TEXT,
	tags_json  TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX claim_text_unique ON claim (text COLLATE NOCASE);

CREATE TABLE claim_alias (
	claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
	text     TEXT NOT NULL,
	PRIMARY KEY (claim_id, text)
);

-- Chains store joint sufficiency: premises together imply the conclusion. Edges
-- are derived from chains, never stored (architecture: no edges table).
CREATE TABLE chain (
	id                 TEXT PRIMARY KEY,
	conclusion_claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE RESTRICT,
	created_at         TEXT NOT NULL
);
CREATE INDEX chain_conclusion ON chain (conclusion_claim_id);

CREATE TABLE chain_premise (
	chain_id  TEXT NOT NULL REFERENCES chain(id) ON DELETE CASCADE,
	claim_id  TEXT NOT NULL REFERENCES claim(id) ON DELETE RESTRICT,
	ordinal   INTEGER NOT NULL,
	PRIMARY KEY (chain_id, claim_id)
);

CREATE TABLE provenance (
	id         INTEGER PRIMARY KEY,
	claim_id   TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES session(id) ON DELETE SET NULL,
	step_id    TEXT REFERENCES step(id) ON DELETE SET NULL,
	source_id  TEXT REFERENCES source(id) ON DELETE SET NULL,
	note       TEXT
);
CREATE INDEX provenance_claim ON provenance (claim_id);

CREATE TABLE doubt (
	id          TEXT PRIMARY KEY,
	claim_id    TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
	source      TEXT NOT NULL CHECK (source IN ('check_failed', 'contradicted', 'missed_transfer', 'calibration')),
	note        TEXT,
	created_at  TEXT NOT NULL,
	resolved_at TEXT
);
CREATE INDEX doubt_open ON doubt (claim_id) WHERE resolved_at IS NULL;

-- ─── repetition and practice ────────────────────────────────────────────────

CREATE TABLE repeat_item (
	id           TEXT PRIMARY KEY,
	claim_id     TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
	method       TEXT NOT NULL CHECK (method IN ('recall', 'reasoning', 'transfer')),
	stability    REAL,
	difficulty   REAL,
	due_at       TEXT,
	last_rating  TEXT CHECK (last_rating IN ('again', 'hard', 'good', 'easy')),
	reps         INTEGER NOT NULL DEFAULT 0,
	lapses       INTEGER NOT NULL DEFAULT 0,
	created_at   TEXT NOT NULL,
	UNIQUE (claim_id, method)
);
CREATE INDEX repeat_due ON repeat_item (due_at);

CREATE TABLE attempt (
	id              TEXT PRIMARY KEY,
	repeat_item_id  TEXT REFERENCES repeat_item(id) ON DELETE RESTRICT,
	session_id      TEXT REFERENCES session(id) ON DELETE SET NULL,
	claim_id        TEXT REFERENCES claim(id) ON DELETE RESTRICT,
	problem_id      TEXT,
	verdict         TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'partial')),
	rating          TEXT CHECK (rating IN ('again', 'hard', 'good', 'easy')),
	note            TEXT,
	created_at      TEXT NOT NULL
);
CREATE INDEX attempt_claim ON attempt (claim_id, created_at);

-- ─── imported sources ───────────────────────────────────────────────────────

CREATE TABLE source (
	id          TEXT PRIMARY KEY,
	path        TEXT NOT NULL,
	hash        TEXT NOT NULL UNIQUE,
	bytes       INTEGER NOT NULL,
	kind        TEXT NOT NULL,
	status      TEXT NOT NULL CHECK (status IN ('pending', 'imported', 'failed', 'skipped')),
	error       TEXT,
	imported_at TEXT,
	created_at  TEXT NOT NULL
);

CREATE TABLE source_chunk (
	id        TEXT PRIMARY KEY,
	source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
	ordinal   INTEGER NOT NULL,
	text      TEXT NOT NULL,
	hash      TEXT NOT NULL,
	UNIQUE (source_id, ordinal)
);

-- Which transcript entries already went through extraction (idempotency guard).
CREATE TABLE coverage (
	session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
	entry_id     INTEGER NOT NULL REFERENCES transcript_entry(id) ON DELETE CASCADE,
	extracted_at TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_id)
);

-- ─── model configuration ────────────────────────────────────────────────────

CREATE TABLE endpoint (
	id         TEXT PRIMARY KEY,
	label      TEXT NOT NULL,
	base_url   TEXT NOT NULL,
	auth_mode  TEXT NOT NULL CHECK (auth_mode IN ('none', 'api_key')),
	created_at TEXT NOT NULL
);
-- No key material here: keys live in the OS key store (decision D-012).

CREATE TABLE model_info (
	endpoint_id      TEXT NOT NULL REFERENCES endpoint(id) ON DELETE CASCADE,
	model_id         TEXT NOT NULL,
	context_tokens   INTEGER,                 -- NULL means "not measured", never guessed
	max_output_tokens INTEGER,
	supports_tools   INTEGER CHECK (supports_tools IN (0, 1)),
	supports_reasoning INTEGER CHECK (supports_reasoning IN (0, 1)),
	supports_vision  INTEGER CHECK (supports_vision IN (0, 1)),
	embedding_dim    INTEGER,
	tokenizer_source TEXT CHECK (tokenizer_source IN ('file', 'server', 'none')),
	probed_at        TEXT,
	probe_method     TEXT,
	PRIMARY KEY (endpoint_id, model_id)
);

CREATE TABLE role_assignment (
	role        TEXT PRIMARY KEY CHECK (role IN ('teacher', 'probe', 'background', 'embed', 'vision')),
	endpoint_id TEXT NOT NULL REFERENCES endpoint(id) ON DELETE CASCADE,
	model_id    TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);

-- ─── jobs and diagnostics ───────────────────────────────────────────────────

CREATE TABLE job (
	id          TEXT PRIMARY KEY,
	kind        TEXT NOT NULL,
	state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
	payload_json TEXT NOT NULL,
	error       TEXT,
	created_at  TEXT NOT NULL,
	started_at  TEXT,
	finished_at TEXT
);
CREATE INDEX job_queue ON job (state, created_at);

CREATE TABLE event (
	id         INTEGER PRIMARY KEY,
	session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
	kind       TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
-- The buffer is trimmed by the app; the index makes trimming cheap.
CREATE INDEX event_created ON event (created_at);

-- ─── full-text search (hybrid with dense vectors, decision D-040) ───────────

CREATE VIRTUAL TABLE claim_fts USING fts5 (
	text,
	claim_id UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER claim_ai AFTER INSERT ON claim BEGIN
	INSERT INTO claim_fts (text, claim_id) VALUES (new.text, new.id);
END;
CREATE TRIGGER claim_ad AFTER DELETE ON claim BEGIN
	DELETE FROM claim_fts WHERE claim_id = old.id;
END;
CREATE TRIGGER claim_au AFTER UPDATE OF text ON claim BEGIN
	DELETE FROM claim_fts WHERE claim_id = old.id;
	INSERT INTO claim_fts (text, claim_id) VALUES (new.text, new.id);
END;

CREATE VIRTUAL TABLE transcript_fts USING fts5 (
	text,
	session_id UNINDEXED,
	entry_id UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER transcript_ai AFTER INSERT ON transcript_entry BEGIN
	INSERT INTO transcript_fts (text, session_id, entry_id) VALUES (new.text, new.session_id, new.id);
END;
CREATE TRIGGER transcript_ad AFTER DELETE ON transcript_entry BEGIN
	DELETE FROM transcript_fts WHERE entry_id = old.id;
END;

-- Dense vectors: brute-force cosine over these blobs (decision D-004). The
-- column is nullable so a claim can exist before it is embedded.
CREATE TABLE claim_embedding (
	claim_id   TEXT PRIMARY KEY REFERENCES claim(id) ON DELETE CASCADE,
	model_id   TEXT NOT NULL,
	vector     BLOB NOT NULL,
	embedded_at TEXT NOT NULL
);
