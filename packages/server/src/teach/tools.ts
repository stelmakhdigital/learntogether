// Every tool the learner's teacher gets: the tools that state the probe and the
// goal (lesson.ts), the tools that read the graph the earlier lessons left behind
// (graph.ts), and the tools that move a step (steps.ts). One place lists them so a
// registry can never drift from what the composition root hands the model.

import type Database from "better-sqlite3";
import type { ToolPort } from "@learntogether/agent";
import { createGraphTools } from "./graph.ts";
import { createLessonTools } from "./lesson.ts";
import { createStepTools } from "./steps.ts";

export function createTeachTools(db: Database.Database, sessionId: string): ToolPort[] {
	return [...createLessonTools(db, sessionId), ...createGraphTools(db, sessionId), ...createStepTools(db, sessionId)];
}
