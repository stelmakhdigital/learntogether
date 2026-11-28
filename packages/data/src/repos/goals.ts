// The goal of a lesson: what the learner will be able to do, in statements, plus
// the criterion that says it happened. A vague request is refined into these
// statements before anything is taught (docs/teaching-method.md section 2).

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type GoalRow = {
	id: string;
	raw: string;
	statements: string[];
	readyWhen: string | null;
	createdAt: string;
	updatedAt: string;
};

function rowToGoal(row: Record<string, unknown>): GoalRow {
	return {
		id: row.id as string,
		raw: row.raw as string,
		statements: JSON.parse(row.statements_json as string) as string[],
		readyWhen: (row.ready_when as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function requireText(value: string, field: string): string {
	const text = value.trim();
	if (text === "") throw new Error(`${field}: нужна формулировка, получила пустую строку`);
	return text;
}

/**
 * Points a session at a goal, refining the words the learner typed into the
 * statements that will be taught. `readyWhen` is required: without a criterion
 * there is nothing to check the lesson against, and "разобрался" is not a state.
 *
 * A session carries one goal. Calling this again refines that same row rather
 * than leaving orphan goals behind, which would make the history unreadable.
 */
export function setSessionGoal(
	db: Database.Database,
	input: { sessionId: string; raw: string; statements: string[]; readyWhen: string },
): string {
	const raw = requireText(input.raw, "raw");
	const readyWhen = requireText(input.readyWhen, "readyWhen");
	if (input.statements.length === 0) {
		throw new Error("statements: нужен хотя бы один пункт — цель без формулировки не проверяется");
	}
	const statements = input.statements.map((statement, index) => requireText(statement, `statements[${index}]`));

	const session = db
		.prepare("SELECT id, goal_id, state FROM session WHERE id = ?")
		.get(input.sessionId) as { goal_id: string | null; id: string; state: string } | undefined;
	if (session === undefined) throw new Error(`сессии ${input.sessionId} нет`);

	const now = new Date().toISOString();
	// A goal ends the measuring phase: from here the lesson is planning, and the
	// session row says so rather than a caller remembering to say it.
	if (session.state === "probing") {
		db.prepare("UPDATE session SET state = 'planning', updated_at = ? WHERE id = ?").run(now, input.sessionId);
	}
	if (session.goal_id === null) {
		const id = randomUUID();
		db.prepare("INSERT INTO goal (id, raw, statements_json, ready_when, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
			id,
			raw,
			JSON.stringify(statements),
			readyWhen,
			now,
			now,
		);
		db.prepare("UPDATE session SET goal_id = ?, updated_at = ? WHERE id = ?").run(id, now, input.sessionId);
		return id;
	}
	db.prepare("UPDATE goal SET raw = ?, statements_json = ?, ready_when = ?, updated_at = ? WHERE id = ?").run(
		raw,
		JSON.stringify(statements),
		readyWhen,
		now,
		session.goal_id,
	);
	db.prepare("UPDATE session SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
	return session.goal_id;
}

/** The goal of a session, or null while the lesson is still probing. */
export function goalForSession(db: Database.Database, sessionId: string): GoalRow | null {
	const row = db
		.prepare("SELECT g.* FROM goal g JOIN session s ON s.goal_id = g.id WHERE s.id = ?")
		.get(sessionId) as Record<string, unknown> | undefined;
	return row === undefined ? null : rowToGoal(row);
}
