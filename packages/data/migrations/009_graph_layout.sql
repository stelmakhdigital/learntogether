-- Where a node sits on the screen is a fact about the learner's reading of the graph,
-- not about the graph's logic: nothing in the method depends on it, so it is stored
-- apart and never read by the teacher's context (D-079).
-- Positions survive because a person arranged them; a re-layout is a choice the learner
-- makes, not something an import is allowed to do under their hand.

CREATE TABLE node_position (
	node_id    TEXT PRIMARY KEY REFERENCES claim(id) ON DELETE CASCADE,
	x          REAL NOT NULL,
	y          REAL NOT NULL,
	hidden     INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

-- One row per knob of the graph view (node scale, label visibility, edge style).
-- Keys are ours; an extension asks for its own key rather than inventing a table.
CREATE TABLE graph_setting (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
