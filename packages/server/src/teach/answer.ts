// Accepting the learner's answer to a check: the verdict comes from the teacher
// model, the rating is picked inside what the domain allows (decision D-037),
// and both go to the repository, which moves the step and the probe state.

import type Database from "better-sqlite3";
import { resolveCheck, type StepAnswer } from "@learntogether/data";
import {
	allowedRatings,
	type CheckVerdict,
	type Confidence,
	type ProbeState,
	type Rating,
	type StepState,
} from "@learntogether/domain";

export type AnswerCheckInput = {
	checkId: string;
	learnerAnswer: StepAnswer;
	verdict: CheckVerdict;
	confidence: number;
	hints?: number;
	/** Set after the "why" follow-up: the learner's own reasoning was wrong. */
	wrongReasoning?: boolean;
};

/** An answer with no hints is worth the middle rating; an answer bought with a
 *  hint never gets above it, and whatever is wanted stays inside what
 *  allowedRatings permits — the repository refuses anything above that. */
function chooseRating(verdict: CheckVerdict, hints: number): Rating {
	if (verdict !== "correct") return "again";
	const allowed = allowedRatings(verdict, hints);
	return hints === 0 ? "good" : allowed.includes("hard") ? "hard" : "good";
}

export function answerCheck(
	db: Database.Database,
	sessionId: string,
	input: AnswerCheckInput,
): { stepState: StepState; probeState: ProbeState; rating: Rating } {
	const row = db
		.prepare(
			`SELECT c.answered_at AS answered_at, s.session_id AS session_id
			 FROM step_check c JOIN step s ON s.id = c.step_id WHERE c.id = ?`,
		)
		.get(input.checkId) as { answered_at: string | null; session_id: string } | undefined;
	if (row === undefined) throw new Error(`проверки ${input.checkId} нет`);
	if (row.session_id !== sessionId) throw new Error(`проверка ${input.checkId} не из этой сессии`);
	if (row.answered_at !== null) {
		throw new Error(`ответ на проверку ${input.checkId} принят раньше (${row.answered_at}); повторы не пересматриваются`);
	}
	if (!Number.isInteger(input.confidence) || input.confidence < 1 || input.confidence > 5) {
		throw new Error(`confidence: нужно целое 1..5, получено: ${input.confidence}`);
	}

	const hints = input.hints ?? 0;
	const rating = chooseRating(input.verdict, hints);
	const { probeState, stepState } = resolveCheck(db, input.checkId, {
		learnerAnswer: input.learnerAnswer,
		verdict: input.verdict,
		confidence: input.confidence as Confidence,
		hints,
		rating,
		...(input.wrongReasoning === undefined ? {} : { wrongReasoning: input.wrongReasoning }),
	});
	return { probeState, rating, stepState };
}
