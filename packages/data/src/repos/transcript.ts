import type Database from "better-sqlite3";

// Mirrors the CHECK constraints on transcript_entry in 001_init.sql.
export const ENTRY_KINDS = ["text", "thinking", "tool_call", "tool_result", "system_note", "compaction"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_ROLES = ["teacher", "learner", "system"] as const;
export type EntryRole = (typeof ENTRY_ROLES)[number];

export type EntryRow = {
	id: number;
	sessionId: string;
	ordinal: number;
	kind: EntryKind;
	role: EntryRole;
	text: string;
	thinking: string | null;
	createdAt: string;
};

export type SearchHit = {
	entryId: number;
	sessionId: string;
	ordinal: number;
	text: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function rowToEntry(row: Record<string, unknown>): EntryRow {
	return {
		id: row.id as number,
		sessionId: row.session_id as string,
		ordinal: row.ordinal as number,
		kind: row.kind as EntryKind,
		role: row.role as EntryRole,
		text: row.text as string,
		thinking: row.thinking as string | null,
		createdAt: row.created_at as string,
	};
}

// Append-only per entry (decision D-020): the next ordinal is read and the row
// inserted inside one transaction, so concurrent appends cannot collide on
// UNIQUE (session_id, ordinal).
export function appendEntry(
	db: Database.Database,
	input: {
		sessionId: string;
		kind: EntryKind;
		role: EntryRole;
		text: string;
		thinking?: string | null;
	},
): { id: number; ordinal: number } {
	if (!ENTRY_KINDS.includes(input.kind)) {
		throw new Error(`unknown entry kind "${input.kind}"; allowed: ${ENTRY_KINDS.join(", ")}`);
	}
	if (!ENTRY_ROLES.includes(input.role)) {
		throw new Error(`unknown entry role "${input.role}"; allowed: ${ENTRY_ROLES.join(", ")}`);
	}
	const run = db.transaction((): { id: number; ordinal: number } => {
		const next = db
			.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM transcript_entry WHERE session_id = ?")
			.get(input.sessionId) as { next: number };
		const info = db
			.prepare(
				`INSERT INTO transcript_entry (session_id, ordinal, kind, role, text, thinking, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(input.sessionId, next.next, input.kind, input.role, input.text, input.thinking ?? null, nowIso());
		return { id: Number(info.lastInsertRowid), ordinal: next.next };
	});
	return run();
}

const SELECT_ENTRY =
	"SELECT id, session_id, ordinal, kind, role, text, thinking, created_at FROM transcript_entry";

export function entries(
	db: Database.Database,
	sessionId: string,
	options: { afterOrdinal?: number; limit?: number } = {},
): EntryRow[] {
	const afterOrdinal = options.afterOrdinal ?? 0;
	const limit = options.limit ?? 50;
	const rows = db
		.prepare(`${SELECT_ENTRY} WHERE session_id = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?`)
		.all(sessionId, afterOrdinal, limit) as Record<string, unknown>[];
	return rows.map(rowToEntry);
}

export function searchEntries(
	db: Database.Database,
	query: string,
	options: { sessionId?: string; limit?: number } = {},
): SearchHit[] {
	const limit = options.limit ?? 20;
	const sessionFilter = options.sessionId !== undefined ? "AND f.session_id = ?" : "";
	// bm25() is a cost: lower is better, so plain ascending order ranks best first.
	const rows = db
		.prepare(
			`SELECT t.id AS entry_id, t.session_id AS session_id, t.ordinal AS ordinal, t.text AS text
			 FROM transcript_fts f
			 JOIN transcript_entry t ON t.id = f.entry_id
			 WHERE transcript_fts MATCH ? ${sessionFilter}
			 ORDER BY bm25(transcript_fts)
			 LIMIT ?`,
		)
		.all(query, ...(options.sessionId !== undefined ? [options.sessionId] : []), limit) as Record<
			string,
			unknown
		>[];
	return rows.map((row) => ({
		entryId: row.entry_id as number,
		sessionId: row.session_id as string,
		ordinal: row.ordinal as number,
		text: row.text as string,
	}));
}
