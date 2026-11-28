import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendEntry,
	closeSession,
	createSession,
	createStep,
	migrate,
	openDb,
	presentStep,
	recordCheck,
	resolveCheck,
} from "@learntogether/data";
import { openReadonly } from "../src/read.ts";
import { queue, run, search, session, sessions } from "../src/cli.ts";

const migrationsDir = fileURLToPath(new URL("../../../packages/data/migrations", import.meta.url));

function filledFile(): string {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "lth-cli-")), "learntogether.db");
	const db = openDb(file);
	migrate(db, migrationsDir);
	const sessionId = createSession(db, { kind: "teach", modelTeacher: "local/qwen", contextLimit: 8192 });
	const step = createStep(db, { sessionId, statement: "Вектор — набор чисел", kind: "foundation" });
	presentStep(db, step.id);
	const checkId = recordCheck(db, {
		stepId: step.id,
		kind: "free_recall",
		question: "Что такое вектор?",
		answer: "набор чисел",
	});
	resolveCheck(db, checkId, { confidence: 4, learnerAnswer: "набор чисел", verdict: "correct" });
	appendEntry(db, { kind: "text", role: "teacher", sessionId, text: "вектор — это стрелка с длиной" });
	// The accepted step installed its wording in the graph and put a recall item on
	// it; the fixture only decorates what the lesson made.
	const claimId = db.prepare("SELECT id FROM claim WHERE norm = ?").get("вектор — набор чисел") as { id: string };
	db.prepare("UPDATE claim SET area = 'математика', tags_json = '[]' WHERE id = ?").run(claimId.id);
	db.prepare("UPDATE repeat_item SET id = 'r1', due_at = ?, reps = 1, created_at = ? WHERE claim_id = ?").run(
		"2026-01-10T00:00:00.000Z",
		"2026-01-02T00:00:00.000Z",
		claimId.id,
	);
	closeSession(db, sessionId);
	db.close();
	return file;
}

test("the same connection refuses to write", () => {
	const file = filledFile();
	const db = openReadonly(file);
	assert.throws(() => db.prepare("UPDATE session SET state = 'failed' WHERE id IS NOT NULL").run(), /readonly/i);
	assert.throws(
		() =>
			db
				.prepare("INSERT INTO claim (id, text, norm, created_at, updated_at) VALUES ('x','y','x-norm','a','b')")
				.run(),
		/readonly/i,
	);
	db.close();
});

test("a missing file is an error, not an empty database", () => {
	assert.throws(() => openReadonly(path.join(tmpdir(), "definitely-not-here-42.db")), /unable to open database file/i);
	assert.throws(() => openReadonly(":memory:"), /writable/);
});

test("sessions and session print what the store holds", () => {
	const file = filledFile();
	const db = openReadonly(file);
	const list = sessions(db);
	assert.match(list, /teach/);
	assert.match(list, /закрыт|closed/);
	assert.match(list, /шагов 1/);

	const text = session(db, list.match(/[0-9a-f-]{36}/)![0]);
	assert.match(text, /Шаг 1 \[accepted\] Вектор — набор чисел/);
	assert.match(text, /проверка \(free_recall\) Что такое вектор\? → "набор чисел", correct/);
	assert.match(session(db, "нет-такой"), /Сессия не найдена/);
	db.close();
});

test("search hits the full-text index and the queue lists what is due", () => {
	const file = filledFile();
	const db = openReadonly(file);
	const hits = search(db, "вектор");
	assert.match(hits, /стрелка с длиной/);
	assert.match(search(db, "шило на мыло"), /Совпадений нет/);
	assert.match(queue(db), /2026-01-10T00:00:00\.000Z\s+recall\s+повторов 1\s+срывов 0\s+Вектор — набор чисел/);
	db.close();
});

test("an unknown command and a missing argument are named, not guessed", () => {
	const file = filledFile();
	assert.match(run(file, ["help"]), /только для чтения/);
	assert.throws(() => run(file, ["droop"]), /неизвестная команда "droop"/);
	assert.throws(() => run(file, ["session"]), /нужен идентификатор/);
	assert.throws(() => run(file, ["search"]), /нужен текст запроса/);
});
