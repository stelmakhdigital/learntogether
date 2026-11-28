// Генератор эталонной фикстуры планировщика (D-035). Запуск из корня: node scripts/genFsrsFixtures.ts
// Нужен devDependency ts-fsrs; фикстура коммитится, в рантайме приложения этой зависимости нет.
import { FSRS, generatorParameters } from "ts-fsrs";
import { writeFileSync } from "node:fs";
const f = new FSRS(generatorParameters({ enable_fuzz: false }));
const a = f.model.algorithm;
const RATINGS = [1, 2, 3, 4];
const steps = [];
// scripted history: ratings with elapsed days between reviews (0 = same day)
const history = [
	{ rating: 3, elapsed: 0 },
	{ rating: 3, elapsed: 0 },
	{ rating: 4, elapsed: 1 },
	{ rating: 2, elapsed: 3 },
	{ rating: 1, elapsed: 7 },
	{ rating: 3, elapsed: 0 },
	{ rating: 3, elapsed: 1 },
	{ rating: 1, elapsed: 0 },
	{ rating: 2, elapsed: 2 },
	{ rating: 4, elapsed: 30 },
];
let mem = null;
for (const step of history) {
	mem = a.next_state(mem, step.elapsed, step.rating, undefined);
	steps.push({ rating: step.rating, elapsed: step.elapsed, difficulty: mem.difficulty, stability: mem.stability });
}
const curves = [];
for (const [elapsed, s] of [[0, 5], [1, 5], [5, 10], [30, 10], [100, 40.5]]) curves.push({ elapsed, stability: s, r: a.forgetting_curve(elapsed, s) });
const intervals = [];
for (const s of [0.212, 1.2931, 2.3065, 8.2956, 5, 10, 40.5, 300]) {
	const row = { stability: s, retention: {} };
	for (const r of [0.8, 0.9, 0.95]) row.retention[String(r)] = a.next_interval(s, r);
	intervals.push(row);
}
// all four ratings from the initial state
const first = {};
for (const g of RATINGS) first[String(g)] = a.next_state(null, 0, g, undefined);
writeFileSync(
	"../packages/domain/test/fixtures/fsrs6.json",
	JSON.stringify({ source: "ts-fsrs 6.0.1 (devDependency), algorithm.next_state/next_interval/forgetting_curve, enable_fuzz off", weights: a.weights, first, steps, curves, intervals }, null, 1) + "\n",
);
console.log("fixture written", steps.length, "steps");
