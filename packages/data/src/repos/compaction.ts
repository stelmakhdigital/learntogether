// Compaction state (docs/architecture.md «Хранилище»): one active summary per
// session plus a watermark. Entries at or below the watermark are folded into the
// summary text and are not sent to the model any more. Folding never edits
// history — the readable export and the search keep every message, the prompt is
// what shrinks.

import type Database from "better-sqlite3";

export type SummaryRow = {
	/** Entries with ordinal <= watermark are represented by `text`. */
	watermark: number;
	text: string;
	updatedAt: string;
};

function rowToSummary(row: Record<string, unknown>): SummaryRow {
	return {
		text: row.summary as string,
		updatedAt: row.updated_at as string,
		watermark: row.watermark as number,
	};
}

/** The active summary, or null while the session still fits whole. */
export function activeSummary(db: Database.Database, sessionId: string): SummaryRow | null {
	const row = db
		.prepare("SELECT watermark, summary, updated_at FROM compaction WHERE session_id = ?")
		.get(sessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : rowToSummary(row);
}

/** Folds everything up to and including `throughOrdinal` into the summary.
 *  Refuses to fold backwards: a watermark that moves back would drop the part of
 *  the lesson the current summary stands for, and the model would silently lose
 *  it — it cannot re-read a message that is above the new watermark. */
export function foldTranscript(
	db: Database.Database,
	input: { sessionId: string; throughOrdinal: number; text: string },
): SummaryRow {
	if (input.text.trim() === "") {
		throw new Error("a summary needs text; an empty fold would erase the lesson from the prompt");
	}
	if (!Number.isInteger(input.throughOrdinal) || input.throughOrdinal < 1) {
		throw new Error(`watermark must be a positive ordinal, got: ${input.throughOrdinal}`);
	}
	const current = activeSummary(db, input.sessionId);
	if (current !== null && input.throughOrdinal <= current.watermark) {
		throw new Error(
			`watermark cannot move back: the active summary covers ordinal ${current.watermark}, asked to fold through ${input.throughOrdinal}`,
		);
	}
	const updatedAt = new Date().toISOString();
	db.prepare(
		`INSERT INTO compaction (session_id, watermark, summary, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET watermark = excluded.watermark, summary = excluded.summary, updated_at = excluded.updated_at`,
	).run(input.sessionId, input.throughOrdinal, input.text, updatedAt);
	return { text: input.text, updatedAt, watermark: input.throughOrdinal };
}
