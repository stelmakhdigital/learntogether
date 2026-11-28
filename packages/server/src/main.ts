// Entry point of the server process (docs/architecture.md, «Процессы и
// упаковка»): Electron starts this module as a separate process, so a crash
// here must not take the window down with it.

import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate, openDb } from "@learntogether/data";
import { createApp } from "./app.ts";
import { composeTurnRunner, type Composition } from "./compose.ts";
import { checkBind, loadConfig, pathsFor, type Config } from "./config.ts";

// Migrations ship next to the data package. The path is resolved from this
// module, never from the working directory, so any launcher may start us.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../data/migrations", import.meta.url));

function log(message: string): void {
	process.stdout.write(`learntogether: ${message}\n`);
}

function fail(message: string): void {
	process.stderr.write(`learntogether: ${message}\n`);
}

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs the server until a stop signal. Returns the process exit code. */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	let config: Config;
	try {
		config = loadConfig(env);
	} catch (error) {
		fail(textOf(error));
		return 1;
	}

	const bind = checkBind(config);
	if (!bind.ok) {
		fail(bind.error);
		return 1;
	}

	if (!existsSync(MIGRATIONS_DIR)) {
		fail(`нет каталога миграций: ${MIGRATIONS_DIR}`);
		return 1;
	}

	const paths = pathsFor(env);
	mkdirSync(paths.dir, { recursive: true });
	let db;
	try {
		db = openDb(paths.dbFile);
		migrate(db, MIGRATIONS_DIR);
	} catch (error) {
		fail(`не получилось подготовить базу ${paths.dbFile}: ${textOf(error)}`);
		db?.close();
		return 1;
	}

	// The turn runner and the answer service exist only over a probed endpoint
	// (D-006): the probe measures the window and the tool calling, and a failed
	// probe stops the startup with its own words. Without a configured model the
	// server still serves data routes; the lesson routes answer 503.
	let composed: Composition | undefined;
	if (config.model !== null) {
		try {
			composed = await composeTurnRunner({ db, log, model: config.model });
		} catch (error) {
			fail(textOf(error));
			db.close();
			return 1;
		}
	} else {
		log("модель не настроена: хода урока не будет (model.url/id в settings.json или LTH_MODEL_URL/LTH_MODEL_ID)");
	}

	const app = createApp({
		db,
		config,
		log,
		...(composed === undefined ? {} : { answer: composed.answer, side: composed.side, turn: composed.turn }),
	});

	const stopSignal = (signal: string) => {
		log(`остановка по ${signal}`);
		void app
			.close()
			.catch((error: unknown) => fail(`сервер закрылся с ошибкой: ${textOf(error)}`))
			.finally(() => db.close());
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => stopSignal(signal));
	}

	try {
		await app.listen({ host: config.host, port: config.port });
	} catch (error) {
		fail(`не получилось слушать ${config.host}:${config.port}: ${textOf(error)}`);
		await app.close().catch(() => undefined);
		db.close();
		return 1;
	}

	const address = app.server.address();
	const port = typeof address === "object" && address !== null ? address.port : config.port;
	log(`сервер на http://${config.host}:${port}, база ${paths.dbFile}`);
	return 0;
}

if (import.meta.main) {
	start().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			fail(textOf(error));
			process.exitCode = 1;
		},
	);
}
