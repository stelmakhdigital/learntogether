// The repetition scheduler (D-009, D-035): the FSRS-6 memory model, 21 weights, our
// own code. The reference is ts-fsrs 6.0.1 — test/fixtures/fsrs6.json holds values
// taken from its algorithm.next_state/next_interval/forgetting_curve and the test
// compares them exactly. Formulas:
// https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm#fsrs-6

import type { Rating } from "./state.ts";

/** The 21 FSRS-6 weights; w[20] is the decay of the forgetting curve. */
export const FSRS6_WEIGHTS: readonly number[] = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
	0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/** Recall rate an interval is planned for. */
export const DEFAULT_RETENTION = 0.9;

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;

const RATING_VALUE: Record<Rating, number> = { again: 1, hard: 2, good: 3, easy: 4 };

export type MemoryState = { difficulty: number; stability: number };

/** A node never repeated yet: no memory, initialized from the first rating. */
export const NEW_MEMORY: MemoryState = { difficulty: 0, stability: 0 };

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Rounded the way the reference rounds: 8 decimals. Without this the fixture
 *  comparison differs in the last digit. */
function round8(value: number): number {
	return Number(value.toFixed(8));
}

function decayFactor(weights: readonly number[]): { decay: number; factor: number } {
	const decay = -weights[20]!;
	return { decay, factor: round8(Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1) };
}

/** Probability of recalling after `elapsedDays` days at a given stability. */
export function retrievability(elapsedDays: number, stability: number, weights = FSRS6_WEIGHTS): number {
	const { decay, factor } = decayFactor(weights);
	return round8(Math.pow(1 + (factor * elapsedDays) / stability, decay));
}

function initStability(rating: Rating, weights: readonly number[]): number {
	return clamp(weights[RATING_VALUE[rating] - 1]!, S_MIN, S_MAX);
}

function initDifficulty(rating: Rating, weights: readonly number[]): number {
	return round8(weights[4]! - Math.exp((RATING_VALUE[rating] - 1) * weights[5]!) + 1);
}

function nextDifficulty(d: number, rating: Rating, weights: readonly number[]): number {
	const deltaD = -weights[6]! * (RATING_VALUE[rating] - 3);
	// Linear damping: the closer the difficulty is to the ceiling, the weaker the shift.
	const damped = round8((deltaD * (10 - d)) / 9);
	const reverted = round8(weights[7]! * initDifficulty("easy", weights) + (1 - weights[7]!) * (d + damped));
	return clamp(reverted, D_MIN, D_MAX);
}

function recallStability(d: number, s: number, r: number, rating: Rating, weights: readonly number[]): number {
	const hardPenalty = rating === "hard" ? weights[15]! : 1;
	const easyBonus = rating === "easy" ? weights[16]! : 1;
	const grown =
		s *
		(1 +
			Math.exp(weights[8]!) *
				(11 - d) *
				Math.pow(s, -weights[9]!) *
				(Math.exp((1 - r) * weights[10]!) - 1) *
				hardPenalty *
				easyBonus);
	return round8(clamp(grown, S_MIN, S_MAX));
}

function forgetStability(d: number, s: number, r: number, weights: readonly number[]): number {
	const value =
		weights[11]! * Math.pow(d, -weights[12]!) * (Math.pow(s + 1, weights[13]!) - 1) * Math.exp((1 - r) * weights[14]!);
	return round8(clamp(value, S_MIN, S_MAX));
}

/** Same-day review (elapsedDays = 0): stability follows the short-term rule, or FSRS
 *  would plan an interval out of a forgetting that never happened. w[19] != 0 means
 *  short-term reviews are on. */
function shortTermStability(s: number, rating: Rating, weights: readonly number[]): number {
	const sinc = Math.pow(s, -weights[19]!) * Math.exp(weights[17]! * (RATING_VALUE[rating] - 3 + weights[18]!));
	const masked = RATING_VALUE[rating] >= 2 ? Math.max(sinc, 1) : sinc;
	return round8(clamp(s * masked, S_MIN, S_MAX));
}

/** One memory step. `elapsedDays` is whole UTC calendar days between the previous
 *  review and this one; 0 means "the same day". */
export function nextMemoryState(
	previous: MemoryState,
	elapsedDays: number,
	rating: Rating,
	weights = FSRS6_WEIGHTS,
): MemoryState {
	if (elapsedDays < 0) throw new Error(`elapsedDays не может быть отрицательным, получено ${elapsedDays}`);
	if (previous.stability === 0 && previous.difficulty === 0) {
		return { difficulty: clamp(initDifficulty(rating, weights), D_MIN, D_MAX), stability: initStability(rating, weights) };
	}
	if (previous.difficulty < D_MIN || previous.stability < S_MIN) {
		throw new Error(
			`неполное состояние памяти: difficulty=${previous.difficulty}, stability=${previous.stability} — правь карточку, а не планировщик`,
		);
	}
	const r = retrievability(elapsedDays, previous.stability, weights);
	let stability: number;
	if (elapsedDays === 0) {
		stability = shortTermStability(previous.stability, rating, weights);
	} else if (rating === "again") {
		const failed = forgetStability(previous.difficulty, previous.stability, r, weights);
		// A lapse never drops stability below what today's review left standing.
		const floor = previous.stability / Math.exp(weights[17]! * weights[18]!);
		stability = clamp(round8(floor), S_MIN, failed);
	} else {
		stability = recallStability(previous.difficulty, previous.stability, r, rating, weights);
	}
	return { difficulty: nextDifficulty(previous.difficulty, rating, weights), stability };
}

/** Days until the next review at the target recall rate. */
export function nextIntervalDays(stability: number, retention = DEFAULT_RETENTION, weights = FSRS6_WEIGHTS): number {
	if (!(retention > 0 && retention <= 1)) throw new Error(`desired retention вне (0..1]: ${retention}`);
	const { decay, factor } = decayFactor(weights);
	return Math.max(Math.round((stability / factor) * (Math.pow(retention, 1 / decay) - 1)), 1);
}

/** A lapse comes back inside the same session on a fixed step instead of the
 *  1m/10m ladder. shortcut: fixed 10 minutes; change when practice gets scheduled
 *  windows through the day. */
export const SAME_SESSION_STEP_MINUTES = 10;

export type RepeatState = "new" | "learning" | "review";

export type RepeatCard = {
	state: RepeatState;
	memory: MemoryState;
	reps: number;
	lapses: number;
	/** null — the node was never repeated and waits in the queue as new. */
	dueAt: string | null;
	lastReviewAt: string | null;
	lastRating: Rating | null;
};

export function newRepeatCard(): RepeatCard {
	return { dueAt: null, lapses: 0, lastRating: null, lastReviewAt: null, memory: NEW_MEMORY, reps: 0, state: "new" };
}

/** Whole UTC calendar days between two instants; the same day is 0. */
export function elapsedDays(fromIso: string, toIso: string): number {
	const from = new Date(fromIso);
	const to = new Date(toIso);
	const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
	const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
	return Math.floor((b - a) / 86_400_000);
}

export type RepeatOutcome = { card: RepeatCard; intervalDays: number | null; minutes: number | null };

/** One review of an item. A new card has no lastReviewAt, so no elapsed time exists. */
export function reviewRepeat(card: RepeatCard, rating: Rating, nowIso: string, retention = DEFAULT_RETENTION): RepeatOutcome {
	const now = new Date(nowIso);
	if (Number.isNaN(now.getTime())) throw new Error(`не дата: ${nowIso}`);
	const days = card.lastReviewAt === null ? 0 : elapsedDays(card.lastReviewAt, nowIso);
	if (days < 0) throw new Error(`повтор из прошлого: ${nowIso} раньше ${card.lastReviewAt}`);
	const memory = nextMemoryState(card.memory, days, rating);
	const lapses = card.lapses + (rating === "again" ? 1 : 0);
	const reps = card.reps + 1;
	if (rating === "again") {
		const due = new Date(now.getTime() + SAME_SESSION_STEP_MINUTES * 60_000).toISOString();
		return {
			card: { dueAt: due, lapses, lastRating: rating, lastReviewAt: nowIso, memory, reps, state: "learning" },
			intervalDays: null,
			minutes: SAME_SESSION_STEP_MINUTES,
		};
	}
	const intervalDays = nextIntervalDays(memory.stability, retention);
	const due = new Date(now.getTime() + intervalDays * 86_400_000).toISOString();
	return {
		card: { dueAt: due, lapses, lastRating: rating, lastReviewAt: nowIso, memory, reps, state: "review" },
		intervalDays,
		minutes: null,
	};
}
