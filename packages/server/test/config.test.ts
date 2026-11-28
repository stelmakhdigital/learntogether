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

test("no model configured gives model: null", () => {
	assert.equal(config(null).model, null);
});

test("a model endpoint reads from the file and the environment on top", () => {
	const fromFile = config('{"model":{"url":"http://127.0.0.1:8080/","id":"llama/qwen"}}');
	assert.deepEqual(fromFile.model, {
		apiKey: null,
		baseUrl: "http://127.0.0.1:8080",
		model: "llama/qwen",
		outputTokens: null,
	});
	const fromEnv = config('{"model":{"url":"http://file","id":"file-model"}}', {
		LTH_MODEL_ID: "env-model",
		LTH_MODEL_URL: "http://env",
	});
	assert.deepEqual(fromEnv.model, { apiKey: null, baseUrl: "http://env", model: "env-model", outputTokens: null });
});

test("the answer allowance comes from the file or the environment, garbage is refused", () => {
	assert.equal(config('{"model":{"url":"http://x","id":"m","output_tokens":2048}}').model?.outputTokens, 2048);
	assert.equal(
		config('{"model":{"url":"http://x","id":"m","output_tokens":2048}}', { LTH_OUTPUT_TOKENS: "4096" }).model?.outputTokens,
		4096,
	);
	assert.throws(() => config('{"model":{"url":"http://x","id":"m"}}', { LTH_OUTPUT_TOKENS: "много" }), /не меньше 256/);
	assert.throws(() => config('{"model":{"url":"http://x","id":"m"}}', { LTH_OUTPUT_TOKENS: "64" }), /не меньше 256/);
});

test("a half-configured model names both missing keys instead of guessing", () => {
	assert.throws(() => config(null, { LTH_MODEL_URL: "http://only-url" }), /model\.id|LTH_MODEL_ID/);
	assert.throws(() => config(null, { LTH_MODEL_ID: "only-id" }), /model\.url|LTH_MODEL_URL/);
});

test("a model address without a scheme is refused", () => {
	assert.throws(() => config(null, { LTH_MODEL_URL: "127.0.0.1:8080", LTH_MODEL_ID: "m" }), /http:/);
});

test("the api key comes from the environment only, never the file", () => {
	const withKey = config('{"model":{"url":"http://x","id":"m"}}', { LTH_MODEL_API_KEY: "sk-secret" });
	assert.equal(withKey.model?.apiKey, "sk-secret");
	// A key placed in the file must not be picked up: it belongs to the OS store.
	const fileKey = config('{"model":{"apiKey":"sk-file","id":"m","url":"http://x"}}');
	assert.equal(fileKey.model?.apiKey, null);
});

// The interface directory is named or it is not: a half-named one must not leave
// the app window showing a blank page.
test("uiDir: по умолчанию интерфейс не раздаётся", () => {
	assert.equal(config(null, { LTH_DATA_DIR: "/tmp/lth" }).uiDir, null);
});

test("uiDir: указанный каталог без index.html — отказ с путём сборки", () => {
	assert.throws(
		() => loadConfig({ LTH_DATA_DIR: "/tmp/lth", LTH_UI_DIR: "/tmp/lth-no-ui" }, () => "", () => false),
		/index\.html[\s\S]*pnpm build/,
	);
});

test("uiDir: собранный интерфейс принимается по абсолютному пути", () => {
	const c = loadConfig(
		{ LTH_DATA_DIR: "/tmp/lth", LTH_UI_DIR: "/tmp/lth-ui" },
		() => "",
		(file) => file === path.join(path.resolve("/tmp/lth-ui"), "index.html"),
	);
	assert.equal(c.uiDir, path.resolve("/tmp/lth-ui"));
});
