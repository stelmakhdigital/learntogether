import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function tableNames(db: ReturnType<typeof openDb>): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
	return new Set(rows.map((row) => row.name));
}

test("first run applies every migration, second run applies nothing", () => {
	const db = openDb(":memory:");
	const expected = readdirSync(migrationsDir)
		.filter((file) => file.endsWith(".sql"))
		.sort();
	assert.deepEqual(migrate(db, migrationsDir), expected);
	assert.deepEqual(migrate(db, migrationsDir), []);
	db.close();
});

test("001_init.sql creates the core tables", () => {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const names = tableNames(db);
	assert.ok(names.has("session"));
	assert.ok(names.has("claim"));
	assert.ok(names.has("step_check"));
	db.close();
});

test("editing an applied file fails with its name", () => {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const dir = mkdtempSync(path.join(tmpdir(), "learntogether-migrate-"));
	const original = readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
	writeFileSync(path.join(dir, "001_init.sql"), `${original}\n-- tampered\n`);
	assert.throws(() => migrate(db, dir), /001_init\.sql/);
	db.close();
});
