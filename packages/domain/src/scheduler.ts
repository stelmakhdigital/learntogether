// Планировщик повторений (D-009, D-035): модель памяти FSRS-6, 21 вес, своя
// реализация. Эталон — ts-fsrs 6.0.1: значения в test/fixtures/fsrs6.json сняты с
// его algorithm.next_state/next_interval/forgetting_curve, тест сверяет посимвольно
// до 1e-8. Формулы: https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm#fsrs-6

import type { Rating } from "./state.ts";

/** 21 вес FSRS-6; w[20] — затухание кривой забывания. */
export const FSRS6_WEIGHTS: readonly number[] = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
	0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/** Доля вспоминания, на которую планируем интервал. */
export const DEFAULT_RETENTION = 0.9;

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;

const RATING_VALUE: Record<Rating, number> = { again: 1, hard: 2, good: 3, easy: 4 };

export type MemoryState = { difficulty: number; stability: number };

/** Узел ещё не повторялся: памяти нет, инициализация по первой оценке. */
export const NEW_MEMORY: MemoryState = { difficulty: 0, stability: 0 };

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Число складывается так, как это делает эталон: 8 знаков после запятой. Без этого
 *  сверка с фикстурой расходится в последнем знаке. */
function round8(value: number): number {
	return Number(value.toFixed(8));
}

function decayFactor(weights: readonly number[]): { decay: number; factor: number } {
	const decay = -weights[20]!;
	return { decay, factor: round8(Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1) };
}

/** Вероятность вспомнить через `elapsedDays` дней при устойчивости `stability`. */
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
	// Линейное затухание: чем ближе сложность к потолку, тем слабее сдвиг.
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

/** Повтор в тот же день (elapsedDays = 0): устойчивость правится коротким правилом,
 *  иначе FSRS считает интервал по несуществующему прощению. w[19] != 0 — признак,
 *  что короткие пересмотры включены; выключенные короткие пересмотры дают обычную
 *  длину кривой. */
function shortTermStability(s: number, rating: Rating, weights: readonly number[]): number {
	const sinc = Math.pow(s, -weights[19]!) * Math.exp(weights[17]! * (RATING_VALUE[rating] - 3 + weights[18]!));
	const masked = RATING_VALUE[rating] >= 2 ? Math.max(sinc, 1) : sinc;
	return round8(clamp(s * masked, S_MIN, S_MAX));
}

/** Шаг памяти. `elapsedDays` — целые календарные дни UTC между последним повтором
 *  и этим; 0 означает «в тот же день». */
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
		// Провал не роняет устойчивость ниже того, что осталось от сегодняшнего дня.
		const floor = previous.stability / Math.exp(weights[17]! * weights[18]!);
		stability = clamp(round8(floor), S_MIN, failed);
	} else {
		stability = recallStability(previous.difficulty, previous.stability, r, rating, weights);
	}
	return { difficulty: nextDifficulty(previous.difficulty, rating, weights), stability };
}

/** Интервал в днях до следующего повтора при целевой доле вспоминания. */
export function nextIntervalDays(stability: number, retention = DEFAULT_RETENTION, weights = FSRS6_WEIGHTS): number {
	if (!(retention > 0 && retention <= 1)) throw new Error(`desired retention вне (0..1]: ${retention}`);
	const { decay, factor } = decayFactor(weights);
	return Math.max(Math.round((stability / factor) * (Math.pow(retention, 1 / decay) - 1)), 1);
}

/** Провал возвращается в этой же сессии фиксированным шагом, а не лесенкой 1m/10m.
 *  shortcut: фиксированные 10 минут; менять, когда у практики появится расписание
 *  окон в течение дня. */
export const SAME_SESSION_STEP_MINUTES = 10;

export type RepeatState = "new" | "learning" | "review";

export type RepeatCard = {
	state: RepeatState;
	memory: MemoryState;
	reps: number;
	lapses: number;
	/** null — узел ещё ни разу не повторялся и вне очереди лежит как новый. */
	dueAt: string | null;
	lastReviewAt: string | null;
	lastRating: Rating | null;
};

export function newRepeatCard(): RepeatCard {
	return { dueAt: null, lapses: 0, lastRating: null, lastReviewAt: null, memory: NEW_MEMORY, reps: 0, state: "new" };
}

/** Целые календарные дни UTC между двумя моментами; тот же день — 0. */
export function elapsedDays(fromIso: string, toIso: string): number {
	const from = new Date(fromIso);
	const to = new Date(toIso);
	const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
	const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
	return Math.floor((b - a) / 86_400_000);
}

export type RepeatOutcome = { card: RepeatCard; intervalDays: number | null; minutes: number | null };

/** Один повтор элемента. `card.lastReviewAt` — когда элемент видели последний раз;
 *  для нового элемента её нет, и elapsedDays не считается. */
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
