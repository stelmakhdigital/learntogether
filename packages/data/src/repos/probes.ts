import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { readWrongAnswer, stateAfterCheck } from "@learntogether/domain";
import type { CheckVerdict, Confidence, ProbeState } from "@learntogether/domain";

// Mirrors the CHECK constraint on probe_item.state in 001_init.sql.
export const PROBE_STATES = ["held", "frontier", "absent", "contradicted"] as const;

export type ProbeRow = {
	id: string;
	sessionId: string;
	goalId: string | null;
	statement: string;
	state: ProbeState;
	confidence: number | null;
	basisEntryId: number | null;
	createdAt: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function requireProbeState(state: ProbeState): void {
	if (!PROBE_STATES.includes(state)) {
		throw new Error(`unknown probe state "${state}"; allowed: ${PROBE_STATES.join(", ")}`);
	}
}

function requireConfidence(confidence: Confidence): void {
	if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
		throw new Error(`confidence must be an integer 1..5, got: ${confidence}`);
	}
}

function rowToProbe(row: Record<string, unknown>): ProbeRow {
	return {
		id: row.id as string,
		sessionId: row.session_id as string,
		goalId: row.goal_id as string | null,
		statement: row.statement as string,
		state: row.state as ProbeState,
		confidence: row.confidence as number | null,
		basisEntryId: row.basis_entry_id as number | null,
		createdAt: row.created_at as string,
	};
}

/** One active probe per (session_id, statement): the schema has no unique index
 *  there, so the read-then-write pair runs inside one transaction and a repeat
 *  of the same wording updates the existing row instead of doubling it. */
export function upsertProbe(
	db: Database.Database,
	input: {
		sessionId: string;
		goalId?: string;
		statement: string;
		state: ProbeState;
		confidence?: Confidence;
		basisEntryId?: number;
	},
): string {
	requireProbeState(input.state);
	if (input.confidence !== undefined) requireConfidence(input.confidence);
	const run = db.transaction((): string => {
		const existing = db
			.prepare("SELECT id FROM probe_item WHERE session_id = ? AND statement = ?")
			.get(input.sessionId, input.statement) as { id: string } | undefined;
		if (existing) {
			db.prepare("UPDATE probe_item SET state = ?, confidence = ?, basis_entry_id = ? WHERE id = ?").run(
				input.state,
				input.confidence ?? null,
				input.basisEntryId ?? null,
				existing.id,
			);
			return existing.id;
		}
		const id = randomUUID();
		db.prepare(
			`INSERT INTO probe_item (id, session_id, goal_id, statement, state, confidence, basis_entry_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			input.sessionId,
			input.goalId ?? null,
			input.statement,
			input.state,
			input.confidence ?? null,
			input.basisEntryId ?? null,
			nowIso(),
		);
		return id;
	});
	return run();
}

/** Probes of a session in the order they were recorded. `rowid` breaks ties, not
 *  `id`: ids are random, so two probes written in the same millisecond would come
 *  back in a different order on every read (measured in the test suite). */
export function probesForSession(db: Database.Database, sessionId: string): ProbeRow[] {
	const rows = db
		.prepare(
			`SELECT id, session_id, goal_id, statement, state, confidence, basis_entry_id, created_at
			 FROM probe_item WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
		)
		.all(sessionId) as Record<string, unknown>[];
	return rows.map(rowToProbe);
}

/** Records what a check revealed about a wording the probe already asked about.
 *  The requested state only says what the check looked like; the domain decides
 *  where the statement actually stands, so a "contradicted" whose wrong "why"
 *  turned out not to be wrong reasoning stays a gap (teaching-method section 2). */
export function resolveProbe(
	db: Database.Database,
	sessionId: string,
	statement: string,
	input: {
		state: ProbeState;
		confidence?: Confidence;
		/** True when the learner's "why" showed active misconception; only
		 *  meaningful for a contradicted outcome, see readWrongAnswer. */
		wrongReasoning?: boolean;
	},
): { probeState: ProbeState } {
	requireProbeState(input.state);
	if (input.confidence !== undefined) requireConfidence(input.confidence);
	const run = db.transaction((): { probeState: ProbeState } => {
		const row = db
			.prepare("SELECT id, state FROM probe_item WHERE session_id = ? AND statement = ?")
			.get(sessionId, statement) as { id: string; state: ProbeState } | undefined;
		if (!row) {
			throw new Error(`no probe was recorded for statement "${statement}" in session ${sessionId}`);
		}
		// The transition goes through domain rules, never through the raw request.
		const verdict: CheckVerdict = input.state === "held" || input.state === "frontier" ? "correct" : "incorrect";
		const hints = input.state === "frontier" ? 1 : 0;
		const reasoningWrong = input.state === "contradicted" ? (input.wrongReasoning ?? true) : false;
		const wrong = readWrongAnswer(true, true, reasoningWrong);
		const probeState = stateAfterCheck(verdict, hints, wrong);
		db.prepare("UPDATE probe_item SET state = ?, confidence = ? WHERE id = ?").run(
			probeState,
			input.confidence ?? null,
			row.id,
		);
		return { probeState };
	});
	return run();
}
