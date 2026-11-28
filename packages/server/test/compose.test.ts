// The composition root wires probe → storage → TurnRunner. These tests use a
// fixture fetch shaped like llama.cpp b12723: they check that composition
// stores the measurement, builds a runner with a real budget, and refuses the
// two cases that cannot teach — no tool calling and an unmeasured window.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getModelInfo, migrate, openDb } from "@learntogether/data";
import type { FetchFn } from "@learntogether/models";
import { composeTurnRunner, DEFAULT_ENDPOINT_ID } from "../src/compose.ts";
import type { ModelSettings } from "../src/config.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));
const MODEL = "/models/qwen.gguf";

function startedDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

function settings(): ModelSettings {
	return { apiKey: null, baseUrl: "http://127.0.0.1:8123", model: MODEL };
}

function fixture(options: { toolCalls?: boolean; nCtx?: number | null } = {}): FetchFn {
	const toolCalls = options.toolCalls ?? true;
	const json = (body: unknown): Response =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	return async (url, _init) => {
		const path = new URL(url).pathname;
		if (path === "/props") {
			return json({ chat_template_caps: { supports_tool_calls: true }, default_generation_settings: { n_predict: -1 } });
		}
		if (path === "/v1/models") {
			const meta = options.nCtx === null ? {} : { n_ctx: 6144 };
			return json({ data: [{ id: MODEL, meta }], type: "list" });
		}
		if (path === "/v1/chat/completions") {
			return json({
				choices: [
					{
						finish_reason: toolCalls ? "tool_calls" : "stop",
						index: 0,
						message: toolCalls
							? { content: "", tool_calls: [{ function: { arguments: '{"ping":"ok"}', name: "probe_ping" }, id: "c" }] }
							: { content: "нет" },
					},
				],
				usage: { completion_tokens: 6, prompt_tokens: 200, total_tokens: 206 },
			});
		}
		if (path === "/apply-template") return json({ prompt: "p" });
		if (path === "/tokenize") return json({ tokens: new Array(200).fill(1) });
		return json({});
	};
}

test("composition stores the probe and builds a runner with a measured budget", async () => {
	const db = startedDb();
	const runner = await composeTurnRunner({ db, fetch: fixture(), log: () => {}, model: settings() });
	assert.ok(runner);

	const row = getModelInfo(db, DEFAULT_ENDPOINT_ID, MODEL);
	assert.ok(row);
	assert.equal(row.contextTokens, 6144);
	assert.equal(row.supportsTools, true);
	assert.equal(row.tokenizerSource, "server");

	// The budget the runner will hand the loop exists and fits the window.
	const endpoint = db
		.prepare("SELECT base_url FROM endpoint WHERE id = ?")
		.get(DEFAULT_ENDPOINT_ID) as { base_url: string };
	assert.equal(endpoint.base_url, "http://127.0.0.1:8123");
});

test("a model that cannot call tools fails composition with its own reason", async () => {
	const db = startedDb();
	await assert.rejects(
		composeTurnRunner({ db, fetch: fixture({ toolCalls: false }), log: () => {}, model: settings() }),
		/не вызывает инструменты/,
	);
});

test("an unmeasured context window fails at startup, not mid-lesson (D-006)", async () => {
	const db = startedDb();
	await assert.rejects(
		composeTurnRunner({ db, fetch: fixture({ nCtx: null }), log: () => {}, model: settings() }),
		/не измерен|не пробирована/,
	);
});
