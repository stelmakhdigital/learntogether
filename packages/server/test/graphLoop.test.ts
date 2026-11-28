// The closed loop of этап 4: what one lesson taught shows up in the next lesson's
// plan as held. If this breaks, the graph is a diary nobody reads.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	closeSession,
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
} from "@learntogether/data";
import { lessonStateBlock } from "../src/context.ts";
import { createGraphTools } from "../src/teach/graph.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

/** One accepted step, written the way the lesson writes it: no manual rows. */
function teachOneStep(db: ReturnType<typeof openDb>, statement: string): string {
	const sessionId = createSession(db, { kind: "teach" });
	const step = createStep(db, { kind: "foundation", sessionId, statement });
	presentStep(db, step.id);
	const checkId = recordCheck(db, { answer: "да", kind: "free_recall", question: "перескажи своими словами", stepId: step.id });
	resolveCheck(db, checkId, { confidence: 4, learnerAnswer: "да", verdict: "correct" });
	closeSession(db, sessionId);
	return sessionId;
}

test("a step accepted in one lesson is held in the next lesson's plan", () => {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const taught = "Производная есть скорость изменения функции";
	const taughtSession = teachOneStep(db, taught);

	const next = createSession(db, { kind: "teach" });
	upsertProbe(db, { confidence: 3, sessionId: next, state: "frontier", statement: "Что такое дифференциал" });
	setSessionGoal(db, {
		raw: "дойти до дифференциала",
		readyWhen: "ученик сам выкладывает дифференциал из приращения",
		sessionId: next,
		statements: ["связать дифференциал с приращением"],
	});
	setPlan(db, {
		nodes: [
			{ label: "производная есть скорость изменения функции", nodeId: "n1", whyNeeded: "первая ступень" },
			{ label: "дифференциал как линейная часть приращения", nodeId: "n2", whyNeeded: "цель" },
		],
		sessionId: next,
	});

	const block = lessonStateBlock(db, next);
	// The learner's phrasing differed in case — the node is still recognized.
	assert.match(block, /n1 — производная есть скорость изменения функции \(уже в графе\)/);
	assert.doesNotMatch(block, /n2 — дифференциал как линейная часть приращения \(уже в графе\)/);

	// And the teacher finds the node by the words the learner uses, with its history.
	const search = createGraphTools(db, next).find((tool) => tool.name === "graph_search")!;
	const found = String(search.run({ query: "производная скорость" }, "call-1"));
	const id = found.match(/^([0-9a-f-]{36}):/m)![1]!;
	const read = createGraphTools(db, next).find((tool) => tool.name === "graph_read")!;
	const reading = String(read.run({ id }, "call-2"));
	assert.match(reading, /узел «Производная есть скорость изменения функции»/);
	assert.match(reading, new RegExp(`взято: урок ${taughtSession}`));
});
