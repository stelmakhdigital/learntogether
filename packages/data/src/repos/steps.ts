import { randomUUID } from "node:crypto";
import { addChain, addProvenance, foldWording, upsertClaim } from "./graph.ts";
import type Database from "better-sqlite3";
import {
	allowedRatings,
	kindRequiresPremises,
	nextStepState,
	readWrongAnswer,
	stateAfterCheck,
} from "@learntogether/domain";
import type {
	CheckKind,
	CheckVerdict,
	Confidence,
	ProbeState,
	Rating,
	StepKind,
	StepState,
} from "@learntogether/domain";

// Mirrors the CHECK constraint on step.kind in 001_init.sql.
export const STEP_KINDS: readonly StepKind[] = ["derivation", "foundation"];

// Mirrors the CHECK constraint on step_check.kind in 001_init.sql.
export const CHECK_KINDS: readonly CheckKind[] = [
	"single_choice",
	"multi_choice",
	"free_recall",
	"predict",
	"find_error",
	"transfer",
];

// Mirrors the CHECK constraint on step_check.verdict in 001_init.sql.
export const CHECK_VERDICTS: readonly CheckVerdict[] = ["correct", "incorrect", "partial"];

/** A choice answer is an index into `options`; a free-recall answer is the
 *  recalled text itself (docs/tool-contracts.md, level 2). */
export type StepAnswer = number | string;

export type CheckOption = { label: string; text?: string };

export type StepRow = {
	id: string;
	sessionId: string;
	planNodeId: string | null;
	ordinal: number;
	statement: string;
	kind: StepKind;
	premises: string[];
	motivation: string | null;
	state: StepState;
	createdAt: string;
	checkCount: number;
};

export type CheckRow = {
	id: string;
	stepId: string;
	kind: CheckKind;
	question: string;
	options: CheckOption[];
	optionsShuffled: string[];
	answer: StepAnswer;
	why: string | null;
	askConfidence: boolean;
	learnerAnswer: StepAnswer | null;
	verdict: CheckVerdict | null;
	confidence: Confidence | null;
	hints: number;
	createdAt: string;
	answeredAt: string | null;
};

function nowIso(): string {
	return new Date().toISOString();
}

function parseJsonArray(raw: string | null): unknown[] {
	if (raw === null || raw === "") return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`expected a JSON array, got: ${raw}`);
	return parsed;
}

function requireStepRow(db: Database.Database, stepId: string): Record<string, unknown> {
	const row = db.prepare("SELECT * FROM step WHERE id = ?").get(stepId) as Record<string, unknown> | undefined;
	if (!row) throw new Error(`step not found: ${stepId}`);
	return row;
}

function stepStateOf(row: Record<string, unknown>): StepState {
	return row.state as StepState;
}

/** Referential integrity of an answer against the option list, checked at the
 *  door so a dangling index never reaches storage (docs/tool-contracts.md). */
function requireValidAnswer(answer: StepAnswer, options: readonly CheckOption[], field: string): void {
	if (typeof answer === "number") {
		if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
			throw new Error(
				`${field} "${answer}" does not reference an existing option; allowed indexes: 0..${options.length - 1}`,
			);
		}
		return;
	}
	if (typeof answer === "string" && answer.trim() !== "") return;
	throw new Error(`${field} must be an option index or a non-empty free-recall string, got: ${JSON.stringify(answer)}`);
}

export function createStep(
	db: Database.Database,
	input: {
		sessionId: string;
		planNodeId?: string;
		statement: string;
		kind: StepKind;
		premises?: string[];
		motivation?: string;
	},
): { id: string; ordinal: number } {
	if (!STEP_KINDS.includes(input.kind)) {
		throw new Error(`unknown step kind "${input.kind}"; allowed: ${STEP_KINDS.join(", ")}`);
	}
	const premises = input.premises ?? [];
	if (kindRequiresPremises(input.kind) && premises.length === 0) {
		throw new Error(`step kind "${input.kind}" requires at least one premise`);
	}
	if (!kindRequiresPremises(input.kind) && premises.length > 0) {
		throw new Error(`step kind "${input.kind}" must have empty premises: a foundation is not derived from anything`);
	}
	// The same wording twice in one lesson is the model losing its own state, not
	// a second step. The refusal names the id so the next call can use it.
	const duplicate = db
		.prepare("SELECT id, ordinal FROM step WHERE session_id = ? AND statement = ? COLLATE NOCASE")
		.get(input.sessionId, input.statement.trim()) as { id: string; ordinal: number } | undefined;
	if (duplicate !== undefined) {
		throw new Error(
			`шаг с такой формулировкой уже записан под номером ${duplicate.ordinal} (id ${duplicate.id}) — работай с ним, а не записывай второй`,
		);
	}
	const id = randomUUID();
	// Same append rule as transcript_entry: MAX+1 and INSERT share one
	// transaction so concurrent steps cannot collide on UNIQUE (session_id, ordinal).
	const run = db.transaction((): { id: string; ordinal: number } => {
		const next = db
			.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM step WHERE session_id = ?")
			.get(input.sessionId) as { next: number };
		// The first recorded step is the lesson starting: the session stops being a
		// measurement or an intention and becomes a teaching run.
		db.prepare("UPDATE session SET state = 'teaching', updated_at = ? WHERE id = ? AND state IN ('probing','planning')").run(
			nowIso(),
			input.sessionId,
		);
		db.prepare(
			`INSERT INTO step (id, session_id, plan_node_id, ordinal, statement, kind, premises_json, motivation, state, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
		).run(
			id,
			input.sessionId,
			input.planNodeId ?? null,
			next.next,
			input.statement,
			input.kind,
			JSON.stringify(premises),
			input.motivation ?? null,
			nowIso(),
		);
		return { id, ordinal: next.next };
	});
	return run();
}

export function presentStep(db: Database.Database, stepId: string): StepState {
	const state = stepStateOf(requireStepRow(db, stepId));
	const next = nextStepState(state, "present");
	if (typeof next !== "string") {
		throw new Error(`cannot present step ${stepId}: ${next.error}`);
	}
	db.prepare("UPDATE step SET state = ? WHERE id = ?").run(next, stepId);
	return next;
}

export function recordCheck(
	db: Database.Database,
	input: {
		stepId: string;
		kind: CheckKind;
		question: string;
		options?: CheckOption[];
		/** Labels in the order the learner was shown them; kept apart from the
		 *  canonical order so calibration stays auditable (docs/tool-contracts.md). */
		optionsShuffled?: string[];
		answer: StepAnswer;
		why?: string;
		askConfidence?: boolean;
	},
): string {
	if (!CHECK_KINDS.includes(input.kind)) {
		throw new Error(`unknown check kind "${input.kind}"; allowed: ${CHECK_KINDS.join(", ")}`);
	}
	const options = input.options ?? [];
	const seen = new Set<string>();
	for (const option of options) {
		if (seen.has(option.label)) {
			throw new Error(`duplicate option label "${option.label}" in check options`);
		}
		seen.add(option.label);
	}
	requireValidAnswer(input.answer, options, "answer");

	const step = requireStepRow(db, input.stepId);
	const state = stepStateOf(step);
	if (state !== "presented") {
		throw new Error(`a check belongs to a presented step; step ${input.stepId} is "${state}"`);
	}
	// One check waits for the learner at a time. A second one while the first is
	// unanswered is the model answering its own question (seen live 2026-11-28: it
	// opened a check, then praised an answer the learner never gave).
	const waiting = db
		.prepare("SELECT id FROM step_check WHERE step_id = ? AND answered_at IS NULL")
		.get(input.stepId) as { id: string } | undefined;
	if (waiting !== undefined) {
		throw new Error(
			`шаг ${step.ordinal} уже ждёт ответа на проверку ${waiting.id} — вторая откроется, когда ученик ответит на первую`,
		);
	}

	const id = randomUUID();
	db.prepare(
		`INSERT INTO step_check (id, step_id, kind, question, options_json, options_shuffled_json, answer_json, why, ask_confidence, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.stepId,
		input.kind,
		input.question,
		JSON.stringify(options),
		JSON.stringify(input.optionsShuffled ?? []),
		JSON.stringify(input.answer),
		input.why ?? null,
		input.askConfidence === false ? 0 : 1,
		nowIso(),
	);
	return id;
}

/** What the learner holds becomes a node of the graph, with the premises of the
 *  step as the chain that holds it and a provenance row pointing back at the step.
 *  Growth of the graph from the lesson — not from a later import — is what lets the
 *  next lesson prune what is already held. */
function installClaim(db: Database.Database, step: Record<string, unknown>): void {
	const premises = JSON.parse((step.premises_json as string) || "[]") as string[];
	const statement = step.statement as string;
	if (statement.trim() === "") return;
	const { id } = upsertClaim(db, { text: statement });
	if (premises.length > 0) {
		// A premise names a step of this lesson or a wording already in the graph;
		// anything unknown is left out rather than invented as a node.
		const resolved = premises
			.map((premise) => {
				const byStatement = db
					.prepare("SELECT statement FROM step WHERE id = ? AND session_id = ?")
					.get(premise, step.session_id) as { statement: string } | undefined;
				const wording = byStatement?.statement ?? premise;
				return db.prepare("SELECT id FROM claim WHERE norm = ?").get(foldWording(wording)) as
					| { id: string }
					| undefined;
			})
			.filter((found): found is { id: string } => found !== undefined)
			.map((found) => found.id);
		if (resolved.length > 0) addChain(db, { conclusionId: id, premiseIds: resolved });
	}
	addProvenance(db, { claimId: id, sessionId: step.session_id as string, stepId: step.id as string });
}

export function resolveCheck(
	db: Database.Database,
	checkId: string,
	input: {
		learnerAnswer: StepAnswer;
		verdict: CheckVerdict;
		confidence: Confidence;
		hints?: number;
		rating?: Rating;
		/** Set by the caller after the "why" follow-up: true when the learner's
		 *  reasoning was itself wrong (a misconception), not merely absent. */
		wrongReasoning?: boolean;
	},
): { stepState: StepState; probeState: ProbeState } {
	if (!CHECK_VERDICTS.includes(input.verdict)) {
		throw new Error(`unknown verdict "${input.verdict}"; allowed: ${CHECK_VERDICTS.join(", ")}`);
	}
	const hints = input.hints ?? 0;
	if (!Number.isInteger(hints) || hints < 0) {
		throw new Error(`hints must be an integer >= 0, got: ${hints}`);
	}
	if (!Number.isInteger(input.confidence) || input.confidence < 1 || input.confidence > 5) {
		throw new Error(`confidence must be an integer 1..5, got: ${input.confidence}`);
	}
	// Self-grading cannot exceed what the verdict allows (decision D-037).
	if (input.rating !== undefined && !allowedRatings(input.verdict, hints).includes(input.rating)) {
		const allowed = allowedRatings(input.verdict, hints)
			.map((rating) => `"${rating}"`)
			.join(", ");
		throw new Error(
			`rating "${input.rating}" is not allowed for verdict "${input.verdict}" with ${hints} hint(s); allowed: ${allowed}`,
		);
	}

	const run = db.transaction((): { stepState: StepState; probeState: ProbeState } => {
		const check = db.prepare("SELECT * FROM step_check WHERE id = ?").get(checkId) as
			| Record<string, unknown>
			| undefined;
		if (!check) throw new Error(`check not found: ${checkId}`);
		if (check.answered_at !== null) throw new Error(`check ${checkId} is already answered`);

		const options = parseJsonArray(check.options_json as string | null) as CheckOption[];
		requireValidAnswer(input.learnerAnswer, options, "learnerAnswer");

		const step = requireStepRow(db, check.step_id as string);
		const stepState = nextStepState(stepStateOf(step), input.verdict === "correct" ? "check_passed" : "check_failed");
		if (typeof stepState !== "string") {
			throw new Error(`cannot resolve check ${checkId}: ${stepState.error}`);
		}

		// An empty answer is "does not know"; only a wrong "why" makes it a
		// misconception, and only the caller can have learned that.
		const hasAttempt = typeof input.learnerAnswer === "string" ? input.learnerAnswer.trim() !== "" : true;
		const read = readWrongAnswer(hasAttempt, check.why !== null, input.wrongReasoning ?? false);
		const probeState = stateAfterCheck(input.verdict, hints, read);

		db.prepare(
			`UPDATE step_check SET learner_answer_json = ?, verdict = ?, confidence = ?, hints = ?, answered_at = ? WHERE id = ?`,
		).run(
			JSON.stringify(input.learnerAnswer),
			input.verdict,
			input.confidence,
			hints,
			nowIso(),
			checkId,
		);
		db.prepare("UPDATE step SET state = ? WHERE id = ?").run(stepState, check.step_id);
		if (stepState === "accepted") installClaim(db, step);
		return { stepState, probeState };
	});
	return run();
}

// The step machine has no separate "accept" event: resolving the check with a
// correct verdict already moves the step to accepted. acceptStep is then the
// invariant gate the app must pass before building on the step (the DB alone
// cannot express "no acceptance without a passed check", see 001_init.sql).
export function acceptStep(db: Database.Database, stepId: string): void {
	const step = requireStepRow(db, stepId);
	const passed = db
		.prepare("SELECT 1 FROM step_check WHERE step_id = ? AND verdict = 'correct' LIMIT 1")
		.get(stepId);
	if (!passed) {
		throw new Error(
			`step ${stepId} has no check with verdict "correct"; record a check on the presented step and resolve it before accepting`,
		);
	}
	const state = stepStateOf(step);
	if (state !== "accepted") {
		throw new Error(
			`cannot accept step ${stepId} in state "${state}": acceptance is recorded by resolving its check with a correct verdict`,
		);
	}
}

function rowToStep(row: Record<string, unknown>): StepRow {
	return {
		id: row.id as string,
		sessionId: row.session_id as string,
		planNodeId: row.plan_node_id as string | null,
		ordinal: row.ordinal as number,
		statement: row.statement as string,
		kind: row.kind as StepKind,
		premises: parseJsonArray(row.premises_json as string | null) as string[],
		motivation: row.motivation as string | null,
		state: row.state as StepState,
		createdAt: row.created_at as string,
		checkCount: row.check_count as number,
	};
}

export function stepsForSession(db: Database.Database, sessionId: string): StepRow[] {
	const rows = db
		.prepare(
			`SELECT s.*, (SELECT COUNT(*) FROM step_check c WHERE c.step_id = s.id) AS check_count
			 FROM step s WHERE s.session_id = ? ORDER BY s.ordinal ASC`,
		)
		.all(sessionId) as Record<string, unknown>[];
	return rows.map(rowToStep);
}

/** The checks of this session that are still waiting for an answer. */
export function openChecksForSession(db: Database.Database, sessionId: string): CheckRow[] {
	const rows = db
		.prepare(
			`SELECT c.* FROM step_check c
			 JOIN step s ON s.id = c.step_id
			 WHERE s.session_id = ? AND c.answered_at IS NULL
			 ORDER BY c.rowid ASC`,
		)
		.all(sessionId) as Record<string, unknown>[];
	return rows.map(rowToCheck);
}

function rowToCheck(row: Record<string, unknown>): CheckRow {
	const confidence = row.confidence as number | null;
	return {
		id: row.id as string,
		stepId: row.step_id as string,
		kind: row.kind as CheckKind,
		question: row.question as string,
		options: parseJsonArray(row.options_json as string | null) as CheckOption[],
		optionsShuffled: parseJsonArray(row.options_shuffled_json as string | null) as string[],
		answer: JSON.parse(row.answer_json as string) as StepAnswer,
		why: row.why as string | null,
		askConfidence: row.ask_confidence === 1,
		learnerAnswer: row.learner_answer_json === null ? null : (JSON.parse(row.learner_answer_json as string) as StepAnswer),
		verdict: row.verdict as CheckVerdict | null,
		confidence: confidence === null ? null : (confidence as Confidence),
		hints: row.hints as number,
		createdAt: row.created_at as string,
		answeredAt: row.answered_at as string | null,
	};
}

// Creation order, not id order: repaired steps get a second check and the
// history must read in the order the learner met them.
export function checksForStep(db: Database.Database, stepId: string): CheckRow[] {
	const rows = db.prepare("SELECT * FROM step_check WHERE step_id = ? ORDER BY rowid ASC").all(stepId) as Record<
		string,
		unknown
	>[];
	return rows.map(rowToCheck);
}
