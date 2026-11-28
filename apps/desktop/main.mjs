// Desktop shell. Its whole job: start the server as a separate process, show the
// served interface in a window, and stop the server on exit. The server owns the
// database and the model key; the window gets neither — it gets one URL whose
// fragment carries the access token, and a fragment never travels to the server.
//
// Run from the repository (Chromium's sandbox helper needs root, so a dev run and
// CI pass the switch below; packaged AppImage carries its own):
//
//	pnpm build
//	pnpm --filter @learntogether/desktop start -- --no-sandbox
//
// shortcut: the server child is started from the repository sources with this
// app's Electron running as Node; the packaged layout (server inside app.asar,
// resources next to it) arrives with the packaging stage — docs/desktop.md.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** The line the server prints once it is listening, with the port it actually got. */
const READY = /learntogether: сервер на http:\/\/127\.0\.0\.1:(\d+)/;
const READY_TIMEOUT_MS = 180_000;
const TAIL_LINES = 12;

function resolveServerEntry() {
	return process.env.LTH_SERVER_ENTRY ?? path.join(REPO, "packages", "server", "src", "main.ts");
}

function resolveUiDir() {
	return process.env.LTH_UI_DIR ?? path.join(REPO, "apps", "ui", "dist");
}

/** Node for the server child. Default is this app's own Electron in Node mode,
 *  which is what a packaged app must use anyway: one runtime, one better-sqlite3
 *  binary, nothing else to install. LTH_DESKTOP_NODE overrides it with any Node,
 *  handy when the repository's TypeScript is run by a separate Node build. */
function serverLaunch() {
	const explicit = process.env.LTH_DESKTOP_NODE;
	if (explicit !== undefined && explicit !== "") return { command: explicit, asNode: false };
	return { command: process.execPath, asNode: true };
}

/** A port to hand the server. Chosen by binding briefly and letting go: the
 *  server itself still picks the real port it got and prints it, and that number
 *  is what the window opens.
 *  shortcut: another process can take the port in between; the retry belongs to
 *  the packaging stage, where a failure has to be reported anyway. */
async function freePort() {
	return await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function stopServer(child) {
	if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	// The server closes the database on SIGTERM. A stuck one gets the harder signal
	// instead of keeping the app alive on an open handle.
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 5000).unref();
}

function log(message) {
	process.stdout.write(`desktop: ${message}\n`);
}

/** Starts the server, resolves with the URL to show. Rejects with the server's own
 *  last lines: a window that spins forever is worse than a dialog that names the
 *  failure, and the model probe is allowed to take a couple of minutes. */
function startServer(logger) {
	const uiDir = resolveUiDir();
	if (!existsSync(path.join(uiDir, "index.html"))) {
		return Promise.reject(new Error(`нет собранного интерфейса в ${uiDir}. Собери его: pnpm build`));
	}

	const accessToken = randomBytes(24).toString("base64url");
	const { command, asNode } = serverLaunch();

	return freePort().then((port) => new Promise((resolve, reject) => {
		const child = spawn(command, [resolveServerEntry()], {
			cwd: REPO,
			env: {
				...process.env,
				...(asNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				LTH_ACCESS_TOKEN: accessToken,
				LTH_DATA_DIR: process.env.LTH_DATA_DIR ?? app.getPath("userData"),
				LTH_PORT: process.env.LTH_PORT ?? String(port),
				LTH_UI_DIR: uiDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let settled = false;
		let buffer = "";
		const tail = [];
		const finish = (ok, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (ok) resolve({ url: value, child });
			else reject(value instanceof Error ? value : new Error(String(value)));
		};

		const timer = setTimeout(() => {
			stopServer(child);
			finish(false, new Error(`сервер не сказал, что слушает, за ${READY_TIMEOUT_MS / 1000} с. Последние строки: ${tail.join(" / ") || "ничего"}`));
		}, READY_TIMEOUT_MS);

		const onData = (chunk) => {
			buffer += String(chunk);
			for (const line of String(chunk).split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				logger(trimmed);
				tail.push(trimmed);
				if (tail.length > TAIL_LINES) tail.shift();
			}
			const match = READY.exec(buffer);
			if (match !== null) finish(true, `http://127.0.0.1:${match[1]}/#token=${accessToken}`);
		};

		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (error) => finish(false, new Error(`не запустился сервер ${command}: ${error.message}`)));
		child.on("exit", (code, signal) =>
			finish(false, new Error(`сервер завершился (${signal ?? `код ${code}`}). Последние строки: ${tail.join(" / ") || "ничего"}`)),
		);
	}));
}

async function main() {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	await app.whenReady();

	let server;
	try {
		server = await startServer(log);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// On the terminal first, in a dialog second: a headless run has no window to
		// show the dialog in, and its log still has to say what failed.
		log(message);
		dialog.showErrorBox("learntogether не запустился", message);
		app.quit();
		return;
	}

	server.child.on("exit", () => app.quit());
	app.on("before-quit", () => stopServer(server.child));

	const window = new BrowserWindow({
		backgroundColor: "#101014",
		height: 900,
		show: false,
		title: "learntogether",
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
		width: 1280,
	});

	// The window belongs to one origin. Anything else is a link the learner clicked
	// inside the app: it opens in the browser, never here.
	const appOrigin = new URL(server.url).origin;
	window.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== appOrigin) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});

	window.once("ready-to-show", () => window.show());
	await window.loadURL(server.url);
}

main().catch((error) => {
	log(`окно не открылось: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	app.quit();
});
