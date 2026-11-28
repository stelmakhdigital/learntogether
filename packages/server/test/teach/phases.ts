// A session with the method's phases behind it. record_step refuses a step before
// the probe, the goal and the plan (teach/steps.ts), so step-level tests start from
// a lesson that has them instead of rewriting the phase calls in every fixture.

import type Database from "better-sqlite3";
import { createSession, setPlan, setSessionGoal, upsertProbe } from "@learntogether/data";

export function teachSession(db: Database.Database, label = "держать материал"): string {
	const sessionId = createSession(db, { kind: "teach" });
	upsertProbe(db, { confidence: 4, sessionId, state: "frontier", statement: `${label}: база` });
	setSessionGoal(db, { raw: label, readyWhen: "ученик сам формулирует", sessionId, statements: [label] });
	setPlan(db, { nodes: [{ label, nodeId: "n1", whyNeeded: "первая ступень" }], sessionId });
	return sessionId;
}
