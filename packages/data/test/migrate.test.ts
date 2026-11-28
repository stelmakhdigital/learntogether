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

test("007 rebuilds model_info without losing the probe it holds", () => {
	// A table rebuild is a data-loss risk, so it is tested against the state the
	// migration actually meets: a database that stops at 006 with a row inside.
	const before = mkdtempSync(path.join(tmpdir(), "lth-mig-"));
	for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name < "007")) {
		writeFileSync(path.join(before, file), readFileSync(path.join(migrationsDir, file)));
	}
	const db = openDb(":memory:");
	migrate(db, before);
	db.prepare("INSERT INTO endpoint (id, label, base_url, auth_mode, created_at) VALUES ('default', 'x', 'http://x', 'none', '2026-01-01')").run();
	db.prepare(
		"INSERT INTO model_info (endpoint_id, model_id, context_tokens, supports_tools, tokenizer_source, probe_method) VALUES ('default', 'qwen', 6144, 1, 'server', 'props+meta')",
	).run();

	migrate(db, migrationsDir);
	const row = db.prepare("SELECT context_tokens, tokenizer_source, probe_method FROM model_info WHERE model_id = 'qwen'").get() as
		{ context_tokens: number; tokenizer_source: string; probe_method: string } | undefined;
	assert.deepEqual(row, { context_tokens: 6144, probe_method: "props+meta", tokenizer_source: "server" });
	// The widened CHECK is the point of the rebuild.
	db.prepare("INSERT INTO model_info (endpoint_id, model_id, tokenizer_source) VALUES ('default', 'vllm', 'usage')").run();
	assert.deepEqual(db.prepare("SELECT tokenizer_source FROM model_info WHERE model_id = 'vllm'").get(), {
		tokenizer_source: "usage",
	});
	assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
	db.close();
});
