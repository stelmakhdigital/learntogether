// Practice tools as the model meets them: the reference before the answer, the
// topic name refused, a repeated form refused, and the rating checked against what
// the verdict allows (D-037).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createSession, migrate, openDb, problemsForClaim, upsertClaim } from "@learntogether/data";
import { createPracticeTools } from "../../src/teach/practice.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));

type Db = Database.Database;

function openedDb(): { db: Db; sessionId: string } {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "practice" }) };
}

function call(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const tool = createPracticeTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} is missing`);
	return String(tool.run(args, `${name}-call`));
}

const NODE = "Производная есть скорость изменения функции в точке";

test("a statement that names the topic is refused with the leaking word", () => {
	const { db, sessionId } = openedDb();
	const claimId = upsertClaim(db, { text: NODE }).id;
	const base = { claim_id: claimId, kind: "recall", solution: "как быстро меняется функция" };

	assert.throws(
		() => call(db, sessionId, "pose_problem", { ...base, statement: "Что такое производная функции?" }),
		/условие называет тему словом «производная»/,
	);
	// A different storyline about the same node is what the method asks for.
	const id = call(db, sessionId, "pose_problem", { ...base, statement: "Мяч летит, расстояние меняется по закону t в квадрате" });
	assert.ok(id.length > 10);
	assert.deepEqual(problemsForClaim(db, claimId).map((problem) => problem.statement), [
		"Мяч летит, расстояние меняется по закону t в квадрате",
	]);
});

test("the same wording of a problem for the same node is refused", () => {
	const { db, sessionId } = openedDb();
	const claimId = upsertClaim(db, { text: NODE }).id;
	const pose = (statement: string) =>
		call(db, sessionId, "pose_problem", { claim_id: claimId, hints: ["что меняется быстрее"], kind: "transfer", solution: "эталон", statement });

	pose("Мяч летит, расстояние меняется по закону t в квадрате");
	assert.throws(() => pose("  мяч летит, расстояние   меняется по закону t в квадрате  "), /уже была/);
	assert.match(pose("Поезд идёт так, что путь зависит от времени квадратично"), /раньше по этому узлу уже спрашивали/);
});

test("the outcome rates what the verdict allows and reaches the scheduler", () => {
	const { db, sessionId } = openedDb();
	const claimId = upsertClaim(db, { text: NODE }).id;
	call(db, sessionId, "pose_problem", {
		claim_id: claimId,
		kind: "transfer",
		solution: "производная пути есть скорость",
		statement: "Путь зависит от времени квадратично",
	});
	const [problem] = problemsForClaim(db, claimId);
	assert.ok(problem, "the problem has to be stored");
	const problemId = problem.id;

	assert.throws(
		() => call(db, sessionId, "problem_outcome", { problem_id: problemId, rating: "good", verdict: "incorrect" }),
		/rating "good" недоступна при вердикте "incorrect"/,
	);
	assert.throws(() => call(db, sessionId, "problem_outcome", { hint_count: -1, problem_id: problemId, rating: "again", verdict: "incorrect" }), /hint_count/);

	const failed = call(db, sessionId, "problem_outcome", {
		note: "взял путь вместо отношения приращений",
		problem_id: problemId,
		rating: "again",
		verdict: "incorrect",
	});
	assert.match(failed, /вернётся через 10 минут/);

	const item = db
		.prepare("SELECT method, lapses, due_at, state FROM repeat_item WHERE claim_id = ?")
		.get(claimId) as { due_at: string; lapses: number; method: string; state: string };
	assert.deepEqual(item.method, "transfer");
	assert.deepEqual(item.lapses, 1);
	assert.deepEqual(item.state, "learning");

	const attempt = db.prepare("SELECT verdict, rating, note, problem_id FROM attempt").get() as Record<string, unknown>;
	assert.deepEqual(attempt, {
		note: "взял путь вместо отношения приращений",
		problem_id: problemId,
		rating: "again",
		verdict: "incorrect",
	});
});
