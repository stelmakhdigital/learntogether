import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createSession } from "../src/repos/sessions.ts";
import { createStep, presentStep, recordCheck, resolveCheck } from "../src/repos/steps.ts";
import { exportAll, renderGraph, renderSession } from "../src/export/export.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

/** A session with one accepted step, a claim in a chain, an open doubt and a
 *  failed tool call: enough of every exported shape to notice a broken render. */
function filledDb() {
	const db = freshDb();
	const sessionId = createSession(db, {
		kind: "teach",
		modelTeacher: "local/qwen",
		contextLimit: 16384,
	});
	db.prepare(
		"INSERT INTO goal (id, raw, statements_json, ready_when, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("g1", "понять, зачем нужны векторы", "[]", "объясняю своими словами", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
	db.prepare("UPDATE session SET goal_id = 'g1' WHERE id = ?").run(sessionId);
	db.prepare(
		"INSERT INTO endpoint (id, label, base_url, auth_mode, created_at) VALUES (?, ?, ?, ?, ?)",
	).run("local", "локально", "http://127.0.0.1:8080", "none", "2026-01-01T00:00:00.000Z");
	db.prepare(
		"INSERT INTO model_info (endpoint_id, model_id, context_tokens, probed_at, probe_method) VALUES (?, ?, ?, ?, ?)",
	).run("local", "qwen", 16384, "2026-01-01T00:00:00.000Z", "probing");

	const step = createStep(db, {
		sessionId,
		statement: "Вектор — это набор чисел",
		kind: "foundation",
		motivation: "без этого не объяснить близость смыслов",
	});
	presentStep(db, step.id);
	const checkId = recordCheck(db, {
		stepId: step.id,
		kind: "single_choice",
		question: "Сколько чисел у вектора?",
		options: [{ label: "а" }, { label: "б" }],
		answer: 0,
		why: "размерность выбирается заранее",
	});
	resolveCheck(db, checkId, { learnerAnswer: 0, verdict: "correct", confidence: 4 });

	db.prepare(
		"INSERT INTO claim (id, text, area, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("c2", "Близость считается косинусом", "математика", '["векторы"]', "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
	db.prepare(
		"INSERT INTO claim (id, text, area, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("c1", "Вектор — набор чисел", "математика", "[]", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
	db.prepare("INSERT INTO claim_alias (claim_id, text) VALUES (?, ?)").run("c1", "вектор это список");
	db.prepare("INSERT INTO chain (id, conclusion_claim_id, created_at) VALUES (?, ?, ?)").run(
		"ch1",
		"c2",
		"2026-01-02T00:00:00.000Z",
	);
	db.prepare("INSERT INTO chain_premise (chain_id, claim_id, ordinal) VALUES (?, ?, ?)").run("ch1", "c1", 0);
	db.prepare("INSERT INTO provenance (claim_id, session_id, step_id, note) VALUES (?, ?, ?, ?)").run(
		"c1",
		sessionId,
		step.id,
		"из шага 1",
	);
	db.prepare(
		"INSERT INTO doubt (id, claim_id, source, note, created_at) VALUES (?, ?, ?, ?, ?)",
	).run("d1", "c2", "check_failed", "перепутал косинус с евклидовым", "2026-01-03T00:00:00.000Z");
	db.prepare(
		"INSERT INTO repeat_item (id, claim_id, method, due_at, reps, lapses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("r1", "c1", "recall", "2026-01-10T00:00:00.000Z", 1, 0, "2026-01-03T00:00:00.000Z");
	db.prepare(
		"INSERT INTO tool_call (id, session_id, name, raw_args, state, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("t1", sessionId, "graph_search", '{"query":', "failed", "обрыв аргументов", "2026-01-03T00:00:00.000Z");

	return { db, sessionId };
}

function read(dir: string, relative: string): Buffer {
	return readFileSync(path.join(dir, relative));
}

function walk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const rel = prefix === "" ? entry : `${prefix}/${entry}`;
		if (statSync(full).isDirectory()) out.push(...walk(full, rel));
		else out.push(rel);
	}
	return out.sort();
}

test("rerunning the export leaves every file but INDEX.md untouched", () => {
	const { db } = filledDb();
	const dir = mkdtempSync(path.join(tmpdir(), "lth-export-"));
	const first = exportAll(db, dir, "2026-02-01T00:00:00.000Z");
	const before = new Map(first.map((file) => [file, read(dir, file)]));

	const second = exportAll(db, dir, "2026-02-02T00:00:00.000Z");
	assert.deepEqual(second, first);
	for (const file of second) {
		if (file === "INDEX.md") continue;
		assert.deepEqual(read(dir, file), before.get(file), `${file} changed between exports`);
	}
	assert.match(read(dir, "INDEX.md").toString("utf8"), /2026-02-02/);
	db.close();
});

test("session markdown carries the step, the check and the failed call", () => {
	const { db, sessionId } = filledDb();
	const md = renderSession(db, sessionId);
	assert.match(md, /^# понять, зачем нужны векторы$/m);
	assert.match(md, /- Модель учителя: local\/qwen/);
	assert.match(md, /- Контекст: 16384 \(измерено: 2026-01-01T00:00:00\.000Z\)/);
	assert.match(md, /## Шаг 1 — Вектор — это набор чисел/);
	assert.match(md, /> Проверка \(один вариант\): Сколько чисел у вектора\?/);
	assert.match(md, /> Ответ: 0 — correct, уверенность 4/);
	assert.match(md, /уверенность/);
	assert.match(md, /> Почему: размерность выбирается заранее/);
	assert.match(md, /## Ошибки вызовов\n\n- graph_search: обрыв аргументов/);
	db.close();
});

test("jsonl records keep keys alphabetical and one trailing newline", () => {
	const { db } = filledDb();
	const { claims, chains, doubts } = renderGraph(db);
	for (const text of [claims, chains, doubts]) {
		assert.ok(text.endsWith("\n"));
		assert.ok(!text.endsWith("\n\n"), "exactly one trailing newline");
		for (const line of text.trimEnd().split("\n")) {
			assert.ok(!line.includes("\n"));
			const record = JSON.parse(line) as Record<string, unknown>;
			const keys = Object.keys(record);
			assert.deepEqual(keys, [...keys].sort(), "keys are not alphabetical");
		}
	}
	const firstClaim = JSON.parse(claims.trimEnd().split("\n")[0]!) as Record<string, unknown>;
	assert.equal(firstClaim.id, "c1");
	assert.deepEqual(firstClaim.aliases, ["вектор это список"]);
	assert.equal((firstClaim.doubt as unknown[]).length, 0);
	assert.equal(claims.trimEnd().split("\n").length, 2);
	db.close();
});

test("an empty database exports empty jsonl and says so in the index", () => {
	const db = freshDb();
	const dir = mkdtempSync(path.join(tmpdir(), "lth-export-empty-"));
	const written = exportAll(db, dir, "2026-02-01T00:00:00.000Z");
	assert.deepEqual(written.sort(), [
		"INDEX.md",
		"graph/chains.jsonl",
		"graph/claims.jsonl",
		"graph/doubts.jsonl",
		"practice/queue.md",
	]);
	assert.equal(statSync(path.join(dir, "graph/claims.jsonl")).size, 0);
	assert.equal(statSync(path.join(dir, "graph/chains.jsonl")).size, 0);
	assert.equal(statSync(path.join(dir, "graph/doubts.jsonl")).size, 0);
	const index = read(dir, "INDEX.md").toString("utf8");
	assert.match(index, /Сессий нет\./);
	assert.match(index, /утверждений 0/);
	assert.match(index, /Экспорт/);
	assert.match(read(dir, "practice/queue.md").toString("utf8"), /Очереди повторов нет\./);
	db.close();
});

test("the queue lists what is due before what has no date", () => {
	const { db } = filledDb();
	const dir = mkdtempSync(path.join(tmpdir(), "lth-export-queue-"));
	exportAll(db, dir, "2026-02-01T00:00:00.000Z");
	db.prepare(
		"INSERT INTO repeat_item (id, claim_id, method, due_at, reps, lapses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("r2", "c2", "transfer", null, 0, 0, "2026-01-04T00:00:00.000Z");
	exportAll(db, dir, "2026-02-02T00:00:00.000Z");
	const queue = read(dir, "practice/queue.md").toString("utf8");
	assert.ok(queue.indexOf("2026-01-10") < queue.indexOf("срок не назначен"), "undated item printed first");
	db.close();
});

test("no temp file survives the export", () => {
	const { db } = filledDb();
	const dir = mkdtempSync(path.join(tmpdir(), "lth-export-tmp-"));
	exportAll(db, dir, "2026-02-01T00:00:00.000Z");
	const leftovers = walk(dir).filter((file) => file.endsWith(".tmp"));
	assert.deepEqual(leftovers, []);
	db.close();
});
