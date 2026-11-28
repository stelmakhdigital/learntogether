// Context assembly and compactation (docs/architecture.md, шаг 2 потока хода).
// The counter is a fixture here: what the tests care about is that the context is
// read from the database, that the lesson state survives a fold, and that the
// input tokens of a turn do not grow as the lesson gets longer.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	appendEntry,
	createSession,
	createStep,
	migrate,
	openDb,
	presentStep,
	recordCheck,
	resolveCheck,
	setPlan,
	setSessionGoal,
	upsertProbe,
	activeSummary,
} from "@learntogether/data";
import { createFakeTransport } from "@learntogether/models";
import type { Request, TokenCounter, Transport } from "@learntogether/models";
import { fitRequest, lessonStateBlock } from "../src/context.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

function startedSession() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "teach" }) };
}

/** A deterministic stand-in for the server tokenizer: three characters per token
 *  is close enough for the sizes these tests use, and it counts the system text,
 *  the messages and the tool schemas the same way the real one does. */
function fixtureCounter(): TokenCounter {
	return {
		async count(request: Request): Promise<number> {
			let chars = request.system.length;
			for (const message of request.messages) {
				for (const block of message.content) {
					if (block.type === "text") chars += block.text.length;
				}
			}
			for (const tool of request.tools) chars += tool.name.length + tool.description.length;
			return Math.ceil(chars / 3);
		},
	};
}

const baseRequest: Request = {
	budget: { input: 1000, output: 400 },
	messages: [],
	reasoningLevel: "none",
	system: "",
	tools: [{ description: "записать шаг урока", name: "record_step", parameters: { type: "object" } }],
};

function summarizer(text = "сводка: разобрали определение и остановились на проверке"): Transport {
	return createFakeTransport({
		turns: Array.from({ length: 20 }, () => ({ text })),
	});
}

function fit(db: ReturnType<typeof openDb>, sessionId: string, overrides: Partial<Request> = {}, transport?: Transport) {
	return fitRequest({
		counter: fixtureCounter(),
		db,
		request: { ...baseRequest, ...overrides, budget: overrides.budget ?? baseRequest.budget },
		sessionId,
		system: "Ты учитель тренажёра понимания.",
		transport: transport ?? summarizer(),
	});
}

test("the state block names the step, its state and the check awaiting an answer", () => {
	const { db, sessionId } = startedSession();
	assert.match(lessonStateBlock(db, sessionId), /шагов ещё нет/);

	const step = createStep(db, { kind: "foundation", motivation: "без него дальше нечего опереть", sessionId, statement: "Производная — скорость изменения." });
	// A step is named by its id and the next call is named too: the model cannot
	// guess either of them.
	assert.match(lessonStateBlock(db, sessionId), new RegExp(`шаг 1 \\(id ${step.id}, foundation, planned\\)`));
	assert.match(lessonStateBlock(db, sessionId), /ещё не показан — следующий вызов: present_step со step_id/);

	presentStep(db, step.id);
	assert.match(lessonStateBlock(db, sessionId), /проверки нет — следующий вызов: check_understanding со step_id/);

	recordCheck(db, {
		answer: 1,
		kind: "single_choice",
		options: [{ label: "0", text: "наклон" }, { label: "1", text: "скорость" }],
		question: "Что измеряет производная?",
		stepId: step.id,
	});

	const block = lessonStateBlock(db, sessionId);
	assert.match(block, new RegExp(`шаг 1 \\(id ${step.id}, foundation, presented\\)`));
	assert.match(block, /ждёт ответа ученика: Что измеряет производная\? варианты: 0 — наклон; 1 — скорость/);
	assert.match(block, /служебная сводка/);
});

test("a turn that fits carries the conversation verbatim, learner last", async () => {
	const { db, sessionId } = startedSession();
	appendEntry(db, { kind: "text", role: "learner", sessionId, text: "объясни производную" });
	appendEntry(db, { kind: "text", role: "teacher", sessionId, text: "это скорость изменения" });
	appendEntry(db, { kind: "tool_call", role: "system", sessionId, text: "record_step {}" });
	appendEntry(db, { kind: "text", role: "learner", sessionId, text: "а дифференциал?" });

	const request = await fit(db, sessionId);
	assert.deepEqual(
		request.messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	assert.equal(request.messages[2]!.content[0]!.type, "text");
	assert.match(request.system, /Ты учитель тренажёра понимания\./);
	assert.match(request.system, /Состояние урока:/);
});

test("a turn that does not fit folds the oldest exchanges into the summary", async () => {
	const { db, sessionId } = startedSession();
	// The oldest part of the lesson is wordy, the newest is short: a fold has to
	// free real space, and the tail the learner is in the middle of must survive.
	for (let i = 0; i < 4; i += 1) {
		appendEntry(db, {
			kind: "text",
			role: i % 2 === 0 ? "learner" : "teacher",
			sessionId,
			text: `ход ${i}: ${"подробное объяснение с примерами и оговорками ".repeat(3)}`,
		});
	}
	for (let i = 0; i < 6; i += 1) {
		appendEntry(db, { kind: "text", role: i % 2 === 0 ? "learner" : "teacher", sessionId, text: `короткий ход ${i}` });
	}
	const request = await fit(db, sessionId, { budget: { input: 200, output: 400 } });

	const summary = activeSummary(db, sessionId);
	assert.notEqual(summary, null);
	assert.equal(summary!.text, "сводка: разобрали определение и остановились на проверке");
	assert.ok(summary!.watermark >= 1, "watermark must cover the folded part");
	assert.ok(request.messages.length <= 6, `expected at most six verbatim messages, got ${request.messages.length}`);
	assert.match(request.system, /Что было до этого \(сводка\)/);
});

test("input tokens of a turn do not grow as the lesson gets longer", async () => {
	const { db, sessionId } = startedSession();
	const counter = fixtureCounter();
	const transport = summarizer();
	const sizes: number[] = [];

	for (let i = 0; i < 14; i += 1) {
		appendEntry(db, {
			kind: "text",
			role: i % 2 === 0 ? "learner" : "teacher",
			sessionId,
			text: `ход ${i}: ${"обсуждаем определение и проверяем его на примерах ".repeat(2)}`,
		});
		const request = await fitRequest({
			counter,
			db,
			request: { ...baseRequest, budget: { input: 400, output: 400 } },
			sessionId,
			system: "Ты учитель тренажёра понимания.",
			transport,
		});
		sizes.push(await counter.count(request));
	}

	assert.ok(
		sizes.every((size) => size <= 400),
		`every turn must fit the measured budget, got ${sizes.join(", ")}`,
	);
	// The invariant of docs/architecture.md: without a fold the size climbs with
	// the lesson. A fold happened, and the newest turn is smaller than the biggest
	// turn before it — the request stopped tracking the length of the session.
	const peak = Math.max(...sizes.slice(0, -1));
	assert.ok(sizes.at(-1)! < peak, `context grew with the lesson: ${sizes.join(", ")}`);
	assert.ok(activeSummary(db, sessionId) !== null, "a long lesson must have folded at least once");
});

test("when there is nothing left to fold the window is named, not the lesson shortened", async () => {
	const { db, sessionId } = startedSession();
	appendEntry(db, { kind: "text", role: "learner", sessionId, text: "короткий вопрос" });

	await assert.rejects(
		fit(db, sessionId, { budget: { input: 5, output: 100 } }),
		/ход не влезает в измеренный контекст: \d+ токенов входа при бюджете 5/,
	);
	assert.equal(activeSummary(db, sessionId), null, "a failed fit must not fold anything");
});

test("a summarizer that refuses stops the turn with its own words", async () => {
	const { db, sessionId } = startedSession();
	for (let i = 0; i < 10; i += 1) {
		appendEntry(db, { kind: "text", role: "learner", sessionId, text: `ход ${i} длинный и подробный` });
	}
	const broken = createFakeTransport({ turns: [{ error: "llama-server: загрузка модели не удалась" }] });

	await assert.rejects(fit(db, sessionId, { budget: { input: 40, output: 200 } }, broken), /компакция не удалась/);
});

test("a step the learner holds is closed for the model and sends it to the next one", () => {
	const { db, sessionId } = startedSession();
	const step = createStep(db, { kind: "foundation", motivation: "без него дальше нечего опереть", sessionId, statement: "Производная — скорость изменения." });
	presentStep(db, step.id);
	const checkId = recordCheck(db, {
		answer: 1,
		kind: "single_choice",
		options: [{ label: "0", text: "наклон" }, { label: "1", text: "скорость" }],
		question: "Что измеряет производная?",
		stepId: step.id,
	});
	resolveCheck(db, checkId, { confidence: 4, learnerAnswer: 1, rating: "good", verdict: "correct" });

	assert.match(
		lessonStateBlock(db, sessionId),
		/принят учеником — к этому шагу больше не возвращайся, следующий вызов: record_step для нового шага/,
	);
});

test("the state block sends the lesson through its phases by the tool it lacks", () => {
	const { db, sessionId } = startedSession();
	// Nothing measured yet: the model is sent to the probe, not to a step.
	assert.match(lessonStateBlock(db, sessionId), /замера нет:.*probe_record, шагов пока не пиши/);

	upsertProbe(db, { confidence: 4, sessionId, state: "frontier", statement: "Что измеряет производная" });
	upsertProbe(db, { confidence: 5, sessionId, state: "contradicted", statement: "Производная — это площадь" });
	assert.match(lessonStateBlock(db, sessionId), /замер есть: следующий вызов goal_state/);
	assert.match(lessonStateBlock(db, sessionId), /на границе: Что измеряет производная/);
	assert.match(lessonStateBlock(db, sessionId), /заблуждение \(знает наоборот\): Производная — это площадь/);

	setSessionGoal(db, { raw: "разобраться", readyWhen: "сам выведет", sessionId, statements: ["вывести перестановку"] });
	const withGoal = lessonStateBlock(db, sessionId);
	assert.match(withGoal, /цель: вывести перестановку; готовность: сам выведет/);
	assert.match(withGoal, /цель есть: следующий вызов plan_set/);

	setPlan(db, { nodes: [{ label: "Скорость изменения", nodeId: "n1", whyNeeded: "первая ступень" }], sessionId });
	const withPlan = lessonStateBlock(db, sessionId);
	assert.match(withPlan, /план: n1 — Скорость изменения/);
	assert.doesNotMatch(withPlan, /следующий вызов plan_set/);
});
