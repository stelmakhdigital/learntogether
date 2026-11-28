// Очередь практики: порядок, вариативность форм, соседи по цепочке и пустой день.
// Числа планировщика проверяются в packages/domain/test/scheduler.test.ts, здесь —
// что хранилище хранит именно их и не теряет попытку.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	addChain,
	addDoubt,
	createRepeatItem,
	migrate,
	openDb,
	practiceQueue,
	repeatStatesForClaim,
	reviewRepeatItem,
	upsertClaim,
} from "../src/index.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

test("форма повторения — отдельный элемент, и он не дублируется", () => {
	const db = openedDb();
	const claimId = upsertClaim(db, { text: "Производная есть скорость изменения" }).id;

	const recall = createRepeatItem(db, { claimId, method: "recall" });
	assert.equal(createRepeatItem(db, { claimId, method: "recall" }), recall);
	const transfer = createRepeatItem(db, { claimId, method: "transfer" });
	assert.notEqual(transfer, recall);

	assert.throws(() => createRepeatItem(db, { claimId, method: "узнавание" as never }), /форма повторения/);
	assert.throws(() => createRepeatItem(db, { claimId: "нет-такого", method: "recall" }), /узла нет-такого нет в графе/);
});

test("повтор пишет попытку и состояние планировщика одним делом", () => {
	const db = openedDb();
	const claimId = upsertClaim(db, { text: "Предел отношения приращений" }).id;
	const item = createRepeatItem(db, { claimId, method: "recall" });

	const good = reviewRepeatItem(db, item, { at: "2026-01-01T09:00:00.000Z", rating: "good" });
	const row = db.prepare("SELECT * FROM repeat_item WHERE id = ?").get(item) as Record<string, unknown>;
	assert.equal(row.state, "review");
	assert.equal(row.reps, 1);
	assert.equal(row.lapses, 0);
	assert.equal(row.last_review_at, "2026-01-01T09:00:00.000Z");
	assert.equal(row.due_at, new Date(Date.parse("2026-01-01T09:00:00.000Z") + good.intervalDays! * 86_400_000).toISOString());
	assert.ok(good.intervalDays! >= 1);

	const attempt = db.prepare("SELECT verdict, rating, claim_id, repeat_item_id FROM attempt").get() as Record<string, unknown>;
	assert.deepEqual(attempt, { claim_id: claimId, rating: "good", repeat_item_id: item, verdict: "correct" });

	const again = reviewRepeatItem(db, item, { at: "2026-01-01T09:30:00.000Z", rating: "again" });
	assert.equal(again.minutes, 10);
	const afterFail = db.prepare("SELECT state, lapses, due_at, last_rating FROM repeat_item WHERE id = ?").get(item) as Record<
		string,
		unknown
	>;
	assert.deepEqual(afterFail, { due_at: "2026-01-01T09:40:00.000Z", lapses: 1, last_rating: "again", state: "learning" });
	assert.deepEqual(db.prepare("SELECT verdict FROM attempt ORDER BY created_at DESC LIMIT 1").get(), { verdict: "incorrect" });

	assert.throws(() => reviewRepeatItem(db, "нет-такого", { rating: "good" }), /элемента практики нет-такого нет/);
});

test("очередь идёт от сомнения к созревшему, новые — после созревших", () => {
	const db = openedDb();
	const doubt = upsertClaim(db, { text: "Дифференциал — это приращение" }).id;
	const late = upsertClaim(db, { text: "Цепное правило" }).id;
	const fresh = upsertClaim(db, { text: "Теорема Ролля" }).id;
	const future = upsertClaim(db, { text: "Формула Тейлора" }).id;

	const doubtItem = createRepeatItem(db, { claimId: doubt, method: "recall" });
	reviewRepeatItem(db, doubtItem, { at: "2026-01-01T09:00:00.000Z", rating: "again" });
	addDoubt(db, { claimId: doubt, source: "check_failed" });

	const lateItem = createRepeatItem(db, { claimId: late, method: "reasoning" });
	reviewRepeatItem(db, lateItem, { at: "2026-01-01T09:00:00.000Z", rating: "easy" });
	// Просрочим намеренно: элемент создан давно и срок уже прошёл.
	db.prepare("UPDATE repeat_item SET due_at = '2026-01-05T09:00:00.000Z' WHERE id = ?").run(lateItem);
	createRepeatItem(db, { claimId: fresh, method: "recall" });
	const futureItem = createRepeatItem(db, { claimId: future, method: "transfer" });
	reviewRepeatItem(db, futureItem, { at: "2026-01-01T09:00:00.000Z", rating: "easy" });
	// Заведем срок далеко вперёд: смысл проверки в том, что этот элемент ещё не созрел.
	db.prepare("UPDATE repeat_item SET due_at = '2026-06-01T09:00:00.000Z' WHERE id = ?").run(futureItem);

	const queue = practiceQueue(db, { at: "2026-01-10T09:00:00.000Z" });
	assert.deepEqual(queue.map((item) => [item.claimText, item.hasDoubt, item.early]), [
		["Дифференциал — это приращение", true, false],
		["Цепное правило", false, false],
		["Теорема Ролля", false, false],
	]);
	assert.equal(queue[2]!.dueAt, null, "новый элемент идёт без срока");
});

test("узлы одной цепочки в одно окно не попадают, другой ветки — попадают", () => {
	const db = openedDb();
	const premise = upsertClaim(db, { text: "Приращение — разница значений" }).id;
	const conclusion = upsertClaim(db, { text: "Отношение приращений даёт скорость" }).id;
	const unrelated = upsertClaim(db, { text: "Вектор — набор чисел" }).id;
	addChain(db, { conclusionId: conclusion, premiseIds: [premise] });

	const at = "2026-01-10T09:00:00.000Z";
	// Оба созрели и оба без срока: порядок задаёт очередь, а не срок.
	const a = createRepeatItem(db, { claimId: premise, method: "recall" });
	const b = createRepeatItem(db, { claimId: conclusion, method: "recall" });
	db.prepare("UPDATE repeat_item SET due_at = '2026-01-09T09:00:00.000Z' WHERE id IN (?, ?)").run(a, b);
	createRepeatItem(db, { claimId: unrelated, method: "recall" });
	db.prepare("UPDATE repeat_item SET due_at = '2026-01-09T09:30:00.000Z' WHERE claim_id = ?").run(unrelated);

	const queue = practiceQueue(db, { at, limit: 5 });
	assert.deepEqual(queue.map((item) => item.claimText), ["Приращение — разница значений", "Вектор — набор чисел"]);
	assert.equal(queue.some((item) => item.claimText.includes("Отношение приращений")), false);
});

test("когда не созрело ничего, очередь не становится пустым днём", () => {
	const db = openedDb();
	const claimId = upsertClaim(db, { text: "Сумма рядов" }).id;
	const item = createRepeatItem(db, { claimId, method: "recall" });
	reviewRepeatItem(db, item, { at: "2026-01-01T09:00:00.000Z", rating: "good" });

	const queue = practiceQueue(db, { at: "2026-01-01T12:00:00.000Z" });
	assert.equal(queue.length, 1);
	assert.deepEqual([queue[0]!.early, queue[0]!.claimText], [true, "Сумма рядов"]);
	assert.equal(practiceQueue(db, { at: "2026-01-01T12:00:00.000Z", limit: 100 }).length, 1);
	assert.throws(() => practiceQueue(db, { limit: 0 }), /limit — целое от 1 до 100/);
});

test("формы держатся раздельно: припоминание мертво, перенос не проверялся", () => {
	const db = openedDb();
	const claimId = upsertClaim(db, { text: "Интеграл — накопление" }).id;
	const recall = createRepeatItem(db, { claimId, method: "recall" });
	createRepeatItem(db, { claimId, method: "transfer" });
	reviewRepeatItem(db, recall, { at: "2026-01-01T09:00:00.000Z", rating: "good" });

	const states = repeatStatesForClaim(db, claimId, "2026-01-01T09:00:00.000Z");
	assert.deepEqual(states.map((state) => state.method), ["recall", "transfer"]);
	assert.equal(states[0]!.retrievability, 1, "сразу после повтора вспоминание полное");
	assert.equal(states[1]!.retrievability, null, "перенос не проверялся — и в отчёте его нет");
	const later = repeatStatesForClaim(db, claimId, "2026-03-01T09:00:00.000Z");
	assert.ok((later[0]!.retrievability ?? 1) < 0.9, "через два месяца вспоминание упало ниже целевой доли");
});
