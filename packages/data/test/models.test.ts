// The probe-result store: what the probe measured lands as-is, and what it
// could not measure stays NULL (D-006). Upserts are the normal path: every
// startup re-probes the same endpoint row.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getModelInfo, migrate, openDb, saveEndpoint, saveModelInfo } from "../src/index.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function startedDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

const baseInfo = {
	contextTokens: 6144,
	endpointId: "default",
	maxOutputTokens: null,
	modelId: "qwen",
	probeMethod: "props+meta",
	supportsReasoning: false,
	supportsTools: true,
	tokenizerSource: "server" as const,
};

test("an endpoint and its model info survive a write and a read", () => {
	const db = startedDb();
	saveEndpoint(db, { baseUrl: "http://127.0.0.1:8123", id: "default", label: "qwen" });
	saveModelInfo(db, baseInfo);
	const row = getModelInfo(db, "default", "qwen");
	assert.ok(row);
	assert.equal(row.contextTokens, 6144);
	assert.equal(row.maxOutputTokens, null);
	assert.equal(row.supportsTools, true);
	assert.equal(row.supportsReasoning, false);
	assert.equal(row.tokenizerSource, "server");
	assert.ok(row.probedAt);
});

test("unmeasured fields stay NULL, never zero", () => {
	const db = startedDb();
	saveEndpoint(db, { baseUrl: "http://x", id: "default", label: "x" });
	saveModelInfo(db, { ...baseInfo, contextTokens: null, supportsReasoning: null, supportsTools: null });
	const row = getModelInfo(db, "default", "qwen");
	assert.ok(row);
	assert.equal(row.contextTokens, null);
	assert.equal(row.supportsTools, null);
	assert.equal(row.supportsReasoning, null);
});

test("re-probing the same endpoint replaces the old measurement", () => {
	const db = startedDb();
	saveEndpoint(db, { baseUrl: "http://x", id: "default", label: "x" });
	saveModelInfo(db, baseInfo);
	saveModelInfo(db, { ...baseInfo, contextTokens: 8192, supportsTools: false });
	const row = getModelInfo(db, "default", "qwen");
	assert.ok(row);
	assert.equal(row.contextTokens, 8192);
	assert.equal(row.supportsTools, false);
	// The base_url of a re-added endpoint follows the new config, not the old row.
	saveEndpoint(db, { baseUrl: "http://new", id: "default", label: "x2" });
	const url = db.prepare("SELECT base_url FROM endpoint WHERE id = 'default'").get() as { base_url: string };
	assert.equal(url.base_url, "http://new");
});

test("model info without an endpoint row is refused by the foreign key", () => {
	const db = startedDb();
	assert.throws(() => saveModelInfo(db, baseInfo), /FOREIGN KEY|constraint/i);
});
