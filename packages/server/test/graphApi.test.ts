// The graph over HTTP: browse without a query, search by wording, read one node,
// and refuse what cannot be answered.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { addChain, addDoubt, migrate, openDb, upsertClaim } from "@learntogether/data";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const config: Config = {
	accessToken: null,
	allowInsecure: false,
	exportDir: "/tmp/lth-graph-export",
	host: "127.0.0.1",
	language: "ru",
	model: null,
	port: 0,
	source: null,
};

type Db = ReturnType<typeof openDb>;

/** A test that throws must not leave a listener holding the event loop open. */
async function withServer(run: (ctx: { base: string; db: Db }) => Promise<void>): Promise<void> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const app = createApp({ config, db, log: () => undefined });
	await app.listen({ host: "127.0.0.1", port: 0 });
	const { port } = app.server.address() as AddressInfo;
	try {
		await run({ base: `http://127.0.0.1:${port}`, db });
	} finally {
		await app.close();
		db.close();
	}
}

async function json(url: string): Promise<{ body: Record<string, unknown>; status: number }> {
	const response = await fetch(url);
	return { body: (await response.json()) as Record<string, unknown>, status: response.status };
}

test("the library opens without a query and lists nodes newest first", async () => {
	await withServer(async ({ base, db }) => {
		const first = upsertClaim(db, { text: "Сложение не зависит от порядка" });
		const second = upsertClaim(db, { text: "Скобки меняют порядок вычисления" });

		const page = await json(`${base}/graph?limit=1`);
		assert.equal(page.status, 200);
		assert.equal(page.body.total, 2);
		// Newest first: whatever was written last is the first page.
		assert.deepEqual((page.body.claims as { id: string }[]).map((claim) => claim.id), [second.id]);
		assert.equal(page.body.query, "");

		const next = await json(`${base}/graph?limit=1&offset=1`);
		assert.deepEqual((next.body.claims as { id: string }[]).map((claim) => claim.id), [first.id]);
	});
});

test("a search by wording returns hits and no browse list", async () => {
	await withServer(async ({ base, db }) => {
		const claim = upsertClaim(db, { text: "Скобки меняют порядок вычисления" });
		upsertClaim(db, { text: "Скорость — это путь, делённый на время" });

		const found = await json(`${base}/graph?q=скобки`);
		assert.equal(found.status, 200);
		assert.deepEqual((found.body.hits as { id: string }[]).map((hit) => hit.id), [claim.id]);
		assert.deepEqual(found.body.claims, []);

		// Words are quoted before they reach FTS5, so punctuation cannot break the
		// index expression and take the library down with it.
		const symbols = await json(`${base}/graph?q=скобки%20AND%20(`);
		assert.equal(symbols.status, 200);
	});
});

test("reading a node carries its chains and doubts; a missing node is 404", async () => {
	await withServer(async ({ base, db }) => {
		const premise = upsertClaim(db, { text: "Наклон секущей считается по двум точкам" });
		const conclusion = upsertClaim(db, { text: "Производная — предел наклона секущей" });
		const chain = addChain(db, { conclusionId: conclusion.id, premiseIds: [premise.id] });
		addDoubt(db, { claimId: conclusion.id, note: "предел понятен формально", source: "check_failed" });

		const reading = await json(`${base}/graph/${conclusion.id}`);
		assert.equal(reading.status, 200);
		assert.deepEqual((reading.body.chains as { id: string }[]).map((row) => row.id), [chain.id]);
		assert.deepEqual((reading.body.usedIn as { id: string }[]).map((row) => row.id), []);
		assert.deepEqual((reading.body.openDoubts as { note: string | null }[]).map((doubt) => doubt.note), [
			"предел понятен формально",
		]);

		const missing = await json(`${base}/graph/net-takogo-uzla`);
		assert.equal(missing.status, 404);
		assert.match(String(missing.body.error), /узла net-takogo-uzla нет/);
	});
});

test("limit is checked before it reaches SQLite", async () => {
	await withServer(async ({ base }) => {
		const over = await json(`${base}/graph?limit=501`);
		assert.equal(over.status, 400);
		assert.match(String(over.body.error), /limit должен быть целым числом от 0 до 500/);
		assert.equal((await json(`${base}/graph?limit=abc`)).status, 400);
	});
});
