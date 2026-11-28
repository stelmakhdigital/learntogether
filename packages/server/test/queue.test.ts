// Практика через HTTP: очередь, оценка, честные отказы. Числа планировщика здесь не
// проверяются — они проверяются об эталон в packages/domain/test/scheduler.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
	createRepeatItem,
	createSession,
	createStep,
	migrate,
	openDb,
	presentStep,
	recordCheck,
	resolveCheck,
	upsertClaim,
} from "@learntogether/data";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const config: Config = {
	accessToken: null,
	allowInsecure: false,
	exportDir: "/tmp/lth-queue-export",
	host: "127.0.0.1",
	language: "ru",
	model: null,
	port: 0,
	source: null,
};

async function serve(): Promise<{ base: string; close: () => Promise<void>; db: ReturnType<typeof openDb> }> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const app = createApp({ config, db, log: () => undefined });
	await app.listen({ host: "127.0.0.1", port: 0 });
	const { port } = app.server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, close: () => app.close(), db };
}

type Json = Record<string, unknown> & { items?: Record<string, unknown>[]; error?: string };

async function get(base: string, path: string): Promise<{ body: Json; status: number }> {
	const response = await fetch(base + path);
	return { body: (await response.json()) as Json, status: response.status };
}

async function post(base: string, path: string, payload: unknown): Promise<{ body: Json; status: number }> {
	const response = await fetch(base + path, {
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	return { body: (await response.json()) as Json, status: response.status };
}

test("принятый шаг сам встаёт в практику как элемент припоминания", async () => {
	const { base, close, db } = await serve();
	try {
		const sessionId = createSession(db, { kind: "teach" });
		const step = createStep(db, { kind: "foundation", sessionId, statement: "Вектор — это набор чисел" });
		presentStep(db, step.id);
		const checkId = recordCheck(db, { answer: "набор", kind: "free_recall", question: "что такое вектор?", stepId: step.id });
		resolveCheck(db, checkId, { confidence: 4, learnerAnswer: "набор", verdict: "correct" });

		const queue = await get(base, "/queue?at=2026-01-01T09:00:00.000Z");
		assert.equal(queue.status, 200);
		assert.deepEqual(
			(queue.body.items ?? []).map((item) => [item.claimText, item.method, item.hasDoubt]),
			[["Вектор — это набор чисел", "recall", false]],
		);
		assert.equal(queue.body.items?.[0]?.dueAt, null, "новый элемент ещё не имеет срока");
	} finally {
		await close();
	}
});

test("очередь и оценка: срок уходит в элемент, попытка остаётся", async () => {
	const { base, close, db } = await serve();
	try {
		const claimId = upsertClaim(db, { text: "Цепное правило" }).id;
		const itemId = createRepeatItem(db, { claimId, method: "reasoning" });

		const before = await get(base, "/queue?at=2026-01-01T09:00:00.000Z&limit=3");
		assert.equal(before.status, 200);
		assert.equal(before.body.items?.[0]?.itemId, itemId);

		const reviewed = await post(base, `/repeats/${itemId}/review`, { rating: "good" });
		assert.equal(reviewed.status, 200);
		assert.equal(reviewed.body.state, "review");
		assert.ok((reviewed.body.intervalDays as number) >= 1);
		assert.equal(reviewed.body.minutes, null);

		const item = db.prepare("SELECT reps, due_at FROM repeat_item WHERE id = ?").get(itemId) as {
			due_at: string | null;
			reps: number;
		};
		assert.equal(item.reps, 1);
		assert.ok(item.due_at !== null);

		const again = await post(base, `/repeats/${itemId}/review`, { rating: "again" });
		assert.equal(again.body.minutes, 10);
		assert.equal(again.body.state, "learning");
		assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM attempt").get(), { n: 2 });
	} finally {
		await close();
	}
});

test("плохой запрос называется, а не молча игнорируется", async () => {
	const { base, close, db } = await serve();
	try {
		const claimId = upsertClaim(db, { text: "Ряд Тейлора" }).id;
		const itemId = createRepeatItem(db, { claimId, method: "recall" });

		assert.equal((await get(base, "/queue?at=вчера")).status, 400);
		assert.equal((await get(base, "/queue?limit=0")).status, 400);
		assert.equal((await post(base, `/repeats/${itemId}/review`, { rating: "почти" })).status, 400);
		const missing = await post(base, "/repeats/нет-такого/review", { rating: "good" });
		assert.equal(missing.status, 404);
		assert.match(missing.body.error ?? "", /элемента практики нет-такого нет/);
	} finally {
		await close();
	}
});
