// The wording a data screen puts next to a row. Tested here rather than through
import { groupView, viewItem } from "../src/view.ts";
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

// The view projection decides what a transcript entry becomes on screen. It is a
// contract, not a rendering detail: internal traffic must not read as the teacher's
// speech, and the learner must not be shown the arguments a tool was called with.
test("речь остаётся речью, служебное — служебным", () => {
	assert.deepEqual(viewItem({ kind: "text", ordinal: 1, role: "learner", text: "объясни" }), {
		actor: "Вы",
		kind: "speech",
		ordinal: 1,
		text: "объясни",
	});
	assert.deepEqual(viewItem({ kind: "tool_call", ordinal: 2, role: "system", text: 'probe_record {"items":[{"state":"held"}]}' }), {
		actor: "Урок",
		detail: null,
		kind: "service",
		ordinal: 2,
		text: "вызов: probe_record",
	});
	assert.deepEqual(viewItem({ kind: "tool_result", ordinal: 3, role: "system", text: "probe_record: замер записан: 1 held" }), {
		actor: "Урок",
		detail: "замер записан: 1 held",
		kind: "service",
		ordinal: 3,
		text: "ответ: probe_record",
	});
});

test("подряд идущие служебные записи сворачиваются в один блок", () => {
	const grouped = groupView(
		[
			{ actor: "Вы", kind: "speech", ordinal: 1, text: "а" },
			{ actor: "Урок", detail: null, kind: "service", ordinal: 2, text: "вызов: x" },
			{ actor: "Урок", detail: "ок", kind: "service", ordinal: 3, text: "ответ: x" },
			{ actor: "Учитель", kind: "speech", ordinal: 4, text: "б" },
			{ actor: "Урок", detail: null, kind: "service", ordinal: 5, text: "вызов: y" },
		],
	);
	assert.deepEqual(
		grouped.map((block) => (block.kind === "services" ? `services:${block.items.length}` : block.kind)),
		["speech", "services:2", "speech", "services:1"],
	);
});
