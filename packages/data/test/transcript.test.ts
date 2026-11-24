import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createSession, closeSession, getSession, setSessionState } from "../src/repos/sessions.ts";
import { appendEntry, entries, searchEntries } from "../src/repos/transcript.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

test("ordinal runs 1,2,3 across alternating roles without gaps", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const first = appendEntry(db, { sessionId, kind: "text", role: "teacher", text: "a" });
	const second = appendEntry(db, { sessionId, kind: "text", role: "learner", text: "b" });
	const third = appendEntry(db, { sessionId, kind: "text", role: "teacher", text: "c" });
	assert.deepEqual(
		[first.ordinal, second.ordinal, third.ordinal],
		[1, 2, 3],
	);
	assert.ok(first.id !== second.id && second.id !== third.id, "ids must not repeat");
	db.close();
});

test("afterOrdinal skips earlier entries, limit caps the rest", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	for (const text of ["one", "two", "three", "four", "five"]) {
		appendEntry(db, { sessionId, kind: "text", role: "teacher", text });
	}
	const afterTwo = entries(db, sessionId, { afterOrdinal: 2 });
	assert.deepEqual(
		afterTwo.map((entry) => entry.ordinal),
		[3, 4, 5],
	);
	const limited = entries(db, sessionId, { afterOrdinal: 1, limit: 2 });
	assert.deepEqual(
		limited.map((entry) => entry.text),
		["two", "three"],
	);
	db.close();
});

test("searchEntries finds Russian text and does not leak other sessions", () => {
	const db = openedDb();
	const sessionA = createSession(db, { kind: "teach" });
	const sessionB = createSession(db, { kind: "practice" });
	appendEntry(db, { sessionId: sessionA, kind: "text", role: "teacher", text: "Фотосинтез превращает свет в сахар" });
	appendEntry(db, { sessionId: sessionB, kind: "text", role: "teacher", text: "Фотосинтез изучают в биологии" });
	appendEntry(db, { sessionId: sessionB, kind: "text", role: "learner", text: "Спасибо, понятно" });

	const all = searchEntries(db, "фотосинтез");
	assert.ok(all.some((hit) => hit.text.includes("Фотосинтез")), "search must find the Russian word");

	const onlyA = searchEntries(db, "фотосинтез", { sessionId: sessionA });
	assert.equal(onlyA.length, 1);
	assert.equal(onlyA[0]?.sessionId, sessionA);
	assert.equal(onlyA[0]?.ordinal, 1);
	assert.ok(!entries(db, sessionB).some((entry) => onlyA.some((hit) => hit.entryId === entry.id)));
	db.close();
});

test("appending to a nonexistent session throws", () => {
	const db = openedDb();
	assert.throws(
		() => appendEntry(db, { sessionId: "no-such-session", kind: "text", role: "teacher", text: "x" }),
		/FOREIGN KEY constraint failed/,
	);
	db.close();
});

test("thinking is stored alongside text", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach", modelTeacher: "local/qwen", modelProbe: null, contextLimit: 32768 });
	const { id } = appendEntry(db, {
		sessionId,
		kind: "thinking",
		role: "teacher",
		text: "ответ",
		thinking: "рассуждение",
	});
	const [entry] = entries(db, sessionId);
	assert.equal(entry?.id, id);
	assert.equal(entry?.text, "ответ");
	assert.equal(entry?.thinking, "рассуждение");
	const plain = appendEntry(db, { sessionId, kind: "text", role: "learner", text: "ясно" });
	const saved = entries(db, sessionId).find((row) => row.id === plain.id);
	assert.equal(saved?.thinking, null, "thinking stays NULL when not given");
	db.close();
});

test("session lifecycle: probing -> teaching -> closed", () => {
	const db = openedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const created = getSession(db, sessionId);
	assert.ok(created);
	assert.equal(created.state, "probing");
	assert.match(created.createdAt, /Z$/);
	assert.equal(created.closedAt, null);

	setSessionState(db, sessionId, "teaching");
	assert.equal(getSession(db, sessionId)?.state, "teaching");

	assert.throws(() => setSessionState(db, sessionId, "sleeping" as never), /probing, planning, teaching/);

	closeSession(db, sessionId);
	const closed = getSession(db, sessionId);
	assert.equal(closed?.state, "closed");
	assert.ok(closed?.closedAt);
	assert.equal(getSession(db, "no-such-session"), undefined);
	db.close();
});
