import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createSession } from "../src/repos/sessions.ts";
import { probesForSession, resolveProbe, upsertProbe } from "../src/repos/probes.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

const STATEMENT = "вода кипит при 100 градусах на уровне моря";

test("a repeated upsert of the same statement updates the row instead of doubling it", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const first = upsertProbe(db, { sessionId, statement: STATEMENT, state: "frontier", confidence: 3 });
	const second = upsertProbe(db, { sessionId, statement: STATEMENT, state: "held", confidence: 5 });
	assert.equal(second, first, "the same statement must keep its id");

	const probes = probesForSession(db, sessionId);
	assert.equal(probes.length, 1);
	assert.equal(probes[0]!.state, "held");
	assert.equal(probes[0]!.confidence, 5);
	db.close();
});

test("an unknown probe state is refused with the allowed list", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	assert.throws(
		() => upsertProbe(db, { sessionId, statement: STATEMENT, state: "almost" as never }),
		/unknown probe state "almost"; allowed: held, frontier, absent, contradicted/,
	);
	assert.equal(probesForSession(db, sessionId).length, 0);
	db.close();
});

test("probesForSession does not mix sessions", () => {
	const db = openedDb();
	const mine = createSession(db, { kind: "teach" });
	const theirs = createSession(db, { kind: "teach" });
	upsertProbe(db, { sessionId: mine, statement: STATEMENT, state: "frontier" });
	upsertProbe(db, { sessionId: theirs, statement: "чужое утверждение", state: "held" });
	upsertProbe(db, { sessionId: theirs, statement: STATEMENT, state: "absent" });

	const own = probesForSession(db, mine);
	assert.deepEqual(own.map((probe) => probe.statement), [STATEMENT]);
	assert.deepEqual(own.map((probe) => probe.sessionId), [mine]);
	assert.equal(probesForSession(db, theirs).length, 2);
	db.close();
});

test("resolveProbe on a wording that was never probed is refused", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	assert.throws(
		() => resolveProbe(db, sessionId, "про такое мы не спрашивали", { state: "held" }),
		/no probe was recorded for statement "про такое мы не спрашивали"/,
	);
	db.close();
});

test("resolveProbe to contradicted returns contradicted and stores it", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	upsertProbe(db, { sessionId, statement: STATEMENT, state: "frontier", confidence: 4 });
	const result = resolveProbe(db, sessionId, STATEMENT, { state: "contradicted", confidence: 2 });
	assert.deepEqual(result, { probeState: "contradicted" });
	const [probe] = probesForSession(db, sessionId);
	assert.equal(probe?.state, "contradicted");
	assert.equal(probe?.confidence, 2);
	db.close();
});

test("a contradicted outcome without wrong reasoning stays a gap", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	upsertProbe(db, { sessionId, statement: STATEMENT, state: "frontier" });
	const result = resolveProbe(db, sessionId, STATEMENT, { state: "contradicted", wrongReasoning: false });
	assert.deepEqual(result, { probeState: "absent" });
	db.close();
});
