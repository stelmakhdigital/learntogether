import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { appendEntry, closeSession, createSession, migrate, openDb } from "@learntogether/data";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const rejections: string[] = [];
process.on("unhandledRejection", (reason) => rejections.push(String(reason)));

function makeDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		host: "127.0.0.1",
		port: 0,
		allowInsecure: false,
		language: "ru",
		accessToken: null,
		source: null,
		uiDir: null,
		model: null,
		exportDir: path.join(tmpdir(), "learntogether-unused"),
		...overrides,
	};
}

/** App on an ephemeral port, closed after the test body. */
async function serve(config: Config): Promise<{ base: string; app: FastifyInstance; db: ReturnType<typeof makeDb> }> {
	const db = makeDb();
	const app = createApp({ db, config, log: () => undefined });
	await app.listen({ host: "127.0.0.1", port: 0 });
	const info = app.server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${info.port}`, app, db };
}

async function closeAll(...apps: FastifyInstance[]): Promise<void> {
	await Promise.all(apps.map((app) => app.close()));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutHandles(): number {
	return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

/** Reads an SSE feed until `stopAfter` appears, then aborts the connection. */
function readSse(url: string, stopAfter: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const failFast = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const req = http.get(url, { headers: { accept: "text/event-stream" } }, (res) => {
			let raw = "";
			const timer = setTimeout(() => {
				req.destroy();
				failFast(new Error(`ожидание SSE истекло, получено: ${JSON.stringify(raw)}`));
			}, 3000);
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				raw += chunk;
				if (raw.includes(stopAfter)) {
					clearTimeout(timer);
					settled = true;
					res.destroy();
					resolve({ status: res.statusCode ?? 0, headers: res.headers, raw });
				}
			});
			res.on("error", failFast);
		});
		req.on("error", failFast);
	});
}

test("healthz answers without a token, other routes demand one", async () => {
	const token = "tok-check-42";
	const { base, app, db } = await serve(makeConfig({ accessToken: token }));
	try {
		const health = await fetch(`${base}/healthz`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true, version: "0.0.0", db: 0 });

		const denied = await fetch(`${base}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "teach" }),
		});
		assert.equal(denied.status, 401);
		assert.match(denied.headers.get("www-authenticate") ?? "", /^Bearer/);
		const deniedBody = (await denied.json()) as { error: string };
		assert.deepEqual(deniedBody, { error: "нужен токен" });
		assert.ok(!JSON.stringify(deniedBody).includes(token), "the token must not leak into the body");

		const created = await fetch(`${base}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ kind: "teach", modelTeacher: "local/qwen" }),
		});
		assert.equal(created.status, 201);
		const body = (await created.json()) as { id: string };
		assert.equal(typeof body.id, "string");
		assert.ok(body.id.length > 0);
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("unknown session is 404, unknown kind is 400 with the allowed list", async () => {
	const { base, app, db } = await serve(makeConfig());
	try {
		const missing = await fetch(`${base}/sessions/00000000-0000-4000-8000-000000000000`);
		assert.equal(missing.status, 404);
		assert.match(((await missing.json()) as { error: string }).error, /нет/);

		const bad = await fetch(`${base}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "unknown" }),
		});
		assert.equal(bad.status, 400);
		const text = JSON.stringify(await bad.json());
		assert.match(text, /teach/);
		assert.match(text, /practice/);
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("entries with afterOrdinal skips what the client already has", async () => {
	const { base, app, db } = await serve(makeConfig());
	try {
		const id = createSession(db, { kind: "teach" });
		appendEntry(db, { sessionId: id, kind: "text", role: "teacher", text: "первая" });
		appendEntry(db, { sessionId: id, kind: "text", role: "learner", text: "вторая" });

		const res = await fetch(`${base}/sessions/${id}/entries?afterOrdinal=1`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { entries: { ordinal: number; text: string }[] };
		assert.equal(body.entries.length, 1);
		assert.deepEqual(
			body.entries.map((entry) => [entry.ordinal, entry.text]),
			[[2, "вторая"]],
		);
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("stream delivers entries as SSE and ends when the session closes", async () => {
	const { base, app, db } = await serve(makeConfig());
	const idleTimeouts = timeoutHandles();
	try {
		const id = createSession(db, { kind: "teach" });
		appendEntry(db, { sessionId: id, kind: "text", role: "teacher", text: "первая" });

		const reading = readSse(`${base}/sessions/${id}/stream`, "event: end");
		await delay(50);
		appendEntry(db, { sessionId: id, kind: "text", role: "learner", text: "вторая про векторы" });
		await delay(300);
		closeSession(db, id);

		const stream = await reading;
		assert.equal(stream.status, 200);
		assert.equal(stream.headers["content-type"], "text/event-stream");
		assert.equal(stream.headers["cache-control"], "no-cache");
		assert.match(stream.raw, /^data: .*первая.*\n\n/m);
		assert.match(stream.raw, /^data: .*вторая про векторы.*\n\n/m);
		assert.match(stream.raw, /event: end\n/);

		// The client aborted after `end`; the polling interval must be gone with it.
		await delay(300);
		assert.equal(timeoutHandles(), idleTimeouts, "the closed stream left a live timer behind");

		// A client that hangs up while the session is still open: the interval has to
		// go with the connection, or every abandoned tab keeps polling the database.
		const openId = createSession(db, { kind: "teach" });
		appendEntry(db, { sessionId: openId, kind: "text", role: "teacher", text: "живая" });
		const aborted = await readSse(`${base}/sessions/${openId}/stream`, "\n\n");
		assert.match(aborted.raw, /^data: .*живая.*\n\n/m);
		await delay(400);
		assert.equal(timeoutHandles(), idleTimeouts, "an aborted stream left a live timer behind");
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("search finds indexed text, an empty query is refused", async () => {
	const { base, app, db } = await serve(makeConfig());
	try {
		const id = createSession(db, { kind: "practice" });
		appendEntry(db, { sessionId: id, kind: "text", role: "teacher", text: "векторы складываются по координатам" });

		const found = await fetch(`${base}/search?q=${encodeURIComponent("векторы")}`);
		assert.equal(found.status, 200);
		const hits = (await found.json()) as { hits: { text: string }[] };
		assert.equal(hits.hits.length, 1);
		assert.match(hits.hits[0]!.text, /векторы/);

		const empty = await fetch(`${base}/search?q=`);
		assert.equal(empty.status, 400);
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("export writes readable files into the export directory", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lth-export-"));
	const { base, app, db } = await serve(makeConfig({ exportDir: dir }));
	try {
		const id = createSession(db, { kind: "teach" });
		appendEntry(db, { sessionId: id, kind: "text", role: "teacher", text: "векторы" });

		const res = await fetch(`${base}/export`, { method: "POST" });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { files: number; dir: string };
		assert.equal(body.dir, dir);
		assert.ok(body.files >= 3, `expected at least three files, got ${body.files}`);
		assert.ok(existsSync(path.join(dir, "INDEX.md")), "INDEX.md must exist after export");
	} finally {
		db.close();
		await closeAll(app);
	}
});

test("a failing handler answers 500 with the text and keeps the stack in the log", async () => {
	const logs: string[] = [];
	const db = makeDb();
	const app = createApp({ db, config: makeConfig(), log: (message) => logs.push(message) });
	await app.listen({ host: "127.0.0.1", port: 0 });
	const info = app.server.address() as AddressInfo;
	try {
		db.close(); // the next query has to fail
		const res = await fetch(`http://127.0.0.1:${info.port}/healthz`);
		assert.equal(res.status, 500);
		const body = (await res.json()) as { error: string };
		assert.ok(body.error.length > 0, "the failure text goes out to the caller");
		assert.equal(logs.length, 1);
		assert.match(logs[0]!, /at /, "the log must carry the stack");
	} finally {
		await closeAll(app);
	}
});

test("the process saw no unhandled rejection", () => {
	assert.deepEqual(rejections, []);
});

// The built interface is served by this same process: the desktop window and the
// PWA both load the app from here, so there is one origin and no CORS. The shell
// is public, everything behind it is not — and an unknown path is not allowed to
// reveal whether a route exists there.
test("собранный интерфейс раздаётся тем же процессом, данные остаются за токеном", async (t) => {
	const uiDir = await mkdtemp(path.join(tmpdir(), "lth-ui-"));
	await mkdir(path.join(uiDir, "assets"), { recursive: true });
	await writeFile(path.join(uiDir, "index.html"), "<!doctype html><title>learntogether</title>");
	await writeFile(path.join(uiDir, "assets", "index.js"), "console.log(1)");
	await writeFile(path.join(uiDir, "secret.txt"), "не для сети");

	const { base, app } = await serve(makeConfig({ uiDir, accessToken: "sekret-token" }));
	t.after(async () => {
		await closeAll(app);
		await rm(uiDir, { recursive: true, force: true });
	});

	const page = await fetch(`${base}/`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-type") ?? "", /text\/html/);
	assert.match(await page.text(), /learntogether/);
	const asset = await fetch(`${base}/assets/index.js`);
	assert.equal(asset.status, 200);
	//outside the assets directory the token is required for anything at all
	assert.equal((await fetch(`${base}/secret.txt`)).status, 401);
	assert.equal((await fetch(`${base}/export`)).status, 401);
	assert.equal((await fetch(`${base}/sessions`, { method: "POST" })).status, 401);
});

test("без uiDir сервер остаётся только API", async (t) => {
	const { base, app } = await serve(makeConfig());
	t.after(() => closeAll(app));
	assert.equal((await fetch(`${base}/`)).status, 404);
});
