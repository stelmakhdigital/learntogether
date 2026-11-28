import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createSession, entries, migrate, openDb, stepsForSession } from "@learntogether/data";
import { allowedRatings } from "@learntogether/domain";
import type { ToolPort } from "@learntogether/agent";
import { createStepTools } from "../../src/teach/steps.ts";
import { answerCheck } from "../../src/teach/answer.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));

type Db = Database.Database;

function openedDb(): Db {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function tool(db: Db, sessionId: string, name: string): ToolPort {
	const found = createStepTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(found, `tool ${name} is missing`);
	return found;
}

function call(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const out = tool(db, sessionId, name).run(args, `${name}-call`);
	if (typeof out !== "string") throw new Error(`${name} must answer synchronously with a string`);
	return out;
}

function recordStep(
	db: Db,
	sessionId: string,
	input: { statement: string; kind: "derivation" | "foundation"; premises?: string[] },
): { id: string; ordinal: number } {
	const answer = call(db, sessionId, "record_step", {
		statement: input.statement,
		kind: input.kind,
		premises: input.premises ?? (input.kind === "derivation" ? ["node-1"] : []),
		motivation: "на какой вопрос ученика отвечает",
	});
	const parsed = /^шаг (\S+) под номером (\d+);/.exec(answer);
	assert.ok(parsed, `unexpected record_step answer: ${answer}`);
	return { id: parsed[1]!, ordinal: Number(parsed[2]) };
}

function checkIdOf(answer: string): string {
	const parsed = /^проверка (\S+)$/.exec(answer);
	assert.ok(parsed, `unexpected check_understanding answer: ${answer}`);
	return parsed[1]!;
}

/** A presented step with one open free_recall check — the state answerCheck needs. */
function presentedWithCheck(db: Db, sessionId: string, statement: string): { stepId: string; checkId: string } {
	const { id: stepId, ordinal } = recordStep(db, sessionId, { statement, kind: "foundation" });
	assert.match(call(db, sessionId, "present_step", { step_id: stepId, text: "объяснение" }), new RegExp(`показан шаг ${ordinal}; следующий вызов — check_understanding со step_id`));
	const checkId = checkIdOf(
		call(db, sessionId, "check_understanding", {
			step_id: stepId,
			kind: "free_recall",
			question: "перескажи шаг своими словами",
			answer: ["кипит"],
			ask_confidence: true,
		}),
	);
	return { checkId, stepId };
}

test("record_step keeps foundations premise-free, refuses premise-less derivations, grows ordinal", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });

	const first = recordStep(db, sessionId, { statement: "вода кипит при 100 °C на уровне моря", kind: "foundation" });
	assert.equal(first.ordinal, 1);

	assert.throws(
		() => call(db, sessionId, "record_step", { statement: "следствие", kind: "derivation", premises: [] }),
		/requires at least one premise/,
	);

	const second = recordStep(db, sessionId, { statement: "пар уносит тепло", kind: "derivation", premises: ["node-1"] });
	assert.equal(second.ordinal, 2);

	const rows = stepsForSession(db, sessionId);
	assert.deepEqual(
		rows.map((row) => [row.ordinal, row.state, row.premises.length]),
		[
			[1, "planned", 0],
			[2, "planned", 1],
		],
	);
});

test("present_step moves planned to presented once and writes the wording into the transcript", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { id: stepId } = recordStep(db, sessionId, { statement: "давление пара растёт с температурой", kind: "foundation" });

	assert.match(call(db, sessionId, "present_step", { step_id: stepId, text: "смотри: молекулы бьют в крышку" }), /^показан шаг 1; следующий вызов — check_understanding/);
	assert.equal(stepsForSession(db, sessionId)[0]!.state, "presented");

	assert.throws(
		() => call(db, sessionId, "present_step", { step_id: stepId, text: "ещё раз" }),
		/в состоянии "presented"/,
	);

	const teacher = entries(db, sessionId).filter((entry) => entry.kind === "text" && entry.role === "teacher");
	assert.equal(teacher.length, 1);
	assert.equal(teacher[0]!.text, "давление пара растёт с температурой");
});

test("a step of another session is refused by every executor", () => {
	const db = openedDb();
	const mine = createSession(db, { kind: "teach" });
	const other = createSession(db, { kind: "teach" });
	const foreign = recordStep(db, other, { statement: "чужой шаг", kind: "foundation" });
	call(db, other, "present_step", { step_id: foreign.id, text: "чужое объяснение" });

	assert.throws(
		() => call(db, mine, "update_step", { step_id: foreign.id, statement: "перепишем" }),
		/шаг .* не из этой сессии/,
	);
	assert.throws(
		() => call(db, mine, "present_step", { step_id: foreign.id, text: "покажем" }),
		/шаг .* не из этой сессии/,
	);
	assert.throws(
		() =>
			call(db, mine, "check_understanding", {
				step_id: foreign.id,
				kind: "free_recall",
				question: "перескажи шаг своими словами",
				answer: ["чужой"],
				ask_confidence: true,
			}),
		/шаг .* не из этой сессии/,
	);

	// record_step takes no step_id: whatever else the call carries, it can only
	// write into its own session.
	const own = recordStep(db, mine, { statement: "свой шаг", kind: "foundation" });
	assert.ok(stepsForSession(db, mine).some((row) => row.id === own.id));
	assert.equal(stepsForSession(db, other).length, 1);

	assert.throws(() => call(db, mine, "present_step", { step_id: "нет-такого", text: "x" }), /шага нет-такого нет/);
});

test("check_understanding needs a presented step, choice kinds need options, labels stay unique", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { id: stepId } = recordStep(db, sessionId, { statement: "кристаллы льда растут от центра", kind: "foundation" });

	assert.throws(
		() =>
			call(db, sessionId, "check_understanding", {
				step_id: stepId,
				kind: "free_recall",
				question: "перескажи шаг своими словами",
				answer: ["растут"],
				ask_confidence: true,
			}),
		/"planned"/,
	);

	call(db, sessionId, "present_step", { step_id: stepId, text: "объяснение" });
	const checkId = checkIdOf(
		call(db, sessionId, "check_understanding", {
			step_id: stepId,
			kind: "free_recall",
			question: "перескажи шаг своими словами",
			answer: ["растут от центра"],
			ask_confidence: true,
		}),
	);
	assert.ok(checkId.length > 0);

	assert.throws(
		() =>
			call(db, sessionId, "check_understanding", {
				step_id: stepId,
				kind: "single_choice",
				question: "откуда растут кристаллы",
				answer: ["0"],
				ask_confidence: true,
			}),
		/single_choice.*нужны options/,
	);

	assert.throws(
		() =>
			call(db, sessionId, "check_understanding", {
				step_id: stepId,
				kind: "single_choice",
				question: "откуда растут кристаллы",
				options: [{ label: "А", text: "от центра" }, { label: "А", text: "от краёв" }],
				answer: ["0"],
				ask_confidence: true,
			}),
		/duplicate option label/,
	);
});

test("answerCheck rates by the domain ceiling and moves the step", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { checkId } = presentedWithCheck(db, sessionId, "paroобразование идёт с поверхности");

	const result = answerCheck(db, sessionId, {
		checkId,
		learnerAnswer: "с поверхности, при любой температуре",
		verdict: "correct",
		confidence: 4,
		hints: 0,
	});
	assert.equal(result.rating, "good");
	assert.equal(result.stepState, "accepted");
	assert.equal(result.probeState, "held");
	assert.equal(stepsForSession(db, sessionId)[0]!.state, "accepted");
});

test("answerCheck with hints stays in the allowed ratings and leaves the step on the frontier", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { checkId } = presentedWithCheck(db, sessionId, "шаг для замера с подсказками");

	const result = answerCheck(db, sessionId, {
		checkId,
		learnerAnswer: "с поверхности",
		verdict: "correct",
		confidence: 5,
		hints: 2,
	});
	assert.ok(allowedRatings("correct", 2).includes(result.rating), `rating ${result.rating} is not allowed`);
	assert.equal(result.probeState, "frontier");
	assert.equal(result.stepState, "accepted");
});

test("answerCheck with a wrong answer sends the step to repair", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { checkId, stepId } = presentedWithCheck(db, sessionId, "шаг, который не поняли");

	const result = answerCheck(db, sessionId, {
		checkId,
		learnerAnswer: "не знаю",
		verdict: "incorrect",
		confidence: 1,
	});
	assert.equal(result.rating, "again");
	assert.equal(result.stepState, "repaired");
	assert.equal(stepsForSession(db, sessionId).find((row) => row.id === stepId)!.state, "repaired");
});

test("answerCheck refuses a second answer, a foreign check and an unknown one", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const stranger = createSession(db, { kind: "teach" });
	const { checkId } = presentedWithCheck(db, sessionId, "шаг с однократным ответом");
	const foreign = presentedWithCheck(db, stranger, "чужой шаг с проверкой");

	const input = { checkId, learnerAnswer: "с поверхности", verdict: "correct" as const, confidence: 3, hints: 0 };
	answerCheck(db, sessionId, input);
	assert.throws(() => answerCheck(db, sessionId, input), /принят раньше/);

	assert.throws(
		() =>
			answerCheck(db, sessionId, {
				checkId: foreign.checkId,
				learnerAnswer: "чужой ответ",
				verdict: "correct",
				confidence: 3,
			}),
		/проверка .* не из этой сессии/,
	);
	assert.throws(
		() => answerCheck(db, sessionId, { checkId: "нет-такой", learnerAnswer: "x", verdict: "correct", confidence: 3 }),
		/проверки нет-такой нет/,
	);
});

test("update_step edits a presented step and never touches an accepted one", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const { id: stepId } = recordStep(db, sessionId, { statement: "первая формулировка", kind: "foundation" });
	call(db, sessionId, "present_step", { step_id: stepId, text: "объяснение" });

	assert.throws(() => call(db, sessionId, "update_step", { step_id: stepId }), /ни одного поля/);

	assert.equal(call(db, sessionId, "update_step", { step_id: stepId, statement: "вторая формулировка" }), `обновлён шаг ${stepId}`);
	const afterEdit = stepsForSession(db, sessionId)[0]!;
	assert.equal(afterEdit.statement, "вторая формулировка");
	assert.equal(afterEdit.state, "presented");

	const checkId = checkIdOf(
		call(db, sessionId, "check_understanding", {
			step_id: stepId,
			kind: "free_recall",
			question: "перескажи шаг своими словами",
			answer: ["вторая формулировка"],
			ask_confidence: true,
		}),
	);
	answerCheck(db, sessionId, {
		checkId,
		learnerAnswer: "вторая формулировка",
		verdict: "correct",
		confidence: 5,
		hints: 0,
	});
	assert.equal(stepsForSession(db, sessionId)[0]!.state, "accepted");
	assert.throws(
		() => call(db, sessionId, "update_step", { step_id: stepId, statement: "третья формулировка" }),
		/"accepted"/,
	);
	assert.equal(stepsForSession(db, sessionId)[0]!.statement, "вторая формулировка");
});
