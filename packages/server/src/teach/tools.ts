// The tools a session gets, chosen by what the session is. One place lists them so
// a registry cannot drift from what the composition root hands the model — and so a
// practice session does not pay for the phase tools of a lesson: a measured 6144-token
// window had no room left once both families were sent everywhere (live check
// 2026-11-28: 3711 tokens of request against a 3584 budget, on the first turn).

import type Database from "better-sqlite3";
import type { SessionKind } from "@learntogether/data";
import type { ToolPort } from "@learntogether/agent";
import { createGraphTools } from "./graph.ts";
import { createLessonTools } from "./lesson.ts";
import { createPracticeTools } from "./practice.ts";
import { createStepTools } from "./steps.ts";

function sessionKind(db: Database.Database, sessionId: string): SessionKind {
	const row = db.prepare("SELECT kind FROM session WHERE id = ?").get(sessionId) as { kind: SessionKind } | undefined;
	if (row === undefined) throw new Error(`сессии ${sessionId} нет`);
	return row.kind;
}

export function createTeachTools(db: Database.Database, sessionId: string): ToolPort[] {
	const kind = sessionKind(db, sessionId);
	const graph = createGraphTools(db, sessionId);
	if (kind === "practice") return [...graph, ...createPracticeTools(db, sessionId)];
	return [...createLessonTools(db, sessionId), ...graph, ...createStepTools(db, sessionId)];
}
