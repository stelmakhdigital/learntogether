// The learner's answer: a choice is graded by us against the stored reference, a
// free-form answer is compared with that reference through the model, and the
// verdict is written exactly once (decision D-056).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { entries, migrate, openDb, stepsForSession, type CheckRow } from "@learntogether/data";
import { createFakeTransport } from "@learntogether/models";
import type { Transport } from "@learntogether/models";
import { createStepTools } from "../../src/teach/steps.ts";
import { createAnswerService } from "../../src/teach/answer.ts";
import { learnerAnswerText, mechanicalVerdict, pendingCheck } from "../../src/teach/judge.ts";
import { teachSession } from "./phases.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));
const budget = () => ({ input: 2000, output: 300 });

type Db = ReturnType<typeof openDb>;

function openedDb(): Db {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function call(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const tool = createStepTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} is missing`);
	return tool.run(args, `${name}-call`) as string;
}

/** A lesson with one step shown to the learner. */
function startedLesson(): { db: Db; sessionId: string; stepId: string } {
	const db = openedDb();
	const sessionId = teachSession(db);
	const recorded = call(db, sessionId, "record_step", { kind: "foundation", premises: [], statement: "нагрев ускоряет частицы" });
	const stepId = /шаг (\S+) под/.exec(recorded)![1]!;
	call(db, sessionId, "present_step", { step_id: stepId, text: "смотри: частицы бьют сильнее" });
	return { db, sessionId, stepId };
}

function ask(db: Db, sessionId: string, stepId: string, check: { kind: string; question: string; answer: unknown; options?: unknown[] }): CheckRow {
	call(db, sessionId, "check_understanding", { ask_confidence: true, step_id: stepId, ...check });
	const open = pendingCheck(db, sessionId);
	assert.ok(open, "the check must be open");
	return open;
}

const choice = {
	answer: 1,
	kind: "single_choice",
	options: [{ label: "a", text: "значение функции" }, { label: "b", text: "скорость изменения" }],
	question: "Что измеряет производная?",
};

const freeRecall = { answer: "частицы движутся быстрее", kind: "free_recall", question: "перескажи шаг своими словами" };

const service = (db: Db, transport: Transport = createFakeTransport({ turns: [] })) =>
	createAnswerService({ budget, db, transport });

test("learnerAnswerText turns an option index into the option the learner saw", () => {
	const options = [{ label: "a", text: "наклон касательной" }, { label: "b", text: "значение функции" }];
	assert.equal(learnerAnswerText(1, options), "b — значение функции");
	assert.equal(learnerAnswerText("a", options), "a — наклон касательной");
	assert.equal(learnerAnswerText("на глаз быстрее", options), "на глаз быстрее");
	assert.throws(() => learnerAnswerText(5, options), /варианта с номером 5/);
	assert.throws(() => learnerAnswerText("   ", options), /пустой ответ/);
});

test("a choice answer is graded against the reference, not by opinion", () => {
	const { db, sessionId, stepId } = startedLesson();
	const check = ask(db, sessionId, stepId, choice);

	assert.equal(mechanicalVerdict(check, 1), "correct");
	assert.equal(mechanicalVerdict(check, 0), "incorrect");
	// The same option named by its label is the same answer.
	assert.equal(mechanicalVerdict(check, "b"), "correct");
});

test("a free-form kind has no mechanical verdict", () => {
	const { db, sessionId, stepId } = startedLesson();
	assert.equal(mechanicalVerdict(ask(db, sessionId, stepId, freeRecall), "частицы движутся быстрее"), null);
});

test("answering a choice stores the verdict, moves the step and records the words", async () => {
	const { db, sessionId, stepId } = startedLesson();
	ask(db, sessionId, stepId, choice);

	const outcome = await service(db).answer(sessionId, { answer: 1, confidence: 4 });
	assert.equal(outcome.verdict, "correct");
	assert.equal(outcome.stepState, "accepted");
	assert.equal(outcome.probeState, "held");
	assert.equal(outcome.rating, "good");
	assert.equal(stepsForSession(db, sessionId)[0]!.state, "accepted");
	// The learner's words belong to the conversation, not only to the check row.
	assert.match(
		entries(db, sessionId)
			.filter((entry) => entry.role === "learner")
			.map((entry) => entry.text)
			.join("|"),
		/b — скорость изменения/,
	);
	// The check is answered: nothing is left to answer twice.
	assert.equal(pendingCheck(db, sessionId), null);
});

test("a check that asked for confidence refuses an answer without it", async () => {
	const { db, sessionId, stepId } = startedLesson();
	ask(db, sessionId, stepId, choice);
	await assert.rejects(service(db).answer(sessionId, { answer: 1 }), /без поля confidence ответ не принимается/);
});

test("a free-form answer is compared with the reference by the model", async () => {
	const { db, sessionId, stepId } = startedLesson();
	ask(db, sessionId, stepId, freeRecall);
	const transport = createFakeTransport({
		turns: [
			{ calls: [{ args: { reason: "смысл совпал", verdict: "correct" }, id: "grade-1", name: "grade_answer" }] },
			{ text: "" },
		],
	});

	const outcome = await service(db, transport).answer(sessionId, { answer: "частицы быстрее бегают", confidence: 3 });
	assert.equal(outcome.verdict, "correct");
	assert.equal(outcome.reason, "смысл совпал");
	// The judging request carried the reference: the model compares, it does not recall.
	const sent = transport.calls()[0]!.request.messages[0]!.content[0]!;
	assert.match(sent.type === "text" ? sent.text : "", /Эталон: частицы движутся быстрее/);
	assert.deepEqual(
		transport.calls()[0]!.request.tools.map((tool) => tool.name),
		["grade_answer"],
	);
});

test("a judge that answers with prose is refused, and the check stays open", async () => {
	const { db, sessionId, stepId } = startedLesson();
	ask(db, sessionId, stepId, freeRecall);
	// Prose instead of a call: the loop asks once more, and the answer is still not taken.
	const transport = createFakeTransport({ turns: [{ text: "кажется, верно" }, { text: "ну, в целом правильно" }, { text: "верно" }] });

	await assert.rejects(service(db, transport).answer(sessionId, { answer: "ну быстрее", confidence: 2 }), /оценка не получена/);
	assert.notEqual(pendingCheck(db, sessionId), null, "the check must still be open");
});

test("with nothing open the answer is refused, not swallowed", async () => {
	const { db, sessionId } = startedLesson();
	await assert.rejects(service(db).answer(sessionId, { answer: "некогда", confidence: 1 }), /открытых проверок нет/);
});
