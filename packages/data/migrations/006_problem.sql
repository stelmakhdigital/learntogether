-- A practice problem differs from a step check by carrying its own reference
-- solution and its fading hints. One node per problem: practice has to reference the
-- graph (D-009).

CREATE TABLE problem (
	id         TEXT PRIMARY KEY,
	claim_id   TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES session(id) ON DELETE SET NULL,
	method     TEXT NOT NULL CHECK (method IN ('recall', 'reasoning', 'transfer')),
	statement  TEXT NOT NULL,
	solution   TEXT NOT NULL,
	hints_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
);
CREATE INDEX problem_claim ON problem (claim_id, method);
