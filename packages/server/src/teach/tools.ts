// Which tools a session gets, and why. The choice used to be an `if` over the session
// kind; now it is a table of capabilities (D-080), because the four places where the
// method is extended are exactly four capabilities: a question type asks a check, a
// problem type poses a task, a view reads the graph, a source of practice decides what
// is due. Something added later — a plugin's own question type — asks for its
// capability by name and is refused without it.
//
// A tool that does not declare a capability is a mistake, not a free pass: the
// composition fails with its name rather than exposing it to a session that never
// asked for it.

import type Database from "better-sqlite3";
import type { SessionKind } from "@learntogether/data";
import type { ToolPort } from "@learntogether/agent";
import { createGraphTools } from "./graph.ts";
import { createLessonTools } from "./lesson.ts";
import { createPracticeTools } from "./practice.ts";
import { createStepTools } from "./steps.ts";

export const CAPABILITIES = [
	"graph:read",
	"goal:write",
	"plan:write",
	"problem:pose",
	"probe:write",
	"question:pose",
	"step:write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Where each tool belongs. Read this as the list of extension points: everything a
 *  newcomer can plug in is a name in this table. */
const TOOL_CAPABILITY: Record<string, Capability> = {
	check_understanding: "question:pose",
	goal_state: "goal:write",
	graph_read: "graph:read",
	graph_search: "graph:read",
	plan_set: "plan:write",
	pose_problem: "problem:pose",
	probe_record: "probe:write",
	problem_outcome: "problem:pose",
	present_step: "step:write",
	record_step: "step:write",
	update_step: "step:write",
};

/** What a lesson and a practice session are allowed to do. A practice session is not a
 *  crippled lesson: it has no phases to run and no step to install, and sending those
 *  schemas costs the small-window models the room they need (live 2026-11-28: 3711
 *  tokens of request against a 3584 budget on the first turn). */
const GRANTS: Record<SessionKind, readonly Capability[]> = {
	practice: ["graph:read", "problem:pose"],
	teach: ["graph:read", "probe:write", "goal:write", "plan:write", "step:write", "question:pose"],
};

export function capabilitiesFor(kind: SessionKind): readonly Capability[] {
	const granted = GRANTS[kind];
	if (granted === undefined) throw new Error(`неизвестный вид сессии ${kind}; есть ${Object.keys(GRANTS).join(", ")}`);
	return granted;
}

function sessionKind(db: Database.Database, sessionId: string): SessionKind {
	const row = db.prepare("SELECT kind FROM session WHERE id = ?").get(sessionId) as { kind: SessionKind } | undefined;
	if (row === undefined) throw new Error(`сессии ${sessionId} нет`);
	return row.kind;
}

/** Everything the tool families know how to do. */
function allTools(db: Database.Database, sessionId: string): ToolPort[] {
	return [
		...createLessonTools(db, sessionId),
		...createGraphTools(db, sessionId),
		...createStepTools(db, sessionId),
		...createPracticeTools(db, sessionId),
	];
}

/** The gate itself, separate from the database so a test can hand it a tool that
 *  forgot its capability and check that it does not get through. */
export function selectTools(tools: ToolPort[], kind: SessionKind): ToolPort[] {
	const granted = new Set(capabilitiesFor(kind));
	const undeclared = tools.filter((tool) => TOOL_CAPABILITY[tool.name] === undefined).map((tool) => tool.name);
	if (undeclared.length > 0) {
		throw new Error(`инструменты без возможности: ${undeclared.join(", ")} — назовите её в таблице`);
	}
	return tools.filter((tool) => granted.has(TOOL_CAPABILITY[tool.name]!));
}

export function createTeachTools(db: Database.Database, sessionId: string): ToolPort[] {
	return selectTools(allTools(db, sessionId), sessionKind(db, sessionId));
}
