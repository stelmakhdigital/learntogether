// Screen check against the running pair: the dev server on 5174 and the app server
// on 8765. Deliberately outside `pnpm test` — that suite runs without servers. This
// one clicks the real screens against the real database and says what each screen
// showed. Usage: pnpm screens [--base http://localhost:5174]

import { chromium } from "playwright";

const base = process.argv.includes("--base")
	? process.argv[process.argv.indexOf("--base") + 1]
	: "http://localhost:5174";

const failures = [];

function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { height: 1200, width: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

async function screen(title) {
	await page.getByRole("button", { name: title }).click();
	await page.waitForTimeout(600);
	return await page.locator("main").innerText();
}

await page.goto(base, { waitUntil: "networkidle" });

const session = await screen("Сессия");
check("урок открывается без падений", !/ERROR|OFFLINE/.test(session), session.slice(0, 60).replace(/\n/g, " "));

const library = await screen("Библиотека");
check("библиотека называет число узлов", /узлов в графе: \d+/.test(library), library.match(/узлов в графе: \d+/)?.[0] ?? "нет счётчика");
const rows = await page.locator(".graph__row").count();
if (rows > 0) {
	await page.locator(".graph__row").first().click();
	await page.waitForTimeout(500);
	const detail = await page.locator(".graph__node").innerText();
	check("узел читается: цепочки или их отсутствие названы", /цепоч|сомнение/i.test(detail), detail.slice(0, 60).replace(/\n/g, " "));
} else {
	check("пустая библиотека говорит об этом прямо", /пока нет узлов|совпадений нет/.test(library), library.slice(0, 80).replace(/\n/g, " "));
}

const review = await screen("Повторения");
const queueShown = /припоминание|рассуждение|перенос/.test(review);
check("практика показывает очередь или честную пустоту", queueShown || /Повторять пока нечего/.test(review), review.slice(0, 80).replace(/\n/g, " "));
if (queueShown) {
	await page.getByRole("button", { name: "Начать практику" }).click();
	await page.waitForTimeout(800);
	const practice = await page.locator("main").innerText();
	check("кнопка ведёт в сессию практики", /Практика\.|Учитель даст задачу/.test(practice), practice.slice(0, 60).replace(/\n/g, " "));
}

const map = await screen("Карта");
check(
	"карта говорит, сколько узлов в окне",
	/в окне \d+ из \d+/.test(map) || /Карты нет/.test(map),
	map.replace(/\s+/g, " ").slice(-70),
);

const settings = await screen("Настройки");
check("заглушка настроек держит состояния", /EMPTY/.test(settings) && /LONG-CONTENT/.test(settings));

await browser.close();
check("ни одна страница не упала с исключением", errors.length === 0, errors.join(" | ").slice(0, 200));

if (failures.length > 0) {
	console.log(`\nне прошли: ${failures.join(", ")}`);
	process.exit(1);
}
