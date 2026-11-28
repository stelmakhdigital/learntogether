// Desktop smoke: starts the shell headless, connects to its window over CDP and
// says what the learner would see. Kept out of `pnpm test`: that suite runs
// without Electron and without servers.
//
//	pnpm desktop:smoke [--shot /tmp/lth-desktop.png] [--data /tmp/lth-desktop]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, fallback) => {
	const at = process.argv.indexOf(name);
	return at === -1 ? fallback : process.argv[at + 1];
};

const failures = [];
function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(name);
}

// The real binary, not the .bin/electron wrapper: the wrapper forwards nothing, so
// a signal sent to it leaves the actual Electron running — and a second instance
// of the app then refuses to open a window, which looks like a dead debug port.
const electronBinary = path.join(REPO, "apps", "desktop", "node_modules", "electron", "dist", "electron");
if (!existsSync(electronBinary)) {
	console.log("нет Electron: pnpm install, и в apps/desktop должен распаковаться бинарник");
	process.exit(1);
}

/** Our own debug port: a fixed one would meet an Electron left from an earlier
 *  run, and the run would check that window instead of this one. */
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

const debugPort = await freePort();
const dataDir = arg("--data", "/tmp/lth-desktop-smoke");
const shot = arg("--shot", "/tmp/lth-desktop.png");

// Headless ozone instead of a virtual X server: one process less, and the same
// window content. SIGTERM reaches Electron directly, and the shell stops its
// server child on quit (checked: the child prints «остановка по SIGTERM»).
// A real X server, not headless ozone: capturing the window crashes there
// («GPU process isn't usable»), and a screenshot of the actual desktop window is
// part of what this check is for. Own process group, because xvfb-run is a shell
// wrapper that forwards no signals.
const app = spawn(
	"xvfb-run",
	["--auto-servernum", electronBinary, path.join(REPO, "apps", "desktop"), "--no-sandbox", `--remote-debugging-port=${debugPort}`],
	{ cwd: REPO, detached: true, env: { ...process.env, LTH_DATA_DIR: dataDir }, stdio: ["ignore", "inherit", "inherit"] },
);
const stop = (signal = "SIGTERM") => {
	try {
		process.kill(-app.pid, signal);
	} catch {
		// Already gone.
	}
};
process.on("SIGINT", () => stop());

// The shell prints «desktop:» lines as the server child speaks; the model probe is
// allowed to take a couple of minutes, so the port is waited for, not guessed.
async function waitForEndpoint(seconds) {
	for (let i = 0; i < seconds * 4; i += 1) {
		try {
			if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) return true;
		} catch {
			// Electron is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

if (!(await waitForEndpoint(180))) {
	console.log("Electron не поднял порт отладки за 180 с");
	stop();
	process.exit(1);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
// The window appears as a target once it has loaded; a fresh CDP connection can be
// older than the window, so the page is waited for rather than read once.
async function firstPage() {
	for (let i = 0; i < 240; i += 1) {
		const pages = browser.contexts()[0]?.pages() ?? [];
		if (pages.length > 0) return pages[0];
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return undefined;
}

const page = await firstPage();
if (page === undefined) {
	console.log("окно так и не появилось в отладке");
	stop();
	process.exit(1);
}
await page.waitForSelector("nav button", { timeout: 60_000 });
// Headless ozone starts with a small surface; without this the tab bar sits
// outside the viewport and no click on it lands.
await page.setViewportSize({ height: 900, width: 1280 });
const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
check("окно показало интерфейс", /Сессия/.test(text) && /Библиотека/.test(text), text.slice(0, 90));

// The token rides in the fragment on purpose: as a query string it would land in
// every request line and every proxy log between the window and the server.
const url = new URL(page.url());
check("токен в фрагменте адреса, а не в запросе", url.hash.includes("token=") && !url.searchParams.has("token"), url.pathname);

await page.getByRole("button", { name: "Библиотека" }).click();
await page.waitForTimeout(700);
const library = (await page.locator("main").innerText()).replace(/\s+/g, " ");
// Data-independent: a fresh database has nothing to show, and saying so is the
// correct answer. What must not happen is a screen stuck on nothing.
check("библиотека ответила числом узлов или честной пустотой", /узлов в графе: \d+|пока нет узлов/.test(library), library.slice(0, 80));

await page.screenshot({ path: shot, fullPage: true });
console.log(`скриншот: ${shot}`);

await browser.close();
stop();
// The X server and its children leave on their own; waiting for them would keep
// the run open on a process that is already dying.
setTimeout(() => stop("SIGKILL"), 5000).unref();

if (failures.length > 0) {
	console.log(`\nне прошли: ${failures.join(", ")}`);
	process.exit(1);
}
