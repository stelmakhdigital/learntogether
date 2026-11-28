// Side questions over HTTP: what the window calls, what it gets back, and what it is
// refused when there is no model to answer with.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { appendEntry, createSession, migrate, openDb } from "@learntogether/data";
import { createFakeTransport } from "@learntogether/models";
import { createApp } from "../src/app.ts";
import { createSideService } from "../src/teach/side.ts";
import type { Config } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const config: Config = {
	accessToken: null,
	allowInsecure: false,
	exportDir: "/tmp/lth-side-export",
	host: "127.0.0.1",
	language: "ru",
	model: null,
	port: 0,
	source: null,
	uiDir: null,
};

async function withSide(answers: string[]): Promise<{ base: string; close: () => Promise<void>; sessionId: string }> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const sessionId = createSession(db, { kind: "teach" });
	appendEntry(db, { kind: "text", role: "teacher", sessionId, text: "смотри на график" });

	const app = createApp({
		config,
		db,
		log: () => undefined,
		side: createSideService({ budget: () => ({ input: 4000, output: 900 }), db, transport: createFakeTransport({ turns: answers.map((text) => ({ text })) }) }),
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	const { port } = app.server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, close: async () => { await app.close(); db.close(); }, sessionId };
}

test("сторона отвечает и остаётся в списке нитей", async () => {
	const { base, close, sessionId } = await withSide(["наклон кривой в точке", "и там же предел отношения"]);
	try {
		const asked = await fetch(`${base}/sessions/${sessionId}/side`, {
			body: JSON.stringify({ question: "что такое производная" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		assert.equal(asked.status, 200);
		const first = (await asked.json()) as { answer: string; threadId: string };
		assert.equal(first.answer, "наклон кривой в точке");

		const again = await fetch(`${base}/sessions/${sessionId}/side`, {
			body: JSON.stringify({ question: "а касательная?", threadId: first.threadId }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		assert.equal(again.status, 200);
		assert.equal(((await again.json()) as { threadId: string }).threadId, first.threadId);

		const list = await (await fetch(`${base}/sessions/${sessionId}/side`)).json();
		const threads = (list as { threads: { messages: unknown[] }[] }).threads;
		assert.equal(threads.length, 1);
		assert.equal(threads[0]!.messages.length, 4);
	} finally {
		await close();
	}
});

test("сторона отказывает честно: нет вопроса — 400, нет модели — 503, нет сессии — 404", async () => {
	const { base, close, sessionId } = await withSide(["не должно пригодиться"]);
	try {
		const empty = await fetch(`${base}/sessions/${sessionId}/side`, {
			body: JSON.stringify({ question: "  " }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		assert.equal(empty.status, 400);
		assert.match((await empty.json()).error, /нужен вопрос/);

		const missing = await fetch(`${base}/sessions/${crypto.randomUUID()}/side`);
		assert.equal(missing.status, 404);
	} finally {
		await close();
	}

	const noModel = openDb(":memory:");
	migrate(noModel, migrationsDir);
	const app = createApp({ config, db: noModel, log: () => undefined });
	await app.listen({ host: "127.0.0.1", port: 0 });
	const { port } = app.server.address() as AddressInfo;
	try {
		const refused = await fetch(`http://127.0.0.1:${port}/sessions/anything/side`);
		assert.equal(refused.status, 503);
		assert.match((await refused.json()).error, /транспорт модели не настроен/);
	} finally {
		await app.close();
		noModel.close();
	}
});
