import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { addDoubt, openDoubts, resolveDoubt } from "../src/repos/doubts.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function insertClaim(db: ReturnType<typeof openDb>, text: string): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	// norm is part of the row: dedup of wording is folded outside SQL (migration 004).
	db.prepare("INSERT INTO claim (id, text, norm, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
		id,
		text,
		text.toLowerCase(),
		now,
		now,
	);
	return id;
}

test("an unknown doubt source is refused with the allowed list", () => {
	const db = openedDb();
	const claimId = insertClaim(db, "утверждение");
	assert.throws(
		() => addDoubt(db, { claimId, source: "vibes" as never }),
		/unknown doubt source "vibes"; allowed: check_failed, contradicted, missed_transfer, calibration/,
	);
	assert.equal(openDoubts(db).length, 0);
	db.close();
});

test("a doubt about a claim that does not exist is refused with the id", () => {
	const db = openedDb();
	const missing = "00000000-0000-4000-8000-000000000000";
	assert.throws(() => addDoubt(db, { claimId: missing, source: "check_failed" }), new RegExp(`claim not found: ${missing}`));
	assert.equal(openDoubts(db).length, 0);
	db.close();
});

test("the same (claim, source) twice gives one row and the same id", () => {
	const db = openedDb();
	const claimId = insertClaim(db, "утверждение");
	const first = addDoubt(db, { claimId, source: "check_failed", note: "проверка не пройдена" });
	const second = addDoubt(db, { claimId, source: "check_failed", note: "ещё раз та же проверка" });
	assert.equal(second, first);

	const open = openDoubts(db);
	assert.equal(open.length, 1);
	assert.equal(open[0]!.note, "проверка не пройдена", "the first note must survive the repeat");
	assert.equal(open[0]!.claimId, claimId);
	assert.deepEqual(openDoubts(db, claimId), open);
	db.close();
});

test("a different source on the same claim is a separate doubt", () => {
	const db = openedDb();
	const claimId = insertClaim(db, "утверждение");
	addDoubt(db, { claimId, source: "check_failed" });
	addDoubt(db, { claimId, source: "calibration" });
	assert.equal(openDoubts(db, claimId).length, 2);
	db.close();
});

test("openDoubts hides resolved doubts; resolving a closed id is refused", () => {
	const db = openedDb();
	const claimId = insertClaim(db, "утверждение");
	const settled = addDoubt(db, { claimId, source: "check_failed" });
	const pending = addDoubt(db, { claimId, source: "contradicted" });

	resolveDoubt(db, settled);
	assert.deepEqual(openDoubts(db).map((doubt) => doubt.id), [pending]);

	assert.throws(() => resolveDoubt(db, settled), new RegExp(`doubt ${settled} is already resolved`));
	const missing = "00000000-0000-4000-8000-000000000001";
	assert.throws(() => resolveDoubt(db, missing), new RegExp(`doubt ${missing} not found|doubt not found: ${missing}`));
	db.close();
});
