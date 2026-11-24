import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// Mirrors the CHECK constraint on session.kind in 001_init.sql.
export const SESSION_KINDS = ["teach", "practice"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

// Mirrors the CHECK constraint on session.state in 001_init.sql.
export const SESSION_STATES = ["probing", "planning", "teaching", "practicing", "closed", "failed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionRow = {
	id: string;
	kind: SessionKind;
	state: SessionState;
	goalId: string | null;
	modelTeacher: string | null;
	modelProbe: string | null;
	contextLimit: number | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
};

function nowIso(): string {
	return new Date().toISOString();
}

function rowToSession(row: Record<string, unknown>): SessionRow {
	return {
		id: row.id as string,
		kind: row.kind as SessionKind,
		state: row.state as SessionState,
		goalId: row.goal_id as string | null,
		modelTeacher: row.model_teacher as string | null,
		modelProbe: row.model_probe as string | null,
		contextLimit: row.context_limit as number | null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		closedAt: row.closed_at as string | null,
	};
}

const SELECT_SESSION =
	"SELECT id, kind, state, goal_id, model_teacher, model_probe, context_limit, created_at, updated_at, closed_at FROM session WHERE id = ?";

export function getSession(db: Database.Database, id: string): SessionRow | undefined {
	const row = db.prepare(SELECT_SESSION).get(id) as Record<string, unknown> | undefined;
	return row ? rowToSession(row) : undefined;
}

function requireSession(db: Database.Database, id: string): void {
	const exists = db.prepare("SELECT 1 FROM session WHERE id = ?").get(id);
	if (!exists) throw new Error(`session not found: ${id}`);
}

export function createSession(
	db: Database.Database,
	input: {
		kind: SessionKind;
		modelTeacher?: string | null;
		modelProbe?: string | null;
		contextLimit?: number | null;
	},
): string {
	if (!SESSION_KINDS.includes(input.kind)) {
		throw new Error(`unknown session kind "${input.kind}"; allowed: ${SESSION_KINDS.join(", ")}`);
	}
	const id = randomUUID();
	const now = nowIso();
	db.prepare(
		`INSERT INTO session (id, kind, state, model_teacher, model_probe, context_limit, created_at, updated_at)
		 VALUES (?, ?, 'probing', ?, ?, ?, ?, ?)`,
	).run(id, input.kind, input.modelTeacher ?? null, input.modelProbe ?? null, input.contextLimit ?? null, now, now);
	return id;
}

export function setSessionState(db: Database.Database, id: string, state: SessionState): void {
	if (!SESSION_STATES.includes(state)) {
		throw new Error(`unknown session state "${state}"; allowed: ${SESSION_STATES.join(", ")}`);
	}
	requireSession(db, id);
	db.prepare("UPDATE session SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), id);
}

export function closeSession(db: Database.Database, id: string): void {
	requireSession(db, id);
	const now = nowIso();
	db.prepare("UPDATE session SET state = 'closed', updated_at = ?, closed_at = ? WHERE id = ?").run(now, now, id);
}
