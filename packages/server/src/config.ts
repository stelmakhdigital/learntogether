// Where the app keeps its data and how the server binds. Decision D-012: a
// non-loopback bind without an access token is refused, not warned about.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Paths {
	/** Directory holding the database, the export and the settings file. */
	dir: string;
	dbFile: string;
	exportDir: string;
}

export interface Config {
	host: string;
	port: number;
	/** Explicit opt-in to serve without a token; only meaningful on loopback. */
	allowInsecure: boolean;
	language: "ru" | "en";
	/** Set from LTH_ACCESS_TOKEN; never logged and never written to disk. */
	accessToken: string | null;
	/** Settings file the values came from, or null when defaults are used. */
	source: string | null;
	/** Directory the readable export is written to, derived from the data dir. */
	exportDir: string;
	/** Teacher endpoint, or null when no model is configured: turn routes then
	 *  answer 503 instead of pretending a lesson can run. */
	model: ModelSettings | null;
}

/** One model endpoint. The api key is env-only (D-012): key material never
 *  lands in the settings file; the OS key store arrives with the multi-profile
 *  stage-2 item and is not silently substituted by the file. */
export interface ModelSettings {
	/** Server root without the "/v1" segment, e.g. "http://127.0.0.1:8123". */
	baseUrl: string;
	model: string;
	apiKey: string | null;
	/** Tokens one teacher turn may spend on its answer, when the server reports no
	 *  output cap of its own. Null means the built-in allowance. A reasoning model
	 *  spends part of it on thinking, so the default is set by us and raised here,
	 *  not discovered: LTH_OUTPUT_TOKENS / model.output_tokens. */
	outputTokens: number | null;
}

export const DEFAULT_PORT = 8765;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function truthy(value: string | undefined): boolean | null {
	if (value === undefined || value === "") return null;
	const lowered = value.toLowerCase();
	if (lowered === "1" || lowered === "true" || lowered === "yes") return true;
	if (lowered === "0" || lowered === "false" || lowered === "no") return false;
	return null;
}

export function dataDir(env: NodeJS.ProcessEnv): string {
	const explicit = env.LTH_DATA_DIR;
	if (explicit !== undefined && explicit !== "") return path.resolve(explicit);
	const configHome = env.XDG_CONFIG_HOME;
	// XDG points at $HOME, so we read it from the environment we were given rather
	// than from the process user, which keeps the function testable.
	const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
	const base = configHome !== undefined && configHome !== "" ? configHome : path.join(home, ".config");
	return path.join(base, "learntogether");
}

export function pathsFor(env: NodeJS.ProcessEnv): Paths {
	const dir = dataDir(env);
	return { dir, dbFile: path.join(dir, "learntogether.db"), exportDir: path.join(dir, "export") };
}

/** Defaults, then the settings file, then the environment. A malformed file is
 *  an error naming the path: falling back to defaults silently would hide the
 *  file the user believes is in effect. */
export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	read: (file: string) => string = (file) => readFileSync(file, "utf8"),
	exists: (file: string) => boolean = existsSync,
): Config {
	const paths = pathsFor(env);
	const file = path.join(paths.dir, "settings.json");
	let stored: Record<string, unknown> = {};
	let source: string | null = null;
	if (exists(file)) {
		source = file;
		let parsed: unknown;
		try {
			parsed = JSON.parse(read(file));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`не получилось разобрать ${file}: ${reason}`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`в ${file} ожидается объект JSON, а не ${Array.isArray(parsed) ? "массив" : typeof parsed}`);
		}
		stored = parsed as Record<string, unknown>;
	}

	const host = env.LTH_HOST ?? (typeof stored.host === "string" ? stored.host : "127.0.0.1");

	const portText = env.LTH_PORT ?? (stored.port === undefined ? undefined : String(stored.port));
	let port = DEFAULT_PORT;
	if (portText !== undefined && portText !== "") {
		const parsed = Number(portText);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
			throw new Error(`порт должен быть целым числом от 1 до 65535, получено ${portText}`);
		}
		port = parsed;
	}

	const insecure = truthy(env.LTH_ALLOW_INSECURE) ?? (typeof stored.allowInsecure === "boolean" ? stored.allowInsecure : false);

	const language = stored.language === "en" ? "en" : "ru";
	const token = env.LTH_ACCESS_TOKEN;

	return {
		host,
		port,
		allowInsecure: insecure,
		language,
		accessToken: token === undefined || token === "" ? null : token,
		source,
		exportDir: paths.exportDir,
		model: readModel(env, stored, file),
	};
}

/** Model endpoint: settings file first, environment on top. A half-configured
 *  model (url without id or the reverse) is an error naming both keys: guessing
 *  the missing half is exactly the silent fallback D-006 refused. */
function readModel(
	env: NodeJS.ProcessEnv,
	stored: Record<string, unknown>,
	file: string,
): ModelSettings | null {
	const storedModel =
		stored.model !== null && typeof stored.model === "object" && !Array.isArray(stored.model)
			? (stored.model as Record<string, unknown>)
			: {};
	const baseUrl = env.LTH_MODEL_URL ?? (typeof storedModel.url === "string" ? storedModel.url : "");
	const model = env.LTH_MODEL_ID ?? (typeof storedModel.id === "string" ? storedModel.id : "");
	const key = env.LTH_MODEL_API_KEY;
	if (baseUrl === "" && model === "") return null;
	if (baseUrl === "") {
		throw new Error(`модель задана (${model}), а её адрес нет: задай model.url в ${file} или LTH_MODEL_URL`);
	}
	if (model === "") {
		throw new Error(`адрес модели задан (${baseUrl}), а её id нет: задай model.id в ${file} или LTH_MODEL_ID`);
	}
	if (!/^https?:\/\//i.test(baseUrl)) {
		throw new Error(`адрес модели должен начинаться с http:// или https://, получено ${baseUrl}`);
	}
	const apiKey = key === undefined || key === "" ? null : key;
	return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model, outputTokens: readOutputTokens(env, storedModel) };
}

/** How much of the window one answer may take on a server that reports no cap of
 *  its own. Refused rather than ignored when unparseable: a silently dropped value
 *  leaves the user believing they raised it (D-006). */
function readOutputTokens(env: NodeJS.ProcessEnv, storedModel: Record<string, unknown>): number | null {
	const text = env.LTH_OUTPUT_TOKENS ?? (storedModel.output_tokens === undefined ? undefined : String(storedModel.output_tokens));
	if (text === undefined || text === "") return null;
	const value = Number(text);
	if (!Number.isInteger(value) || value < 256) {
		throw new Error(
			`LTH_OUTPUT_TOKENS / model.output_tokens: нужно целое число токенов не меньше 256, получено ${text}`,
		);
	}
	return value;
}

/** What `bind` means for the network. Returns an error text instead of throwing
 *  so the caller can show it and exit with a clear code. */
export function checkBind(config: Config): { ok: true } | { ok: false; error: string } {
	if (LOOPBACK.has(config.host)) return { ok: true };

	const reachable = config.allowInsecure || config.accessToken !== null;
	if (reachable) return { ok: true };

	return {
		ok: false,
		error:
			`адрес ${config.host} доступен не только с этой машины. ` +
			"Задай LTH_ACCESS_TOKEN или запусти на 127.0.0.1.",
	};
}
