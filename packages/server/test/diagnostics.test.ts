import test from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb } from "@learntogether/data";
import { createSession } from "@learntogether/data";
import { fileURLToPath } from "node:url";
import { Diagnostics, EventWriter, Ring } from "../src/diagnostics.ts";
import type { EventLevel } from "../src/diagnostics.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

function freshDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

test("the ring keeps the newest records and hands them back oldest first", () => {
	const ring = new Ring(3);
	const levels: EventLevel[] = ["info", "warning", "error", "info"];
	for (const [index, level] of levels.entries()) {
		ring.push({ at: `2026-01-0${index + 1}T00:00:00.000Z`, level, kind: `k${index}`, message: `m${index}`, sessionId: null });
	}
	assert.equal(ring.size, 3);
	const kept = ring.toArray();
	assert.deepEqual(kept.map((item) => item.message), ["m1", "m2", "m3"]);
	assert.equal(kept[0]?.at, "2026-01-02T00:00:00.000Z");
});

test("a zero-capacity ring is a configuration error, not an empty buffer", () => {
	assert.throws(() => new Ring(0), /positive/);
});

test("diagnostics land in the event table and stay readable", () => {
	const db = freshDb();
	const sessionId = createSession(db, { kind: "teach" });
	const diag = new Diagnostics({ db });
	diag.info("session_started", "сессия начата", sessionId);
	diag.error("probe_failed", "сервер не вернул размер контекста");

	const rows = db.prepare("SELECT kind, payload_json, session_id FROM event ORDER BY id").all() as Record<
		string,
		unknown
	>[];
	assert.equal(rows.length, 2);
	assert.equal(rows[0]?.kind, "session_started");
	assert.equal(rows[0]?.session_id, sessionId);
	assert.deepEqual(JSON.parse(String(rows[1]?.payload_json)), {
		level: "error",
		message: "сервер не вернул размер контекста",
	});

	const stored = new EventWriter(db).recent(10);
	assert.deepEqual(stored.map((row) => row.kind), ["probe_failed", "session_started"]);
	assert.equal(stored[1]?.sessionId, sessionId);
	assert.deepEqual(new EventWriter(db).recent(10, "error").map((row) => row.kind), ["probe_failed"]);
	db.close();
});

test("a huge message is clipped, not stored whole", () => {
	const db = freshDb();
	const diag = new Diagnostics({ db, capacity: 2 });
	diag.warning("huge", "x".repeat(5000));
	const row = db.prepare("SELECT payload_json FROM event").get() as { payload_json: string };
	assert.ok(row.payload_json.length < 600, `payload grew to ${row.payload_json.length}`);
	assert.match(diag.recent()[0]!.message, /^…x+$/);
	db.close();
});

test("prune removes only what is older than the given moment", () => {
	const db = freshDb();
	const writer = new EventWriter(db);
	writer.write({ at: "2026-01-01T00:00:00.000Z", level: "info", kind: "old", message: "old", sessionId: null });
	writer.write({ at: "2026-06-01T00:00:00.000Z", level: "info", kind: "new", message: "new", sessionId: null });
	assert.equal(writer.pruneOlderThan("2026-03-01T00:00:00.000Z"), 1);
	assert.deepEqual(writer.recent(10).map((row) => row.kind), ["new"]);
	db.close();
});

test("without a database the ring still records", () => {
	const diag = new Diagnostics({ capacity: 10 });
	diag.info("offline", "работаем без базы");
	assert.deepEqual(diag.recent().map((row) => row.kind), ["offline"]);
});
