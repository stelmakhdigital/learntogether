// Before the first step: the goal, the plan and what the learner holds. The rules
// worth testing are the ones the method cares about — a node without a reason does
// not enter the plan, a held node is not taught, and the taught path is not
// rewritten under the learner (docs/teaching-method.md sections 2 and 3).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	activePlan,
	createSession,
	createStep,
	goalForSession,
	migrate,
	openDb,
	presentStep,
	setPlan,
	setSessionGoal,
	upsertProbe,
	type PlanNodeInput,
} from "@learntogether/data";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function startedSession(): { db: ReturnType<typeof openDb>; sessionId: string } {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "teach" }) };
}

function node(nodeId: string, over?: { dependsOn?: string[]; label?: string; parentId?: string; whyNeeded?: string }): PlanNodeInput {
	return {
		label: `узел ${nodeId}`,
		nodeId,
		whyNeeded: "отвечает на вопрос ученика",
		...over,
	};
}

test("a goal needs statements and a criterion, and it refines in place", () => {
	const { db, sessionId } = startedSession();
	assert.throws(() => setSessionGoal(db, { raw: "разобраться", readyWhen: " ", sessionId, statements: ["объяснить"] }), /readyWhen/);
	assert.throws(() => setSessionGoal(db, { raw: "разобраться", readyWhen: "объяснит сам", sessionId, statements: [] }), /хотя бы один пункт/);

	const first = setSessionGoal(db, { raw: "разобраться", readyWhen: "объяснит сам", sessionId, statements: ["объяснить перестановку"] });
	const goal = goalForSession(db, sessionId);
	assert.equal(goal?.id, first);
	assert.equal(goal?.raw, "разобраться");
	// The session left the measuring phase the moment it got a goal.
	const state = db.prepare("SELECT state FROM session WHERE id = ?").get(sessionId) as { state: string };
	assert.equal(state.state, "planning");

	const again = setSessionGoal(db, { raw: "разобраться точнее", readyWhen: "решит новую задачу", sessionId, statements: ["объяснить перестановку", "применить"] });
	assert.equal(again, first, "refinement must update the same goal, not leave an orphan");
	assert.equal(goalForSession(db, sessionId)?.statements.length, 2);
	const goals = db.prepare("SELECT COUNT(*) AS n FROM goal").get() as { n: number };
	assert.equal(goals.n, 1);
});

test("a plan refuses nodes without a reason, unknown links and self-support", () => {
	const { db, sessionId } = startedSession();
	assert.throws(() => setPlan(db, { nodes: [], sessionId }), /из нуля узлов/);
	assert.throws(() => setPlan(db, { nodes: [node("n1", { whyNeeded: "  " })], sessionId }), /why_needed/);
	assert.throws(() => setPlan(db, { nodes: [node("n1", { parentId: "нет-такого" })], sessionId }), /родителя|parent_id/);
	assert.throws(() => setPlan(db, { nodes: [node("n1", { dependsOn: ["нет-такого" as string] })], sessionId }), /depends_on/);
	assert.throws(() => setPlan(db, { nodes: [node("n1", { dependsOn: ["n1"] })], sessionId }), /сам на себя/);
	assert.throws(() => setPlan(db, { nodes: [node("n1"), node("n1")], sessionId }), /уже в плане/);
});

test("a node the learner holds stays visible but is not taught", () => {
	const { db, sessionId } = startedSession();
	upsertProbe(db, { confidence: 4, sessionId, state: "held", statement: "Узел n1" });

	const { pruned } = setPlan(db, { nodes: [node("n1"), node("n2", { dependsOn: ["n1"] })], sessionId });
	assert.deepEqual(pruned, ["n1"]);

	const plan = activePlan(db, sessionId)!;
	assert.equal(plan.nodes.find((item) => item.nodeId === "n1")!.state, "pruned_held");
	assert.equal(plan.nodes.find((item) => item.nodeId === "n2")!.state, "todo");
	// Trailing punctuation and case are not a difference in wording.
	assert.deepEqual(plan.nodes.find((item) => item.nodeId === "n2")!.dependsOn, ["n1"]);
});

test("a plan made only of held nodes is refused instead of opening an empty lesson", () => {
	const { db, sessionId } = startedSession();
	upsertProbe(db, { confidence: 5, sessionId, state: "held", statement: "Узел n1" });
	assert.throws(() => setPlan(db, { nodes: [node("n1")], sessionId }), /весь план уже держится/);
});

test("a plan does not rewrite what was already taught", () => {
	const { db, sessionId } = startedSession();
	setPlan(db, { nodes: [node("n1"), node("n2")], sessionId });
	const step = createStep(db, { kind: "foundation", sessionId, statement: "узел n1" });
	// Taught means shown to the learner: that is what "already walked through" is.
	presentStep(db, step.id);

	assert.throws(() => setPlan(db, { nodes: [node("n1"), node("n3")], sessionId }), /не переписывают пройденное/);
	// A plan that keeps the taught node out is accepted and replaces the old one.
	const { planId } = setPlan(db, { nodes: [node("n3")], sessionId });
	const old = db.prepare("SELECT id, replaced_by FROM plan WHERE id != ?").get(planId) as { replaced_by: string };
	assert.equal(old.replaced_by, planId);
	assert.equal(activePlan(db, sessionId)!.id, planId);
});

test("the first recorded step turns the session into a teaching run", () => {
	const { db, sessionId } = startedSession();
	setSessionGoal(db, { raw: "разобраться", readyWhen: "сам выведет", sessionId, statements: ["вывести перестановку"] });
	createStep(db, { kind: "foundation", sessionId, statement: "От перестановки сумма не меняется" });

	const session = db.prepare("SELECT state FROM session WHERE id = ?").get(sessionId) as { state: string };
	assert.equal(session.state, "teaching");
});
