import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkBind, dataDir, loadConfig, pathsFor } from "../src/config.ts";

function config(file: string | null, env: NodeJS.ProcessEnv = {}) {
	const exists = file === null ? () => false : () => true;
	const read = file === null ? () => "" : () => file;
	return loadConfig({ ...env }, read, exists);
}

test("data directory follows LTH_DATA_DIR, then XDG_CONFIG_HOME, then HOME", () => {
	assert.equal(dataDir({ LTH_DATA_DIR: "/tmp/lth" }), path.resolve("/tmp/lth"));
	assert.equal(dataDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" }), path.join("/xdg", "learntogether"));
	assert.equal(dataDir({ HOME: "/h" }), path.join("/h", ".config", "learntogether"));
});

test("paths derive db and export from the data directory", () => {
	const p = pathsFor({ LTH_DATA_DIR: "/tmp/lth" });
	assert.equal(p.dbFile, path.join(path.resolve("/tmp/lth"), "learntogether.db"));
	assert.equal(p.exportDir, path.join(path.resolve("/tmp/lth"), "export"));
});

test("missing settings file gives defaults", () => {
	const c = config(null);
	assert.deepEqual(
		{ host: c.host, port: c.port, allowInsecure: c.allowInsecure, language: c.language, source: c.source },
		{ host: "127.0.0.1", port: 8765, allowInsecure: false, language: "ru", source: null },
	);
});

test("a broken settings file fails with its path instead of defaulting", () => {
	assert.throws(() => config('{"port": '), /settings\.json/);
	assert.throws(() => config("[]"), /settings\.json/);
});

test("environment overrides the settings file", () => {
	const c = config('{"port": 9100, "host": "0.0.0.0"}', { LTH_PORT: "9000" });
	assert.equal(c.port, 9000);
	assert.equal(c.host, "0.0.0.0");
});

test("a non-integer port is refused", () => {
	assert.throws(() => config(null, { LTH_PORT: "0" }), /порт/);
	assert.throws(() => config(null, { LTH_PORT: "abc" }), /порт/);
});

test("loopback binds without a token, anything else needs one", () => {
	assert.deepEqual(checkBind(config(null)), { ok: true });
	const lan = config(null, { LTH_HOST: "0.0.0.0" });
	assert.equal(checkBind(lan).ok, false);
	const withToken = config(null, { LTH_HOST: "0.0.0.0", LTH_ACCESS_TOKEN: "s3cr3t" });
	assert.deepEqual(checkBind(withToken), { ok: true });
	// The token value must never reach the user-facing text (D-012).
	const refusal = checkBind(lan);
	if (!refusal.ok) assert.ok(!refusal.error.includes("s3cr3t"));
});
