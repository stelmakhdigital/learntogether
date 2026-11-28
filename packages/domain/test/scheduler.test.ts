// The scheduler's reference: values taken from ts-fsrs 6.0.1 (see
// scripts/genFsrsFixtures.ts). The match is exact — our own implementation has no
// right to drift from the reference silently: its output is the learner's schedule.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Rating } from "../src/state.ts";
import {
	DEFAULT_RETENTION,
	FSRS6_WEIGHTS,
	NEW_MEMORY,
	elapsedDays,
	newRepeatCard,
	nextIntervalDays,
	nextMemoryState,
	retrievability,
	reviewRepeat,
} from "../src/scheduler.ts";

type Fixture = {
	curves: { elapsed: number; r: number; stability: number }[];
	first: Record<string, { difficulty: number; stability: number }>;
	intervals: { retention: Record<string, number>; stability: number }[];
	steps: { difficulty: number; elapsed: number; rating: number; stability: number }[];
	weights: number[];
};

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/fsrs6.json", import.meta.url)), "utf8")) as Fixture;
const RATING_BY_VALUE: Record<number, Rating> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };

test("the weights are the reference weights", () => {
	assert.equal(FSRS6_WEIGHTS.length, 21);
	assert.deepEqual([...FSRS6_WEIGHTS], fixture.weights);
});

test("the first review of each rating matches the reference", () => {
	for (const [value, expected] of Object.entries(fixture.first)) {
		const rating = RATING_BY_VALUE[Number(value)]!;
		assert.deepEqual(nextMemoryState(NEW_MEMORY, 0, rating), expected, `первый повтор ${rating}`);
	}
});

test("a sequence of reviews matches the reference step by step", () => {
	let memory = NEW_MEMORY;
	for (const [index, step] of fixture.steps.entries()) {
		memory = nextMemoryState(memory, step.elapsed, RATING_BY_VALUE[step.rating]!);
		assert.deepEqual(memory, { difficulty: step.difficulty, stability: step.stability }, `шаг ${index}`);
	}
});

test("the forgetting curve and the intervals match the reference", () => {
	for (const row of fixture.curves) {
		assert.equal(retrievability(row.elapsed, row.stability), row.r, `R(${row.elapsed}, ${row.stability})`);
	}
	for (const row of fixture.intervals) {
		for (const [retention, expected] of Object.entries(row.retention)) {
			assert.equal(nextIntervalDays(row.stability, Number(retention)), expected, `interval S=${row.stability} R=${retention}`);
		}
	}
	// The default target recall rate is the one the fixture was taken at.
	assert.equal(DEFAULT_RETENTION, 0.9);
});

test("a lapse comes back in the same session, a success goes by interval", () => {
	const start = newRepeatCard();
	const again = reviewRepeat(start, "again", "2026-01-01T09:00:00.000Z");
	assert.equal(again.card.state, "learning");
	assert.equal(again.card.dueAt, "2026-01-01T09:10:00.000Z");
	assert.equal(again.card.lapses, 1);
	assert.equal(again.card.reps, 1);

	const good = reviewRepeat(start, "good", "2026-01-01T09:00:00.000Z");
	assert.equal(good.card.state, "review");
	assert.equal(good.card.lapses, 0);
	assert.ok(good.intervalDays !== null && good.intervalDays >= 1);
	assert.equal(good.card.dueAt, new Date(Date.parse("2026-01-01T09:00:00.000Z") + good.intervalDays! * 86_400_000).toISOString());
});

test("the interval grows with the rating and drops after a lapse", () => {
	const base = reviewRepeat(newRepeatCard(), "good", "2026-01-01T09:00:00.000Z").card;
	const later = "2026-02-01T09:00:00.000Z";
	const intervals = (["hard", "good", "easy"] as Rating[]).map((rating) => reviewRepeat(base, rating, later).intervalDays!);
	assert.deepEqual(intervals, [...intervals].sort((x, y) => x - y));
	assert.ok(intervals[0]! < intervals[2]!, `hard ${intervals[0]} must be shorter than easy ${intervals[2]}`);

	const failed = reviewRepeat(base, "again", later).card;
	const recovered = reviewRepeat(failed, "good", later).intervalDays!;
	assert.ok(recovered < intervals[0]!, `after a lapse the interval ${recovered} must stay short`);
});

test("a same-day review does not shrink stability on a success", () => {
	const first = reviewRepeat(newRepeatCard(), "good", "2026-01-01T09:00:00.000Z").card;
	const sameDay = reviewRepeat(first, "hard", "2026-01-01T18:00:00.000Z").card;
	assert.ok(sameDay.memory.stability >= first.memory.stability, "the same day cannot cancel today");
	assert.equal(elapsedDays("2026-01-01T23:00:00.000Z", "2026-01-02T01:00:00.000Z"), 1);
	assert.equal(elapsedDays("2026-01-01T09:00:00.000Z", "2026-01-01T23:30:00.000Z"), 0);
});

test("an incomplete memory state and a review from the past are refused by name", () => {
	assert.throws(() => nextMemoryState({ difficulty: 5, stability: 0 }, 3, "good"), /неполное состояние памяти/);
	assert.throws(() => nextMemoryState(NEW_MEMORY, -1, "good"), /elapsedDays не может быть отрицательным/);
	assert.throws(() => nextIntervalDays(5, 0), /desired retention вне/);
	const card = { ...newRepeatCard(), lastReviewAt: "2026-01-05T09:00:00.000Z" };
	assert.throws(() => reviewRepeat(card, "good", "2026-01-01T09:00:00.000Z"), /повтор из прошлого/);
	assert.throws(() => reviewRepeat(newRepeatCard(), "good", "не дата"), /не дата/);
});
