// Эталон планировщика: значения сняты с ts-fsrs 6.0.1 (packages/domain/tools/
// genFsrsFixtures.ts). Совпадение полное — своя реализация не имеет права тихо
// разъезжаться с эталоном: интервалы уходят в расписание ученика.

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

test("веса те же, что у эталона", () => {
	assert.equal(FSRS6_WEIGHTS.length, 21);
	assert.deepEqual([...FSRS6_WEIGHTS], fixture.weights);
});

test("первый повтор каждого типа совпадает с эталоном", () => {
	for (const [value, expected] of Object.entries(fixture.first)) {
		const rating = RATING_BY_VALUE[Number(value)]!;
		assert.deepEqual(nextMemoryState(NEW_MEMORY, 0, rating), expected, `первый повтор ${rating}`);
	}
});

test("последовательность повторов совпадает с эталоном шаг в шаг", () => {
	let memory = NEW_MEMORY;
	for (const [index, step] of fixture.steps.entries()) {
		memory = nextMemoryState(memory, step.elapsed, RATING_BY_VALUE[step.rating]!);
		assert.deepEqual(memory, { difficulty: step.difficulty, stability: step.stability }, `шаг ${index}`);
	}
});

test("кривая забывания и интервалы совпадают с эталоном", () => {
	for (const row of fixture.curves) {
		assert.equal(retrievability(row.elapsed, row.stability), row.r, `R(${row.elapsed}, ${row.stability})`);
	}
	for (const row of fixture.intervals) {
		for (const [retention, expected] of Object.entries(row.retention)) {
			assert.equal(nextIntervalDays(row.stability, Number(retention)), expected, `интервал S=${row.stability} R=${retention}`);
		}
	}
	// Целевая доля вспоминания по умолчанию та, на которой снят эталон.
	assert.equal(DEFAULT_RETENTION, 0.9);
});

test("провал возвращается в этой же сессии, успех — по интервалу", () => {
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

test("интервал растёт с оценкой и падает после провала", () => {
	const base = reviewRepeat(newRepeatCard(), "good", "2026-01-01T09:00:00.000Z").card;
	const later = "2026-02-01T09:00:00.000Z";
	const intervals = (["hard", "good", "easy"] as Rating[]).map((rating) => reviewRepeat(base, rating, later).intervalDays!);
	assert.deepEqual(intervals, [...intervals].sort((x, y) => x - y));
	assert.ok(intervals[0]! < intervals[2]!, `жёсткий ${intervals[0]} должен быть короче лёгкого ${intervals[2]}`);

	const failed = reviewRepeat(base, "again", later).card;
	const recovered = reviewRepeat(failed, "good", later).intervalDays!;
	assert.ok(recovered < intervals[0]!, `после провала интервал ${recovered} должен остаться коротким`);
});

test("повтор в тот же день не уменьшает устойчивость при успехе", () => {
	const first = reviewRepeat(newRepeatCard(), "good", "2026-01-01T09:00:00.000Z").card;
	const sameDay = reviewRepeat(first, "hard", "2026-01-01T18:00:00.000Z").card;
	assert.ok(sameDay.memory.stability >= first.memory.stability, "тот же день не может обнулить сегодняшнее");
	assert.equal(elapsedDays("2026-01-01T23:00:00.000Z", "2026-01-02T01:00:00.000Z"), 1);
	assert.equal(elapsedDays("2026-01-01T09:00:00.000Z", "2026-01-01T23:30:00.000Z"), 0);
});

test("неполное состояние памяти и повтор из прошлого отказывают честно", () => {
	assert.throws(() => nextMemoryState({ difficulty: 5, stability: 0 }, 3, "good"), /неполное состояние памяти/);
	assert.throws(() => nextMemoryState(NEW_MEMORY, -1, "good"), /elapsedDays не может быть отрицательным/);
	assert.throws(() => nextIntervalDays(5, 0), /desired retention вне/);
	const card = { ...newRepeatCard(), lastReviewAt: "2026-01-05T09:00:00.000Z" };
	assert.throws(() => reviewRepeat(card, "good", "2026-01-01T09:00:00.000Z"), /повтор из прошлого/);
	assert.throws(() => reviewRepeat(newRepeatCard(), "good", "не дата"), /не дата/);
});
