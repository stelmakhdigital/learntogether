// The map over HTTP: nodes with their saved places, the edges between them, and the
// writes a drag makes. Positions are accepted only for nodes that exist — a stale
// window must not be able to invent a node by moving it.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { addChain, migrate, nodePositions, openDb, upsertClaim } from "@learntogether/data";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const config: Config = {
	accessToken: null,
	allowInsecure: false,
	exportDir: "/tmp/lth-map-export",
	host: "127.0.0.1",
	language: "ru",
	model: null,
	port: 0,
	source: null,
	uiDir: null,
};

type Db = ReturnType<typeof openDb>;

async function withMap(run: (ctx: { base: string; db: Db }) => Promise<void>): Promise<void> {
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

interface MapBody {
	edges: { from: string; to: string }[];
	nodes: { id: string; text: string; x?: number; y?: number }[];
	settings: Record<string, string>;
	total: number;
}

type Refusal = { error?: string; saved?: number };

async function ask<T = Refusal>(base: string, path: string, body?: unknown): Promise<{ json: T; status: number }> {
	const response = await fetch(`${base}${path}`, {
		...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
		headers: { "content-type": "application/json" },
	});
	return { json: (await response.json()) as T, status: response.status };
}

test("карта отдаёт узлы с местами, рёбра между ними и настройки вида", async () => {
	await withMap(async ({ base, db }) => {
		const premise = upsertClaim(db, { text: "предел отношения приращений" }).id;
		const conclusion = upsertClaim(db, { text: "производная — скорость изменения" }).id;
		addChain(db, { conclusionId: conclusion, premiseIds: [premise] });

		const empty = await ask<MapBody>(base, "/graph/map");
		assert.equal(empty.status, 200);
		assert.equal(empty.json.nodes.length, 2);
		assert.equal(empty.json.nodes.filter((node) => node.x !== undefined).length, 0, "мест ещё нет");
		assert.deepEqual(empty.json.edges, [{ from: premise, to: conclusion }]);
		assert.equal(empty.json.total, 2);

		const saved = await ask(base, "/graph/positions", { positions: [{ nodeId: conclusion, x: 30, y: -12 }] });
		assert.equal(saved.status, 200);
		assert.equal(saved.json.saved, 1);

		const map = await ask<MapBody>(base, "/graph/map");
		const moved = map.json.nodes.find((node) => node.id === conclusion)!;
		assert.deepEqual({ x: moved.x, y: moved.y }, { x: 30, y: -12 });
		assert.equal(nodePositions(db).size, 1, "позиция уехала в базу, а не осталась в окне");
	});
});

test("карта отказывает там, где окно просит невозможного", async () => {
	await withMap(async ({ base, db }) => {
		const id = upsertClaim(db, { text: "секущая" }).id;
		assert.equal((await ask(base, "/graph/positions", { positions: [{ nodeId: id, x: 1, y: 2 }] })).status, 200);

		const ghost = await ask(base, "/graph/positions", { positions: [{ nodeId: "нет-такого", x: 1, y: 2 }] });
		assert.equal(ghost.status, 400);
		assert.match(ghost.json.error ?? "", /нет в графе/);

		const shape = await ask(base, "/graph/positions", { positions: [{ nodeId: id, x: 1 }] });
		assert.equal(shape.status, 400);
		assert.match(shape.json.error ?? "", /nodeId, x и y/);

		const nonsense = await ask(base, "/graph/positions", { positions: "не массив" });
		assert.equal(nonsense.status, 400);

		const hidden = await ask(base, "/graph/node/hidden", { hidden: true, nodeId: "нет-такого" });
		assert.equal(hidden.status, 404);

		const setting = await ask(base, "/graph/setting", { key: "scale", value: "2" });
		assert.equal(setting.status, 200);
		assert.equal((await ask<MapBody>(base, "/graph/map")).json.settings.scale, "2");
	});
});
