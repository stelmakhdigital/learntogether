// Accepting the learner's answer to a check. The learner's words arrive from the
// learner, never from the teacher model (decision D-056): a choice answer is
// compared with the stored reference here, a free-form answer is compared with
// that same reference through the model, and the verdict lands in storage exactly
// once. The rating is picked inside what the domain allows (decision D-037), and
// the repository moves the step and the probe state.

import type Database from "better-sqlite3";
import { appendEntry, openChecksForSession, resolveCheck, type CheckRow, type StepAnswer } from "@learntogether/data";
import {
	allowedRatings,
	type CheckVerdict,
	type Confidence,
	type ProbeState,
	type Rating,
	type StepState,
} from "@learntogether/domain";
import { judgeAnswer, learnerAnswerText, mechanicalVerdict } from "./judge.ts";
import type { Budget, Transport } from "@learntogether/models";

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

export type LearnerAnswerInput = {
	/** Option index for a choice, the recalled words for anything else. */
	answer: string | number;
	/** Required when the check asked for it: calibration is anchored before the
	 *  result is shown, so it cannot be filled in afterwards. */
	confidence?: number;
	hints?: number;
};

export type AnswerOutcome = {
	checkId: string;
	verdict: CheckVerdict;
	reason: string;
	stepState: StepState;
	probeState: ProbeState;
	rating: Rating;
};

export interface AnswerService {
	/** The check the learner is expected to answer right now, or null. */
	pending(sessionId: string): CheckRow | null;
	answer(sessionId: string, input: LearnerAnswerInput): Promise<AnswerOutcome>;
}

/** The HTTP side of answering: verdict, storage, and the answer as a message of
 *  the lesson (the next turn reads the conversation, and the readable export must
 *  show what was actually said). */
export function createAnswerService(deps: {
	db: Database.Database;
	transport: Transport;
	budget: () => Budget;
}): AnswerService {
	const { db, transport } = deps;
	return {
		pending: (sessionId) => openChecksForSession(db, sessionId)[0] ?? null,
		async answer(sessionId, input): Promise<AnswerOutcome> {
			const check = openChecksForSession(db, sessionId)[0];
			if (check === undefined) throw new Error("открытых проверок нет — отвечать не на что");

			const text = learnerAnswerText(input.answer, check.options);
			if (check.askConfidence && input.confidence === undefined) {
				throw new Error("проверка просила уверенность: без поля confidence ответ не принимается");
			}
			const hints = input.hints ?? 0;
			const computed = mechanicalVerdict(check, input.answer);
			const judged =
				computed === null
					? await judgeAnswer(transport, deps.budget(), check, text)
					: { reason: "", verdict: computed };

			const graded = answerCheck(db, sessionId, {
				checkId: check.id,
				learnerAnswer: typeof input.answer === "number" ? input.answer : text,
				verdict: judged.verdict,
				confidence: input.confidence ?? 3,
				hints,
			});
			appendEntry(db, { kind: "text", role: "learner", sessionId, text });
			return {
				checkId: check.id,
				probeState: graded.probeState,
				rating: graded.rating,
				reason: judged.reason,
				stepState: graded.stepState,
				verdict: judged.verdict,
			};
		},
	};
}
