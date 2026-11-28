// A side question is one tool-less call that must not disturb the lesson: the helper
// sees the lesson as the learner hears it and nothing else. What the learner must not
// get back is the reference answer of a check they have not passed (D-078).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { appendEntry, entries, migrate, openDb, sideMessages } from "@learntogether/data";
import { createFakeTransport } from "@learntogether/models";
import { createSideService } from "../../src/teach/side.ts";
import { createStepTools } from "../../src/teach/steps.ts";
import { teachSession } from "./phases.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));
const budget = () => ({ input: 4000, output: 900 });

type Db = ReturnType<typeof openDb>;

function openedDb(): Db {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function callTool(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const tool = createStepTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} is missing`);
	return tool.run(args, `${name}-call`) as string;
}

/** A lesson with one shown step and an open check whose reference the learner has
 *  not reached yet. */
function lessonWithOpenCheck(): { db: Db; expected: string; sessionId: string; stepId: string } {
	const db = openedDb();
	const sessionId = teachSession(db);
	const recorded = callTool(db, sessionId, "record_step", {
		kind: "foundation",
		premises: [],
		statement: "нагрев ускоряет частицы",
	});
	const stepId = /шаг (\S+) под/.exec(recorded)![1]!;
	callTool(db, sessionId, "present_step", { step_id: stepId, text: "смотри: частицы бьют сильнее о стенку" });
	const expected = "частицы движутся быстрее и бьют сильнее";
	callTool(db, sessionId, "check_understanding", {
		answer: expected,
		ask_confidence: false,
		kind: "free_recall",
		question: "почему растёт давление?",
		step_id: stepId,
	});
	return { db, expected, sessionId, stepId };
}

test("помощник видит урок как ученик: ни эталона проверки, ни служебного трафика", async () => {
	const { db, expected, sessionId, stepId } = lessonWithOpenCheck();
	const transport = createFakeTransport({ turns: [{ text: "секундная: наклон кривой в точке" }] });
	const service = createSideService({ budget, db, transport });

	const asked = await service.ask({ question: "что такое производная", sessionId, stepId });
	assert.equal(asked.answer, "секундная: наклон кривой в точке");

	const sent = transport.calls();
	assert.equal(sent.length, 1, "side answer is one call");
	const request = sent[0]!.request;
	const text = JSON.stringify(request);

	assert.deepEqual(request.tools, [], "the helper gets no tools");
	// What the learner was shown is the step's own wording: the explanation the model
	// typed into present_step survives as tool traffic, not as lesson speech.
	assert.match(text, /нагрев ускоряет частицы/, "the shown step is part of the lesson the helper reads");
	assert.doesNotMatch(text, new RegExp(expected), "the reference answer of an open check stays out");
	assert.doesNotMatch(text, /present_step|record_step/, "tool traffic is not part of the lesson the helper reads");

	// The exchange is durable where it belongs: the thread keeps both sides, the
	// lesson record says the question was asked, and no fake teacher reply appears.
	const thread = sideMessages(db, asked.threadId);
	assert.deepEqual(thread.map((message) => message.role), ["learner", "helper"]);
	const transcript = entries(db, sessionId).map((entry) => entry.text);
	assert.ok(transcript.some((text) => text.includes("что такое производная")), "the question is visible in the lesson record");
	assert.doesNotMatch(JSON.stringify(entries(db, sessionId)), /секундная/);
	db.close();
});

test("вопрос в той же нити продолжает её, а не начинает урок заново", async () => {
	const { db, sessionId } = lessonWithOpenCheck();
	const transport = createFakeTransport({
		turns: [{ text: "наклон" }, { text: "а касательная — прямая с этим наклоном" }],
	});
	const service = createSideService({ budget, db, transport });

	const first = await service.ask({ question: "что такое производная", sessionId });
	const second = await service.ask({ question: "а касательная?", sessionId, threadId: first.threadId });

	assert.equal(second.threadId, first.threadId);
	const history = transport.calls()[1]!.request.messages;
	assert.ok(
		history.some((message) => JSON.stringify(message).includes("что такое производная")),
		"the earlier side exchange travels with the new question",
	);
	db.close();
});

test("пустой вопрос не доходит до модели, ответ без текста — честная ошибка", async () => {
	const { db, sessionId } = lessonWithOpenCheck();
	const transport = createFakeTransport({ turns: [{ text: "не использован" }] });
	const service = createSideService({ budget, db, transport });
	await assert.rejects(() => service.ask({ question: "   ", sessionId }), /пустой вопрос/);
	assert.equal(transport.calls().length, 0);

	const silent = createSideService({ budget, db, transport: createFakeTransport({ turns: [{ text: "" }] }) });
	await assert.rejects(() => silent.ask({ question: "и?", sessionId }), /модель не ответила/);
	db.close();
});

test("сторона не трогает транскрипт урока репликами учителя", async () => {
	const db = openedDb();
	const sessionId = teachSession(db);
	appendEntry(db, { kind: "text", role: "teacher", sessionId, text: "смотри на график" });
	const before = entries(db, sessionId).length;
	const service = createSideService({ budget, db, transport: createFakeTransport({ turns: [{ text: "да" }] }) });
	await service.ask({ question: "а здесь?", sessionId });
	const after = entries(db, sessionId);
	assert.equal(after.length, before + 1, "one note about the question, no teacher reply");
	assert.equal(after.at(-1)!.role, "system");
	assert.equal(after.at(-1)!.kind, "system_note");
	db.close();
});
