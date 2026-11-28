import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// A side question lives next to the lesson, not inside
// it: the learner asks something for themselves, the helper answers briefly, and the
// lesson keeps its own record. Deleting the session takes the threads with it.

export type SideRole = "helper" | "learner";

export type SideThreadRow = {
	createdAt: string;
	id: string;
	sessionId: string;
	stepId: string | null;
};

export type SideMessageRow = {
	ordinal: number;
	role: SideRole;
	text: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

export function createSideThread(
	db: Database.Database,
	input: { sessionId: string; stepId?: string | null; threadId?: string },
): string {
	const id = input.threadId ?? randomUUID();
	db.prepare("INSERT INTO side_thread (id, session_id, step_id, created_at) VALUES (?, ?, ?, ?)").run(
		id,
		input.sessionId,
		input.stepId ?? null,
		nowIso(),
	);
	return id;
}

export function sideThread(db: Database.Database, threadId: string): SideThreadRow | undefined {
	const row = db
		.prepare(
			`SELECT id, session_id, step_id, created_at FROM side_thread
			 WHERE id = ?`,
		)
		.get(threadId) as { created_at: string; id: string; session_id: string; step_id: string | null } | undefined;
	return row === undefined
		? undefined
		: { createdAt: row.created_at, id: row.id, sessionId: row.session_id, stepId: row.step_id };
}

export function sideThreads(db: Database.Database, sessionId: string): SideThreadRow[] {
	const rows = db
		.prepare(
			`SELECT id, session_id, step_id, created_at FROM side_thread
			 WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
		)
		.all(sessionId) as { created_at: string; id: string; session_id: string; step_id: string | null }[];
	return rows.map((row) => ({ createdAt: row.created_at, id: row.id, sessionId: row.session_id, stepId: row.step_id }));
}

/** Appends to a thread and returns the ordinal it got. The ordinal is dense per
 *  thread: a window that shows three answers asks for the fourth, not for a cursor. */
export function appendSideMessage(db: Database.Database, threadId: string, role: SideRole, text: string): number {
	const next = (db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM side_message WHERE thread_id = ?").get(threadId) as {
		n: number;
	}).n;
	db.prepare("INSERT INTO side_message (thread_id, ordinal, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
		threadId,
		next,
		role,
		text,
		nowIso(),
	);
	return next;
}

/** What the learner heard and said, in order, with no tool traffic and no compaction
 *  summary: the reconstruction the side helper is allowed to read (D-078). */
export function liveTextEntries(db: Database.Database, sessionId: string): { role: "learner" | "teacher"; text: string }[] {
	return db
		.prepare(
			`SELECT role, text FROM transcript_entry
			 WHERE session_id = ? AND kind = 'text' AND role IN ('learner', 'teacher') AND text <> ''
			 ORDER BY ordinal ASC`,
		)
		.all(sessionId) as { role: "learner" | "teacher"; text: string }[];
}

export function sideMessages(db: Database.Database, threadId: string, afterOrdinal = 0): SideMessageRow[] {
	const rows = db
		.prepare(
			`SELECT ordinal, role, text FROM side_message
			 WHERE thread_id = ? AND ordinal > ? ORDER BY ordinal ASC`,
		)
		.all(threadId, afterOrdinal) as { ordinal: number; role: SideRole; text: string }[];
	return rows;
}
