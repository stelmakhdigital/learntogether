// Practice problems (docs/teaching-method.md section 6): the statement and the
// reference are stored before the learner answers, the statement may not name the
// topic, and one node never comes back in the same wording.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { allowedRatings, sameProblemText, termLeaked, type CheckVerdict, type Rating } from "@learntogether/domain";
import { createRepeatItem, REPEAT_METHODS, reviewRepeatItem, type RepeatMethod } from "./repeats.ts";

export type ProblemRow = {
	claimId: string;
	hints: string[];
	id: string;
	method: RepeatMethod;
	solution: string;
	statement: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}: нужна непустая строка`);
	return value.trim();
}

/** The node's wording, so a refusal can name where the leak came from. */
function claimWording(db: Database.Database, claimId: string): string {
	const row = db.prepare("SELECT text FROM claim WHERE id = ?").get(claimId) as { text: string } | undefined;
	if (row === undefined) throw new Error(`узла ${claimId} нет в графе`);
	return row.text;
}

/**
 * A problem is declared before the learner answers: statement, reference solution and
 * the hints that will fade. Two rules of the method are checked mechanically here,
 * not requested (docs/teaching-method.md section 6): the statement must not name the
 * topic, and one node never comes back in the same wording.
 */
export function createProblem(
	db: Database.Database,
	input: { claimId: string; hints?: string[]; method: RepeatMethod; sessionId?: string; solution: string; statement: string },
): string {
	if (!REPEAT_METHODS.includes(input.method)) {
		throw new Error(`method "${input.method}" неизвестен; нужны ${REPEAT_METHODS.join(", ")}`);
	}
	const wording = claimWording(db, input.claimId);
	const statement = requireText(input.statement, "statement");
	const solution = requireText(input.solution, "solution");
	const leaked = termLeaked(statement, wording);
	if (leaked !== null) {
		throw new Error(
			`условие называет тему словом «${leaked}» — с таким условием измеряется узнавание, а не припоминание; перескажи сюжетом`,
		);
	}
	const previous = db.prepare("SELECT statement FROM problem WHERE claim_id = ? AND method = ?").all(input.claimId, input.method) as {
		statement: string;
	}[];
	const twin = previous.find((row) => sameProblemText(row.statement, statement));
	if (twin !== undefined) {
		throw new Error("такая формулировка задачи для этого узла уже была — возьми другой сюжет, нотацию или роль");
	}

	const hints = input.hints ?? [];
	for (const [index, hint] of hints.entries()) requireText(hint, `hints[${index}]`);
	if (input.sessionId !== undefined && !db.prepare("SELECT 1 FROM session WHERE id = ?").get(input.sessionId)) {
		throw new Error(`сессии ${input.sessionId} нет`);
	}

	const id = randomUUID();
	db.prepare(
		"INSERT INTO problem (id, claim_id, session_id, method, statement, solution, hints_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(id, input.claimId, input.sessionId ?? null, input.method, statement, solution, JSON.stringify(hints), nowIso());
	return id;
}

/** The reference the answer is compared with, plus the hints in the order they were
 *  offered. The teacher reads it; the learner must not see it before answering. */
export function readProblem(db: Database.Database, problemId: string): ProblemRow {
	const row = db.prepare("SELECT * FROM problem WHERE id = ?").get(problemId) as Record<string, unknown> | undefined;
	if (row === undefined) throw new Error(`задачи ${problemId} нет`);
	return {
		claimId: row.claim_id as string,
		hints: JSON.parse(row.hints_json as string) as string[],
		id: row.id as string,
		method: row.method as RepeatMethod,
		solution: row.solution as string,
		statement: row.statement as string,
	};
}

/** The outcome of one problem: the attempt is stored and the rating goes to the
 *  scheduler of the item for this node and form. D-037 is enforced here — an answer
 *  that is wrong at its core cannot buy a high rating. */
export function recordProblemOutcome(
	db: Database.Database,
	problemId: string,
	input: { at?: string; hintCount?: number; note?: string; rating: Rating; verdict: CheckVerdict },
): { intervalDays: number | null; minutes: number | null } {
	const problem = readProblem(db, problemId);
	const hints = input.hintCount ?? 0;
	const allowed = allowedRatings(input.verdict, hints);
	if (!allowed.includes(input.rating)) {
		throw new Error(
			`rating "${input.rating}" недоступна при вердикте "${input.verdict}" и ${hints} подсказках; доступны: ${allowed.join(", ")}`,
		);
	}
	const outcome = db.transaction(() => {
		const itemId = createRepeatItem(db, { claimId: problem.claimId, method: problem.method });
		return reviewRepeatItem(db, itemId, {
			...(input.at === undefined ? {} : { at: input.at }),
			problemId,
			rating: input.rating,
			...(input.note === undefined ? {} : { verdictNote: input.note }),
		});
	})();
	return { intervalDays: outcome.intervalDays, minutes: outcome.minutes };
}

/** Problems already posed for a node: the teacher needs them to avoid repeating a
 *  form, and the learner should not meet the same story twice. */
export function problemsForClaim(db: Database.Database, claimId: string): ProblemRow[] {
	const rows = db
		.prepare("SELECT * FROM problem WHERE claim_id = ? ORDER BY created_at, id")
		.all(claimId) as Record<string, unknown>[];
	return rows.map((row) => ({
		claimId: row.claim_id as string,
		hints: JSON.parse(row.hints_json as string) as string[],
		id: row.id as string,
		method: row.method as RepeatMethod,
		solution: row.solution as string,
		statement: row.statement as string,
	}));
}
