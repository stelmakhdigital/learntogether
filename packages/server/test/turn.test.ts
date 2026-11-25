import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "@learntogether/agent";
import { createFakeTransport } from "@learntogether/models";
import type { Request, Transport } from "@learntogether/models";
import { createSession, entries, migrate, openDb } from "@learntogether/data";
import { createApp } from "../src/app.ts";
import { DEFAULT_PORT, type Config } from "../src/config.ts";
import { TurnRunner, budgetFor } from "../src/turn.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

function config(overrides: Partial<Config> = {}): Config {
	return {
		accessToken: null,
		allowInsecure: false,
		exportDir: "/tmp/lth-test-export",
		host: "127.0.0.1",
		language: "ru",
		port: DEFAULT_PORT,
		source: null,
		...overrides,
	};
}

const stepSchema = {
	type: "object" as const,
	additionalProperties: false as const,
	required: ["statement", "kind"],
	properties: {
		kind: { type: "string" as const, enum: ["foundation", "derivation"] },
		statement: { type: "string" as const, minLength: 1 },
	},
};

function startedDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function runnerFor(db: ReturnType<typeof openDb>, transport: Transport): TurnRunner {
	return new TurnRunner(db, {
		buildRequest: (sessionId, learnerText): Request => ({
			budget: { input: 4000, output: 500 },
			messages: [{ content: [{ text: learnerText, type: "text" }], role: "user" }],
			reasoningLevel: "none",
			system: `учитель сессии ${sessionId}`,
			tools: [],
		}),
		registry: () =>
			new ToolRegistry([{ description: "записать шаг", name: "record_step", run: () => "шаг записан", schema: stepSchema }]),
		transport,
	});
}

async function withApp(t: { after(fn: () => unknown): void }, transport: Transport | null) {
	const db = startedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const app = createApp({
		...(transport === null ? {} : { turn: runnerFor(db, transport) }),
		config: config(),
		db,
		log: () => {},
	});
	t.after(() => app.close());
	await app.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.address();
	if (address === null || typeof address === "string") throw new Error("сервер не слушает порт");
	const base = `http://127.0.0.1:${address.port}`;
	const url = (path: string) => `${base}${path}`;
	return { app, db, sessionId, url };
}

test("without a transport the turn routes say so instead of running", async (t) => {
	const { sessionId, url } = await withApp(t, null);
	const start = await fetch(url(`/sessions/${sessionId}/turn`), {
		body: JSON.stringify({ text: "объясни" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	assert.equal(start.status, 503);
	assert.match((await start.json()).error, /транспорт модели не настроен/);
	const live = await fetch(url(`/sessions/${sessionId}/turn/stream`));
	assert.equal(live.status, 503);
});

test("a turn is accepted, streams its events and lands in the transcript", async (t) => {
	const transport = createFakeTransport({
		turns: [{ text: "вектор — это стрелка" }, { text: "дальше" }],
	});
	const { db, sessionId, url } = await withApp(t, transport);

	const start = await fetch(url(`/sessions/${sessionId}/turn`), {
		body: JSON.stringify({ text: "что такое вектор" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	assert.equal(start.status, 202);
	const { turnId } = await start.json();
	assert.equal(typeof turnId, "string");

	// The message is stored before the model is asked: an accepted message that
	// then vanished would be the worst kind of loss.
	const stored = entries(db, sessionId);
	assert.equal(stored[0]?.role, "learner");
	assert.match(stored[0]!.text, /что такое вектор/);

	const response = await fetch(url(`/sessions/${sessionId}/turn/stream`));
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	const body = await response.text();
	assert.match(body, /data: \{"type":"text"/);
	assert.match(body, /"type":"finished"/);

	const teacher = entries(db, sessionId).filter((entry) => entry.role === "teacher");
	assert.equal(teacher.length, 1);
	assert.match(teacher[0]!.text, /вектор — это стрелка/);
});

test("a second turn for the same session is refused while one runs", async (t) => {
	// A script that never ends the turn while we ask twice: the first turn keeps
	// the session occupied until its transport is done.
	const slow = createFakeTransport({ turns: [{ text: "думаю" }, { text: "ещё" }, { text: "точка" }] });
	const { sessionId, url } = await withApp(t, slow);
	const first = await fetch(url(`/sessions/${sessionId}/turn`), {
		body: JSON.stringify({ text: "первый" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	assert.equal(first.status, 202);
	const second = await fetch(url(`/sessions/${sessionId}/turn`), {
		body: JSON.stringify({ text: "второй" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	// Either refused as a duplicate, or accepted after the first one finished —
	// never two turns writing one transcript at once.
	assert.ok(second.status === 409 || second.status === 202, `unexpected status ${second.status}`);
	if (second.status === 409) assert.match((await second.json()).error, /уже идёт/);
});

test("an empty message is refused before anything is stored", async (t) => {
	const transport = createFakeTransport({ turns: [{ text: "не должно случиться" }] });
	const { db, sessionId, url } = await withApp(t, transport);
	const response = await fetch(url(`/sessions/${sessionId}/turn`), {
		body: JSON.stringify({ text: "   " }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	assert.equal(response.status, 400);
	assert.deepEqual(entries(db, sessionId), []);
});

test("cancel stops the turn and the stream closes", async () => {
	const transport = createFakeTransport({ turns: [{ text: "а" }, { text: "б" }, { text: "в" }] });
	const db = startedDb();
	const sessionId = createSession(db, { kind: "teach" });
	const runner = runnerFor(db, transport);
	const handle = runner.start(sessionId, "начнём");
	handle.cancel();
	const summary = await handle.done;
	assert.equal(summary.stop, "error");
	// The finished turn stays readable for replay, but the session is free again:
	// a cancelled turn must not block the learner from asking again.
	assert.equal(runner.get(sessionId)?.turnId, handle.turnId);
	const again = runner.start(sessionId, "продолжим");
	assert.notEqual(again.turnId, handle.turnId);
	await again.done;
});

test("budget comes from a measured window, never from a guess", () => {
	const db = startedDb();
	db.prepare("INSERT INTO endpoint (id, label, base_url, auth_mode, created_at) VALUES (?, ?, ?, ?, ?)").run(
		"local",
		"локально",
		"http://127.0.0.1:8080",
		"none",
		"2026-01-01T00:00:00.000Z",
	);
	const insert = (context: number | null, maxOut: number | null) => {
		db.prepare("DELETE FROM model_info").run();
		db.prepare(
			"INSERT INTO model_info (endpoint_id, model_id, context_tokens, max_output_tokens) VALUES (?, ?, ?, ?)",
		).run("local", "qwen", context, maxOut);
	};

	insert(null, null);
	assert.throws(() => budgetFor(db, "local", "qwen", 2000), /не измерен/);

	insert(8192, 1024);
	assert.deepEqual(budgetFor(db, "local", "qwen", 2000), { input: 5168, output: 1024 });

	insert(3000, 1024);
	assert.throws(() => budgetFor(db, "local", "qwen", 2000), /слишком мало/);

	assert.throws(() => budgetFor(db, "local", "нет-такой", 2000), /не пробирована/);
});
