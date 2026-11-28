// The size the graph screen is supposed to stay readable at. Measured rather than
// assumed, and in the same units the acceptance names: twenty thousand nodes, and a
// search that answers before a person stops typing.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { countClaims, foldWording, listClaims, migrate, openDb, searchClaimsLexical } from "@learntogether/data";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const NODES = 20_000;

/** A graph of the shape a year of lessons makes: wording that shares its vocabulary,
 *  and chains that tie each new node to an older one. */
function bigGraph() {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const now = new Date().toISOString();
	// The fixture writes rows directly: the checks upsertClaim and addChain make are
	// what the graph tests verify, and paying for them twenty thousand times would
	// measure the test, not the index.
	const claim = db.prepare("INSERT INTO claim (id, area, created_at, norm, tags_json, text, updated_at) VALUES (?, NULL, ?, ?, '[]', ?, ?)");
	const chain = db.prepare("INSERT INTO chain (conclusion_claim_id, created_at, id) VALUES (?, ?, ?)");
	const premise = db.prepare("INSERT INTO chain_premise (chain_id, claim_id, ordinal) VALUES (?, ?, 0)");
	const ids: string[] = [];
	const build = db.transaction(() => {
		for (let at = 0; at < NODES; at += 1) {
			const id = `node-${at}`;
			const text = `производная функции в точке ${at} есть предел отношения приращений`;
			claim.run(id, now, foldWording(text), text, now);
			ids.push(id);
		}
		for (let at = 1; at < NODES; at += 1) {
			const id = `chain-${at}`;
			chain.run(ids[at]!, now, id);
			premise.run(id, ids[at - 1]!);
		}
	});
	build();
	return { db, ids };
}

test(`поиск по графу из ${NODES} узлов отвечает до того, как человек допечатал запрос`, () => {
	const { db, ids } = bigGraph();
	// Warm once: the first query opens the FTS index and pays for the page cache.
	searchClaimsLexical(db, "предел", 20);

	const started = performance.now();
	const hits = searchClaimsLexical(db, "предел отношения", 20);
	const took = performance.now() - started;

	assert.ok(hits.length > 0, "поиск обязан находить");
	assert.ok(hits.length <= 20, `лимита выбранного держимся: ${hits.length}`);
	assert.ok(took < 150, `искать ${took.toFixed(1)} мс — экран не успевает за вводом`);
	assert.equal(countClaims(db), NODES);

	// Browse is the other half: the first screen of a big graph must not be the whole
	// graph through a socket.
	const browsed = performance.now();
	const page = listClaims(db, { limit: 50 });
	const browseTook = performance.now() - browsed;
	assert.equal(page.length, 50);
	assert.ok(browseTook < 150, `браузе по узлам идёт ${browseTook.toFixed(1)} мс`);
	assert.equal(ids.length, NODES);
	db.close();
});
