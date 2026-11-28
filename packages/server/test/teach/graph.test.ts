// The graph tools as the model meets them: answers that steer the next call, and
// refusals that name the field.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { addChain, addProvenance, addDoubt, createSession, migrate, openDb, upsertClaim } from "@learntogether/data";
import { createGraphTools } from "../../src/teach/graph.ts";
import { createTeachTools } from "../../src/teach/tools.ts";

const migrationsDir = fileURLToPath(new URL("../../../data/migrations", import.meta.url));

type Db = ReturnType<typeof openDb>;

function openedDb(): { db: Db; sessionId: string } {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	return { db, sessionId: createSession(db, { kind: "teach" }) };
}

function call(db: Db, sessionId: string, name: string, args: Record<string, unknown>): string {
	const tool = createGraphTools(db, sessionId).find((candidate) => candidate.name === name);
	assert.ok(tool, `tool ${name} is missing`);
	return String(tool.run(args, `${name}-call`));
}

test("the registry hands the model both graph tools", () => {
	const { db, sessionId } = openedDb();
	const names = createTeachTools(db, sessionId).map((tool) => tool.name);
	assert.deepEqual(names.filter((name) => name.startsWith("graph_")), ["graph_search", "graph_read"]);
});

test("search answers with ids to read, and an empty graph says what it does not mean", () => {
	const { db, sessionId } = openedDb();
	upsertClaim(db, { text: "Производная есть скорость изменения функции" });
	upsertClaim(db, { text: "Интеграл есть накопление" });

	const found = call(db, sessionId, "graph_search", { query: "скорость изменения" });
	assert.match(found, /Производная есть скорость/);
	assert.ok(call(db, sessionId, "graph_search", { query: "теорема пифагора" }).includes("ничего не найдено"));
	// A word the learner actually used is enough to be found.
	assert.match(call(db, sessionId, "graph_search", { query: "производная" }), /Производная/);
	assert.throws(() => call(db, sessionId, "graph_search", { k: 0, query: "скорость" }), /k — целое от 1 до 20/);
	assert.throws(() => call(db, sessionId, "graph_search", { query: "  " }), /query: нужна непустая строка/);
});

test("reading a node says what holds it, what rests on it and what is doubted", () => {
	const { db, sessionId } = openedDb();
	const premise = upsertClaim(db, { text: "Приращение — это разница значений" }).id;
	const conclusion = upsertClaim(db, { text: "Отношение приращений даёт скорость" }).id;
	const chain = addChain(db, { conclusionId: conclusion, premiseIds: [premise] });
	addProvenance(db, { claimId: premise, sessionId });
	addDoubt(db, { claimId: premise, note: "перепутал со средней скоростью", source: "check_failed" });

	const readConclusion = call(db, sessionId, "graph_read", { id: conclusion });
	assert.match(readConclusion, /держится на посылках: /);

	const readPremise = call(db, sessionId, "graph_read", { id: premise });
	assert.match(readPremise, /на него опираются цепки/);
	assert.match(readPremise, /под сомнением: перепутал/);
	assert.match(readPremise, new RegExp(`взято: урок ${sessionId}`));
	assert.match(readPremise, new RegExp(`на него опираются цепки: ${chain.id}`));
	assert.throws(() => call(db, sessionId, "graph_read", { id: "нет-такого" }), /узла нет-такого нет/);
});
