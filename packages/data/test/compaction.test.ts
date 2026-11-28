// One active summary plus a watermark, and the watermark only moves forward.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { activeSummary, appendEntry, createSession, entries, foldTranscript, migrate, openDb } from "../src/index.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function startedSession() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "teach" }) };
}

test("a young session has no summary and no watermark", () => {
	const { db, sessionId } = startedSession();
	assert.equal(activeSummary(db, sessionId), null);
});

test("a fold stores the summary and everything above the watermark stays live", () => {
	const { db, sessionId } = startedSession();
	for (const text of ["шаг один", "шаг два", "шаг три"]) {
		appendEntry(db, { kind: "text", role: "teacher", sessionId, text });
	}
	const folded = foldTranscript(db, { sessionId, text: "объяснили первые два шага", throughOrdinal: 2 });

	assert.equal(folded.watermark, 2);
	assert.equal(folded.text, "объяснили первые два шага");
	assert.deepEqual(activeSummary(db, sessionId), {
		text: "объяснили первые два шага",
		updatedAt: folded.updatedAt,
		watermark: 2,
	});

	const live = db
		.prepare("SELECT ordinal, text FROM transcript_entry WHERE session_id = ? AND kind = 'text' AND ordinal > ? ORDER BY ordinal")
		.all(sessionId, 2) as { ordinal: number; text: string }[];
	assert.deepEqual(live.map((row) => row.text), ["шаг три"]);
});

test("folding again replaces the active summary and moves the watermark forward", () => {
	const { db, sessionId } = startedSession();
	for (let i = 0; i < 6; i += 1) {
		appendEntry(db, { kind: "text", role: "teacher", sessionId, text: `ход ${i}` });
	}
	foldTranscript(db, { sessionId, text: "первая сводка", throughOrdinal: 3 });
	foldTranscript(db, { sessionId, text: "вторая сводка", throughOrdinal: 5 });

	assert.equal(activeSummary(db, sessionId)?.text, "вторая сводка");
	assert.equal(activeSummary(db, sessionId)?.watermark, 5);
	// One active summary per session, not a stack of them.
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM compaction").get() as { n: number }).n, 1);
});

test("a watermark cannot move back and an empty fold is refused", () => {
	const { db, sessionId } = startedSession();
	appendEntry(db, { kind: "text", role: "teacher", sessionId, text: "что-то" });
	foldTranscript(db, { sessionId, text: "сводка", throughOrdinal: 1 });

	assert.throws(
		() => foldTranscript(db, { sessionId, text: "назад", throughOrdinal: 1 }),
		/watermark cannot move back/,
	);
	assert.throws(() => foldTranscript(db, { sessionId, text: "   ", throughOrdinal: 9 }), /empty fold/);
	assert.throws(() => foldTranscript(db, { sessionId, text: "нет ординала", throughOrdinal: 0 }), /positive ordinal/);
});

test("folding does not touch the transcript: history survives the summary", () => {
	const { db, sessionId } = startedSession();
	for (let i = 0; i < 5; i += 1) {
		appendEntry(db, { kind: "text", role: "learner", sessionId, text: `вопрос ${i}` });
	}
	foldTranscript(db, { sessionId, text: "переспросили про базовые определения", throughOrdinal: 4 });

	assert.equal(entries(db, sessionId).length, 5);
});
