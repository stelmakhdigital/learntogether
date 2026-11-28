// Where a node sits on the screen is stored data, not a rendering accident: it must
// survive a restart, refuse a position for a node that does not exist, and never be
// read by anything that teaches (D-079).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	addChain,
	graphEdges,
	graphSettings,
	hideNode,
	migrate,
	nodePositions,
	openDb,
	saveGraphSetting,
	saveNodePositions,
	upsertClaim,
} from "@learntogether/data";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

test("позиции читаются после записи, перезапись не плодит дублей", () => {
	const db = openedDb();
	const id = upsertClaim(db, { text: "производная — скорость изменения" }).id;
	saveNodePositions(db, [{ nodeId: id, x: 12.5, y: -8 }]);
	saveNodePositions(db, [{ nodeId: id, x: 40, y: 120 }]);
	const positions = [...nodePositions(db).values()];
	assert.equal(positions.length, 1);
	assert.deepEqual(positions[0], { hidden: false, nodeId: id, x: 40, y: 120 });
	db.close();
});

test("позиции чужого узла и нечисловых координат не бывает", () => {
	const db = openedDb();
	const id = upsertClaim(db, { text: "секущая" }).id;
	assert.throws(() => saveNodePositions(db, [{ nodeId: "нет-такого", x: 1, y: 2 }]), /нет в графе/);
	assert.throws(() => saveNodePositions(db, [{ nodeId: id, x: Number.NaN, y: 2 }]), /не число/);
	// The refusal is the whole request's: half a drag saved would put one node in two
	// places at once.
	assert.equal(nodePositions(db).size, 0);
	db.close();
});

test("скрыть узел — чтение, а не удаление: цепочки и практика остаются", () => {
	const db = openedDb();
	const premise = upsertClaim(db, { text: "предел отношения приращений" }).id;
	const conclusion = upsertClaim(db, { text: "производная — скорость изменения" }).id;
	addChain(db, { conclusionId: conclusion, premiseIds: [premise] });
	saveNodePositions(db, [{ nodeId: conclusion, x: 0, y: 0 }]);
	hideNode(db, conclusion, true);
	assert.equal(nodePositions(db).get(conclusion)?.hidden, true);
	assert.equal(graphEdges(db, [conclusion, premise]).length, 1);
	hideNode(db, conclusion, false);
	assert.equal(nodePositions(db).get(conclusion)?.hidden, false);
	assert.throws(() => hideNode(db, premise, true), /нет позиции/);
	db.close();
});

test("настройки вида графа переживают перезапись по ключу", () => {
	const db = openedDb();
	saveGraphSetting(db, "scale", "1");
	saveGraphSetting(db, "scale", "1.5");
	saveGraphSetting(db, "labels", "off");
	assert.deepEqual(graphSettings(db), { labels: "off", scale: "1.5" });
	assert.throws(() => saveGraphSetting(db, "  ", "x"), /пустой ключ/);
	db.close();
});

test("рёбра карты — только между узлами этого набора", () => {
	const db = openedDb();
	const a = upsertClaim(db, { text: "а" }).id;
	const b = upsertClaim(db, { text: "б" }).id;
	const outside = upsertClaim(db, { text: "вне окна" }).id;
	addChain(db, { conclusionId: a, premiseIds: [b, outside] });
	assert.deepEqual(graphEdges(db, [a, b]), [{ from: b, to: a }]);
	assert.deepEqual(graphEdges(db, []), []);
	db.close();
});
