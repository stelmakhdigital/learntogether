// The graph rules that the method leans on: one wording is one node, a chain is
// premises together, and deleting a node never leaves a chain holding up nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	addChain,
	addProvenance,
	claimExists,
	countClaims,
	deleteChain,
	deleteClaim,
	migrate,
	openDb,
	readClaim,
	searchClaimsLexical,
	upsertClaim,
} from "../src/index.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function openedDb(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return db;
}

test("one wording is one node, whatever the case or the extra spaces", () => {
	const db = openedDb();
	const first = upsertClaim(db, { area: "арифметика", tags: ["сложение"], text: "Скорость изменения функции" });
	const again = upsertClaim(db, { text: "  скорость изменения функции  " });

	assert.equal(again.deduped, true);
	assert.equal(again.id, first.id);
	assert.equal(countClaims(db), 1);
});

test("a wording that arrives as an alias joins the node that already holds it", () => {
	const db = openedDb();
	const node = upsertClaim(db, { aliases: ["мгновенная скорость"], text: "Производная" });
	// Same node by alias, and the alias list stays free of the canonical wording.
	const byAlias = upsertClaim(db, { text: "Мгновенная скорость" });

	assert.equal(byAlias.id, node.id);
	assert.equal(byAlias.deduped, true);
	// A wording differing only in case is the same alias, not a second one; a real
	// second phrasing lands beside it.
	assert.deepEqual(readClaim(db, node.id).aliases, ["мгновенная скорость"]);
	upsertClaim(db, { text: "Производная" });
	assert.deepEqual(readClaim(db, node.id).aliases, ["мгновенная скорость"]);
	upsertClaim(db, { aliases: ["темп изменения"], text: "Производная" });
	assert.deepEqual(readClaim(db, node.id).aliases, ["мгновенная скорость", "темп изменения"]);
	assert.equal(countClaims(db), 1);
	// An empty wording would match every other empty node.
	assert.throws(() => upsertClaim(db, { text: "   " }), /пустой узел|текст узла пуст/);
});

test("a chain needs premises, known nodes and no circle", () => {
	const db = openedDb();
	const conclusion = upsertClaim(db, { text: "Сумма не меняется от порядка" }).id;
	const premise = upsertClaim(db, { text: "Сложение считается по частям" }).id;

	assert.throws(() => addChain(db, { conclusionId: conclusion, premiseIds: [] }), /без посылок/);
	assert.throws(() => addChain(db, { conclusionId: conclusion, premiseIds: ["нет-такого"] }), /нет в графе/);
	assert.throws(() => addChain(db, { conclusionId: conclusion, premiseIds: [conclusion] }), /посылкой самого себя/);

	const chain = addChain(db, { conclusionId: conclusion, premiseIds: [premise, premise] });
	assert.deepEqual(chain.premiseIds, [premise]);
	// The same premises and conclusion are the same chain, not a second support.
	assert.equal(addChain(db, { conclusionId: conclusion, premiseIds: [premise] }).id, chain.id);
});

test("a node is read with what rests on it, where it came from and what is doubted", () => {
	const db = openedDb();
	const premise = upsertClaim(db, { text: "Приращение — разница значений" }).id;
	const conclusion = upsertClaim(db, { text: "Отношение приращений даёт скорость" }).id;
	const chain = addChain(db, { conclusionId: conclusion, premiseIds: [premise], provenanceNote: "шаг 1 урока" });
	addProvenance(db, { claimId: premise, note: "из разговора" });

	const reading = readClaim(db, premise);
	assert.equal(reading.usedIn[0]?.id, chain.id);
	assert.equal(reading.usedIn[0]?.conclusionId, conclusion);
	assert.equal(reading.provenance.length, 1);
	assert.equal(readClaim(db, conclusion).chains[0]?.premiseIds[0], premise);
	assert.equal(readClaim(db, conclusion).provenance[0]?.note, "шаг 1 урока");
});

test("deleting a node keeps the graph free of dangling references", () => {
	const db = openedDb();
	const premise = upsertClaim(db, { text: "Основание" }).id;
	const conclusion = upsertClaim(db, { text: "Вывод" }).id;
	addChain(db, { conclusionId: conclusion, premiseIds: [premise] });
	addProvenance(db, { claimId: conclusion });

	// A node inside a chain is refused, and the refusal says which chain to fix.
	assert.throws(() => deleteClaim(db, premise), /стоит в цепках.*посылка/);
	assert.throws(() => deleteClaim(db, conclusion), /вывод/);

	// Refused deletions changed nothing.
	assert.equal(claimExists(db, conclusion), true);
	// The chain goes first, saying what stops being supported.
	deleteChain(db, readClaim(db, conclusion).chains[0]!.id);
	deleteClaim(db, conclusion);
	assert.throws(() => deleteClaim(db, conclusion), /узла .* нет/);

	// What only referred to the node went with it; nothing points at it now.
	const refs = db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM provenance WHERE claim_id = ?) AS provenance,
			        (SELECT COUNT(*) FROM doubt WHERE claim_id = ?) AS doubt,
			        (SELECT COUNT(*) FROM claim_fts WHERE claim_id = ?) AS fts`,
		)
		.get(conclusion, conclusion, conclusion) as { doubt: number; fts: number; provenance: number };
	assert.deepEqual(refs, { doubt: 0, fts: 0, provenance: 0 });
	assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("lexical search ranks the node that answers the words", () => {
	const db = openedDb();
	upsertClaim(db, { text: "Производная есть скорость изменения функции в точке" });
	upsertClaim(db, { text: "Интеграл есть накопление" });
	upsertClaim(db, { text: "Скорость" });

	const hits = searchClaimsLexical(db, "скорость изменения");
	// One word is enough to be found, both words put the node first.
	assert.ok(hits.length >= 2, `найдено ${hits.length}`);
	assert.match(hits[0]!.text, /Производная есть скорость/);
	assert.throws(() => searchClaimsLexical(db, "  "), /пустой запрос/);
});
