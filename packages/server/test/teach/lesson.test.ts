// The tools that precede a step. Each refusal has to say what to do next: these
// answers go back to a model that is steering the lesson, and a refusal without a
// direction is how a turn dies.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { activePlan, createSession, goalForSession, migrate, openDb, probesForSession } from "@learntogether/data";
import { createLessonTools } from "../../src/teach/lesson.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));

type Db = ReturnType<typeof openDb>;

function openedDb(): { db: Db; sessionId: string } {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "teach" }) };
}

function call(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const tool = createLessonTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} is missing`);
	return String(tool.run(args, `${name}-call`));
}

const probeArgs = {
	items: [
		{ confidence: 4, statement: "сложение не зависит от порядка", state: "held" },
		{ confidence: 2, statement: "скобки меняют порядок", state: "frontier" },
	],
};

test("probe_record stores what the learner holds and names the next call", () => {
	const { db, sessionId } = openedDb();
	const answer = call(db, sessionId, "probe_record", probeArgs);

	assert.match(answer, /замер записан: 1 held, 1 frontier/);
	assert.match(answer, /следующий вызов: goal_state/);
	const probes = probesForSession(db, sessionId);
	assert.deepEqual(
		probes.map((probe) => [probe.statement, probe.state, probe.confidence]),
		[
			["сложение не зависит от порядка", "held", 4],
			["скобки меняют порядок", "frontier", 2],
		],
	);
	// A second record of the same wording refines the probe instead of doubling it.
	call(db, sessionId, "probe_record", { items: [{ confidence: 5, statement: "сложение не зависит от порядка", state: "held" }] });
	assert.equal(probesForSession(db, sessionId).length, 2);
});

test("a probe without a state or a confidence is refused with the words to fix it", () => {
	const { db, sessionId } = openedDb();
	assert.throws(
		() => call(db, sessionId, "probe_record", { items: [{ confidence: 4, statement: "что-то", state: "почти" }] }),
		/state: нужно held, frontier, absent или contradicted/,
	);
	assert.throws(
		() => call(db, sessionId, "probe_record", { items: [{ confidence: 9, statement: "что-то", state: "held" }] }),
		/confidence: нужно целое 1\.\.5/,
	);
	// A reference to a graph node has no target yet: saying so beats filing it nowhere.
	assert.throws(
		() =>
			call(db, sessionId, "probe_record", {
				items: [{ basis_ref: "узел-77", confidence: 4, statement: "что-то", state: "held" }],
			}),
		/basis_ref.*номер записи разговора/,
	);
	assert.equal(probesForSession(db, sessionId).length, 0);
});

test("goal_state records the goal, moves the session to planning and hands over to plan_set", () => {
	const { db, sessionId } = openedDb();
	const answer = call(db, sessionId, "goal_state", {
		raw: "разобраться с перестановкой",
		ready_when: "ученик сам выводит перестановку на новых числах",
		statements: ["объяснить, почему сумма не меняется", "применить к новому числу"],
	});

	assert.match(answer, /цель зафиксирована: 2 пунктов/);
	assert.match(answer, /следующий вызов: plan_set/);
	const goal = goalForSession(db, sessionId)!;
	assert.equal(goal.raw, "разобраться с перестановкой");
	assert.equal(goal.statements.length, 2);
	const session = db.prepare("SELECT state FROM session WHERE id = ?").get(sessionId) as { state: string };
	assert.equal(session.state, "planning");
});

test("plan_set prunes what the learner holds and says what it dropped", () => {
	const { db, sessionId } = openedDb();
	call(db, sessionId, "probe_record", { items: [{ confidence: 5, statement: "Порядок слагаемых", state: "held" }] });

	const answer = call(db, sessionId, "plan_set", {
		nodes: [
			{ label: "Порядок слагаемых", node_id: "n1", why_needed: "основа" },
			{ depends_on: ["n1"], label: "Скобки", node_id: "n2", why_needed: "следующая ступень" },
		],
	});

	assert.match(answer, /план задан; убрано из плана как держимое: n1/);
	assert.match(answer, /следующий вызов: record_step/);
	const plan = activePlan(db, sessionId)!;
	assert.equal(plan.nodes.length, 2);
	assert.equal(plan.nodes[0]!.state, "pruned_held");
});
