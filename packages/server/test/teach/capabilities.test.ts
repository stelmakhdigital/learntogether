// The capability table is the seam the method is extended through (D-080). What it
// must guarantee today, before any plugin exists: a session gets exactly the tools of
// its kind, and a tool that forgot to say which capability it belongs to never reaches
// the model at all.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createSession, migrate, openDb } from "@learntogether/data";
import type { ToolPort } from "@learntogether/agent";
import { capabilitiesFor, createTeachTools, selectTools } from "../../src/teach/tools.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));

function sessionOf(kind: "practice" | "teach"): { db: ReturnType<typeof openDb>; sessionId: string } {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind }) };
}

const names = (tools: ToolPort[]): string[] => tools.map((tool) => tool.name).sort();

test("урок получает фазы, шаги и проверку; практика — задачу и чтение графа", () => {
	const lesson = sessionOf("teach");
	assert.deepEqual(names(createTeachTools(lesson.db, lesson.sessionId)), [
		"check_understanding",
		"goal_state",
		"graph_read",
		"graph_search",
		"plan_set",
		"present_step",
		"probe_record",
		"record_step",
		"update_step",
	]);
	const practice = sessionOf("practice");
	assert.deepEqual(names(createTeachTools(practice.db, practice.sessionId)), ["graph_read", "graph_search", "pose_problem", "problem_outcome"]);
	lesson.db.close();
	practice.db.close();
});

test("инструмент без возможности не проходит, а не проходит молча", () => {
	const stranger: ToolPort = {
		description: "чужой инструмент",
		name: "summon_answer_key",
		run: () => "ок",
		schema: { properties: {}, type: "object" },
	};
	assert.throws(() => selectTools([stranger], "teach"), /инструменты без возможности: summon_answer_key/);
	// A known tool is not enough: the capability has to be granted to this kind too.
	const practice = names(
		selectTools(
			[
				{ description: "показать шаг", name: "present_step", run: () => "ок", schema: { properties: {}, type: "object" } },
				{ description: "дать задачу", name: "pose_problem", run: () => "ок", schema: { properties: {}, type: "object" } },
			],
			"practice",
		),
	);
	assert.deepEqual(practice, ["pose_problem"]);
});

test("вид сессии, которого нет, называется честно", () => {
	assert.throws(() => capabilitiesFor("exam" as "teach"), /неизвестный вид сессии exam/);
});
