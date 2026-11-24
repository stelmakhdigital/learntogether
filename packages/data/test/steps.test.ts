import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createSession } from "../src/repos/sessions.ts";
import { acceptStep, checksForStep, createStep, presentStep, recordCheck, resolveCheck, stepsForSession } from "../src/repos/steps.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function sessionWithStep(
	db: ReturnType<typeof openDb>,
	input: { kind: "derivation" | "foundation"; premises?: string[] } = { kind: "derivation", premises: ["p"] },
): { sessionId: string; stepId: string } {
	const sessionId = createSession(db, { kind: "teach" });
	const { id } = createStep(db, {
		sessionId,
		statement: "если нагреть, частицы движутся быстрее",
		kind: input.kind,
		...(input.premises !== undefined ? { premises: input.premises } : {}),
	});
	return { sessionId, stepId: id };
}

test("derivation without premises is refused, foundation with premises is refused", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	assert.throws(
		() => createStep(db, { sessionId, statement: "s", kind: "derivation", premises: [] }),
		/derivation" requires at least one premise/,
	);
	assert.throws(
		() => createStep(db, { sessionId, statement: "s", kind: "foundation", premises: ["почему-то"] }),
		/foundation" must have empty premises/,
	);
	assert.equal(stepsForSession(db, sessionId).length, 0, "refused steps must not be stored");
	db.close();
});

test("acceptStep before any check is refused with a concrete reason, after a correct check it passes", () => {
	const db = openedDb();
	const { sessionId, stepId } = sessionWithStep(db);
	presentStep(db, stepId);
	assert.throws(() => acceptStep(db, stepId), /has no check with verdict "correct"/);

	const checkId = recordCheck(db, {
		stepId,
		kind: "single_choice",
		question: "Что происходит при нагреве?",
		options: [{ label: "a", text: "быстрее" }, { label: "b", text: "медленнее" }],
		answer: 0,
	});
	resolveCheck(db, checkId, { learnerAnswer: 0, verdict: "correct", confidence: 4 });
	acceptStep(db, stepId);
	const [step] = stepsForSession(db, sessionId);
	assert.equal(step?.state, "accepted");
	assert.equal(step?.checkCount, 1);
	db.close();
});

test("recordCheck on a planned step is refused", () => {
	const db = openedDb();
	const { stepId } = sessionWithStep(db);
	assert.throws(() => recordCheck(db, { stepId, kind: "free_recall", question: "q", answer: "эталон" }), /step .* is "planned"/);
	db.close();
});

test("resolveCheck with verdict incorrect moves the step to repaired, not accepted", () => {
	const db = openedDb();
	const { sessionId, stepId } = sessionWithStep(db);
	presentStep(db, stepId);
	const checkId = recordCheck(db, {
		stepId,
		kind: "single_choice",
		question: "Что происходит при нагреве?",
		options: [{ label: "a", text: "быстрее" }, { label: "b", text: "медленнее" }],
		answer: 0,
		why: "почему ты так решил?",
	});
	const result = resolveCheck(db, checkId, { learnerAnswer: 1, verdict: "incorrect", confidence: 4 });
	assert.deepEqual(result, { stepState: "repaired", probeState: "absent" });
	const [step] = stepsForSession(db, sessionId);
	assert.equal(step?.state, "repaired");
	assert.equal(step?.checkCount, 1);
	db.close();
});

test("hints buy a frontier, zero hints mean held", () => {
	const db = openedDb();
	const withHints = sessionWithStep(db);
	presentStep(db, withHints.stepId);
	const first = recordCheck(db, { stepId: withHints.stepId, kind: "free_recall", question: "q", answer: "эталон" });
	assert.deepEqual(resolveCheck(db, first, { learnerAnswer: "ну..., быстрее", verdict: "correct", confidence: 3, hints: 2 }), {
		stepState: "accepted",
		probeState: "frontier",
	});

	const withoutHints = sessionWithStep(db);
	presentStep(db, withoutHints.stepId);
	const second = recordCheck(db, { stepId: withoutHints.stepId, kind: "free_recall", question: "q", answer: "эталон" });
	assert.deepEqual(resolveCheck(db, second, { learnerAnswer: "быстрее", verdict: "correct", confidence: 5, hints: 0 }), {
		stepState: "accepted",
		probeState: "held",
	});
	db.close();
});

test("duplicate option labels are refused", () => {
	const db = openedDb();
	const { stepId } = sessionWithStep(db);
	presentStep(db, stepId);
	assert.throws(
		() =>
			recordCheck(db, {
				stepId,
				kind: "single_choice",
				question: "q",
				options: [{ label: "a", text: "раз" }, { label: "a", text: "два" }],
				answer: 0,
			}),
		/duplicate option label "a"/,
	);
	assert.equal(checksForStep(db, stepId).length, 0);
	db.close();
});

test("step ordinals run 1,2,3 per session and stay stable across reads", () => {
	const db = openedDb();
	const { sessionId } = sessionWithStep(db, { kind: "foundation", premises: [] });
	const first = stepsForSession(db, sessionId).map((step) => step.ordinal);
	assert.deepEqual(first, [1]);
	const second = createStep(db, { sessionId, statement: "s2", kind: "derivation", premises: ["p"] });
	stepsForSession(db, sessionId);
	const third = createStep(db, { sessionId, statement: "s3", kind: "derivation", premises: ["p"] });
	assert.deepEqual(
		stepsForSession(db, sessionId).map((step) => step.ordinal),
		[1, 2, 3],
	);
	assert.equal(second.ordinal, 2);
	assert.equal(third.ordinal, 3);
	db.close();
});
