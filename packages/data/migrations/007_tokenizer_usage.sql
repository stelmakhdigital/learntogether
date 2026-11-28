-- A third way to count a prompt exactly. vLLM has no /apply-template (404 on the
-- live server 2026-11-29), so the prompt of a request can only be read from the
-- usage the server itself reports for that request — hence 'usage'. SQLite cannot
-- widen a CHECK in place, so the table is rebuilt. Nothing references model_info,
-- so the copy is the whole migration; the runner already wraps the file in a
-- transaction, and PRAGMA foreign_keys would be a no-op inside one.

CREATE TABLE model_info_new (
	endpoint_id      TEXT NOT NULL REFERENCES endpoint(id) ON DELETE CASCADE,
	model_id         TEXT NOT NULL,
	context_tokens   INTEGER,                 -- NULL means "not measured", never guessed
	max_output_tokens INTEGER,
	supports_tools   INTEGER CHECK (supports_tools IN (0, 1)),
	supports_reasoning INTEGER CHECK (supports_reasoning IN (0, 1)),
	supports_vision  INTEGER CHECK (supports_vision IN (0, 1)),
	embedding_dim    INTEGER,
	tokenizer_source TEXT CHECK (tokenizer_source IN ('file', 'server', 'usage', 'none')),
	probed_at        TEXT,
	probe_method     TEXT,
	PRIMARY KEY (endpoint_id, model_id)
);

INSERT INTO model_info_new SELECT * FROM model_info;
DROP TABLE model_info;
ALTER TABLE model_info_new RENAME TO model_info;
