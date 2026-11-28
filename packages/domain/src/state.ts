// Domain states and the rules that connect them. No I/O here: see
// docs/teaching-method.md for what each state means and scripts/check-layers.mjs
// for what this package may not import.

/** Where a statement stands for this learner (teaching-method section 2). */
export type ProbeState = "held" | "frontier" | "absent" | "contradicted";

/** What a wrong answer can become once we asked why (teaching-method section 2). */
export type WrongAnswerRead = "no_answer" | "wrong_reasoning";

/** Distinguish "does not know" from "knows it backwards": they need different
 *  actions, and a single wrong answer does not tell them apart. */
export function readWrongAnswer(hasAttempt: boolean, reasoningAsked: boolean, reasoningWrong: boolean): WrongAnswerRead {
	if (!hasAttempt) return "no_answer";
	if (!reasoningAsked) {
		// shortcut: without the "why" follow-up we cannot tell the two apart,
		// so we treat it as a gap, never as a misconception.
		return "no_answer";
	}
	return reasoningWrong ? "wrong_reasoning" : "no_answer";
}

export function probeStateFromWrong(read: WrongAnswerRead): ProbeState {
	return read === "wrong_reasoning" ? "contradicted" : "absent";
}

export type StepKind = "derivation" | "foundation";

/** A step is accepted only after its own check passed (teaching-method section 5). */
export type StepState = "planned" | "presented" | "checked" | "accepted" | "repaired";

export type StepEvent = "present" | "check_passed" | "check_failed" | "repair_done";

/** Returns the next state or a concrete refusal. Illegal transitions are errors,
 *  not silent no-ops: a skipped check must not look like progress. */
export function nextStepState(state: StepState, event: StepEvent): StepState | { error: string } {
	switch (`${state}:${event}`) {
		case "planned:present":
			return "presented";
		case "presented:check_passed":
			return "accepted";
		case "presented:check_failed":
			return "repaired";
		case "repaired:present":
			return "presented";
		case "repaired:check_passed":
			return "accepted";
		case "accepted:check_failed":
			return "repaired";
		default:
			return { error: `step in state "${state}" cannot handle "${event}"` };
	}
}

export function kindRequiresPremises(kind: StepKind): boolean {
	return kind === "derivation";
}

/** Check kinds differ in what they measure; transfer is measured apart from
 *  recall on purpose (teaching-method section 7). */
export type CheckKind = "single_choice" | "multi_choice" | "free_recall" | "predict" | "find_error" | "transfer";

export type CheckVerdict = "correct" | "incorrect" | "partial";

/** Repetition rating handed to the scheduler. */
export const RATINGS = ["again", "hard", "good", "easy"] as const;
export type Rating = (typeof RATINGS)[number];

/** A learner who guessed and felt confident must not get a long interval:
 *  upper ratings require a correct and complete answer (decision D-037). */
export function allowedRatings(verdict: CheckVerdict, hintCount: number): Rating[] {
	if (verdict !== "correct") return ["again"];
	if (hintCount > 0) return ["again", "good"];
	return ["again", "hard", "good", "easy"];
}

/** An answer bought with hints is a frontier, not held knowledge. A wrong answer
 *  keeps the distinction between a gap and a misconception (section 2). */
export function stateAfterCheck(verdict: CheckVerdict, hintCount: number, wrong: WrongAnswerRead): ProbeState {
	if (verdict !== "correct") return probeStateFromWrong(wrong);
	return hintCount === 0 ? "held" : "frontier";
}

/** One active practice problem per turn (docs/tool-contracts.md). */
export function canPoseProblem(activeProblemIds: readonly string[]): { ok: true } | { error: string } {
	if (activeProblemIds.length > 1) {
		return { error: `${activeProblemIds.length} active problems; at most one is allowed` };
	}
	return activeProblemIds.length === 1 ? { error: "a problem is already active" } : { ok: true };
}

/** Confidence is captured before the result is shown, otherwise the learner
 *  cannot anchor on it and calibration cannot be measured. */
export type Confidence = 1 | 2 | 3 | 4 | 5;

export function calibrationError(confidence: Confidence, correct: boolean): number {
	const expected = correct ? 1 : 0;
	return Math.abs(confidence / 5 - expected);
}
