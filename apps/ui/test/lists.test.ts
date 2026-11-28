// The wording a data screen puts next to a row. Tested here rather than through
// the DOM because these are the sentences the learner acts on: wrong words in them
// send a person to the wrong material.

import test from "node:test";
import assert from "node:assert/strict";
import { hiddenCount, itemMark, listCaption } from "../src/lists.ts";

const TODAY = new Date("2026-11-29T12:00:00.000Z");

test("the queue says why the item is here today", () => {
	assert.equal(itemMark({ dueAt: null, early: false, hasDoubt: false }), "ещё ни разу не повторялось");
	assert.equal(itemMark({ dueAt: "2026-12-05T09:00:00.000Z", early: false, hasDoubt: false }), "срок 05.12.2026");
	assert.equal(itemMark({ dueAt: "2026-11-29T06:00:00.000Z", early: false, hasDoubt: false }, TODAY), "срок сегодня");
	assert.equal(itemMark({ dueAt: "2026-12-10T09:00:00.000Z", early: true, hasDoubt: false }), "созреет позже — сегодня больше ничего нет");
	// A doubt outranks the schedule: it is the reason the item is first in line.
	assert.equal(itemMark({ dueAt: "2030-01-01T00:00:00.000Z", early: false, hasDoubt: true }), "на узле открыто сомнение");
});

test("the library says what the list currently holds", () => {
	assert.equal(listCaption({ query: "", hits: 0, total: 412 }), "узлов в графе: 412");
	assert.equal(listCaption({ query: "секущая", hits: 3, total: 412 }), "найдено 3 по «секущая»");
});

test("hidden count counts what the page does not show, never below zero", () => {
	assert.equal(hiddenCount({ query: "", hits: 0, shown: 50, total: 412 }), 362);
	assert.equal(hiddenCount({ query: "секущая", hits: 2, shown: 2, total: 412 }), 0);
	// A page longer than the total (the server returned more than it counted) is not
	// allowed to produce a negative remainder.
	assert.equal(hiddenCount({ query: "", hits: 0, shown: 60, total: 40 }), 0);
});
