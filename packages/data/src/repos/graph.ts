// The knowledge graph: claims (nodes), chains (joint sufficiency — premises that
// together imply a conclusion), provenance and the wording dedup that keeps the
// same thought from becoming two nodes. Edges are derived from chains, there is no
// edges table (docs/architecture.md).

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ClaimRow = {
	id: string;
	text: string;
	area: string | null;
	tags: string[];
	createdAt: string;
	updatedAt: string;
};

export type ChainRow = {
	id: string;
	conclusionId: string;
	premiseIds: string[];
};

export type ProvenanceRow = {
	id: number;
	claimId: string;
	sessionId: string | null;
	stepId: string | null;
	sourceId: string | null;
	note: string | null;
};

export type ClaimReading = {
	claim: ClaimRow;
	chains: ChainRow[];
	/** Chains in which this claim is a premise: what rests on it. */
	usedIn: ChainRow[];
	provenance: ProvenanceRow[];
	openDoubts: { id: string; source: string; note: string | null }[];
	aliases: string[];
};

/** The form two wordings are compared in. SQLite folds ASCII only, so the fold is
 *  ours (migration 004): case, trailing punctuation and extra spaces are not a
 *  difference in what the learner holds. */
export function foldWording(text: string): string {
	return text
		.toLowerCase()
		.replace(/[.,;:!?]+$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function nowIso(): string {
	return new Date().toISOString();
}

function rowToClaim(row: Record<string, unknown>): ClaimRow {
	return {
		id: row.id as string,
		text: row.text as string,
		area: (row.area as string | null) ?? null,
		tags: JSON.parse((row.tags_json as string) || "[]") as string[],
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function chainRows(db: Database.Database, ids: string[]): ChainRow[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT c.id AS id, c.conclusion_claim_id AS conclusion_id, p.claim_id AS premise_id
			 FROM chain c JOIN chain_premise p ON p.chain_id = c.id
			 WHERE c.id IN (${placeholders}) ORDER BY c.created_at ASC, p.ordinal ASC`,
		)
		.all(...ids) as { conclusion_id: string; id: string; premise_id: string }[];
	const byChain = new Map<string, ChainRow>();
	for (const row of rows) {
		const chain = byChain.get(row.id) ?? { conclusionId: row.conclusion_id, id: row.id, premiseIds: [] };
		chain.premiseIds.push(row.premise_id);
		byChain.set(row.id, chain);
	}
	return [...byChain.values()];
}

/**
 * The node for a wording, creating it only when the wording is genuinely new.
 *
 * Dedup is by wording, case-insensitively (the unique index on `claim.text`), and
 * aliases are checked too: a graph where «скорость изменения» and «Скорость
 * изменения» are two nodes teaches the same thing twice and breaks the plan's
 * pruning. Refusing an empty wording is part of the same rule — an empty node
 * matches nothing and everything.
 */
export function upsertClaim(
	db: Database.Database,
	input: { text: string; area?: string; tags?: string[]; aliases?: string[] },
): { deduped: boolean; id: string } {
	const text = input.text.trim();
	if (text === "") throw new Error("текст узла пуст: узел без формулировки не отличить от другого");
	const norm = foldWording(text);
	const aliases = (input.aliases ?? [])
		.map((alias) => alias.trim())
		.filter((alias) => alias !== "" && foldWording(alias) !== norm);
	const tags = input.tags ?? [];

	const run = db.transaction((): { deduped: boolean; id: string } => {
		const byText = db.prepare("SELECT id FROM claim WHERE norm = ?").get(norm) as { id: string } | undefined;
		const byAlias =
			byText ?? (db.prepare("SELECT claim_id AS id FROM claim_alias WHERE norm = ?").get(norm) as { id: string } | undefined);
		if (byAlias !== undefined) {
			// The wording reached a node that already exists — by its own text or by an
			// alias. Recording the new wording as an alias keeps the learner's phrasing.
			if (byText === undefined) addAlias(db, byAlias.id, text);
			for (const alias of aliases) addAlias(db, byAlias.id, alias);
			return { deduped: true, id: byAlias.id };
		}

		const id = randomUUID();
		const now = nowIso();
		db.prepare("INSERT INTO claim (id, text, norm, area, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			id,
			text,
			norm,
			input.area ?? null,
			JSON.stringify(tags),
			now,
			now,
		);
		for (const alias of aliases) addAlias(db, id, alias);
		return { deduped: false, id };
	});
	return run();
}

function addAlias(db: Database.Database, claimId: string, text: string): void {
	// An alias that belongs to another node is a wording collision, not a new alias:
	// the caller already found the node it belongs to, so this stays a no-op.
	db.prepare("INSERT OR IGNORE INTO claim_alias (claim_id, text, norm) VALUES (?, ?, ?)").run(claimId, text, foldWording(text));
}

/** The node holding this wording, whatever the wording's case, spacing or trailing
 *  punctuation. Used before teaching something to ask whether the graph has it. */
export function findClaimByText(db: Database.Database, text: string): string | undefined {
	const row = db.prepare("SELECT id FROM claim WHERE norm = ?").get(foldWording(text)) as { id: string } | undefined;
	return row?.id;
}

export function readClaim(db: Database.Database, id: string): ClaimReading {
	const row = db.prepare("SELECT * FROM claim WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	if (row === undefined) throw new Error(`узла ${id} нет; идентификатор берётся из graph_search`);
	const asConclusion = db.prepare("SELECT id FROM chain WHERE conclusion_claim_id = ?").all(id) as { id: string }[];
	const asPremise = db.prepare("SELECT chain_id AS id FROM chain_premise WHERE claim_id = ?").all(id) as { id: string }[];
	return {
		aliases: (db.prepare("SELECT text FROM claim_alias WHERE claim_id = ? ORDER BY text").all(id) as { text: string }[]).map(
			(row) => row.text,
		),
		chains: chainRows(db, asConclusion.map((chain) => chain.id)),
		claim: rowToClaim(row),
		openDoubts: db
			.prepare("SELECT id, source, note FROM doubt WHERE claim_id = ? AND resolved_at IS NULL")
			.all(id) as { id: string; note: string | null; source: string }[],
		provenance: (
			db
				.prepare("SELECT id, claim_id, session_id, step_id, source_id, note FROM provenance WHERE claim_id = ? ORDER BY id")
				.all(id) as Record<string, unknown>[]
		).map((row) => ({
			claimId: row.claim_id as string,
			id: row.id as number,
			note: (row.note as string | null) ?? null,
			sessionId: (row.session_id as string | null) ?? null,
			sourceId: (row.source_id as string | null) ?? null,
			stepId: (row.step_id as string | null) ?? null,
		})),
		usedIn: chainRows(db, asPremise.map((chain) => chain.id)),
	};
}

/** A chain is the unit of joint sufficiency: the premises together, never one of
 *  them alone, imply the conclusion. An empty premise list would be a conclusion
 *  asserted from nothing, and a premise equal to its conclusion is a circle. */
export function addChain(
	db: Database.Database,
	input: { conclusionId: string; premiseIds: string[]; provenanceNote?: string },
): ChainRow {
	const premises = [...new Set(input.premiseIds)];
	if (premises.length === 0) {
		throw new Error("цепка без посылок — это утверждение ниоткуда; вывод держится на посылках вместе");
	}
	for (const id of [input.conclusionId, ...premises]) {
		if (!db.prepare("SELECT 1 FROM claim WHERE id = ?").get(id)) throw new Error(`узла ${id} нет в графе`);
	}
	if (premises.includes(input.conclusionId)) {
		throw new Error(`узел ${input.conclusionId} не может быть посылкой самого себя`);
	}

	const run = db.transaction((): ChainRow => {
		// The same premises and conclusion are the same chain: re-adding it would
		// double the graph's edges and make the plan count one support twice.
		const existing = db
			.prepare(
				`SELECT c.id AS id FROM chain c
				 WHERE c.conclusion_claim_id = ?
				   AND (SELECT COUNT(*) FROM chain_premise p WHERE p.chain_id = c.id) = ?
				   AND NOT EXISTS (
					 SELECT 1 FROM chain_premise p WHERE p.chain_id = c.id
					   AND p.claim_id NOT IN (${premises.map(() => "?").join(", ")})
				   )`,
			)
			.get(input.conclusionId, premises.length, ...premises) as { id: string } | undefined;
		const chainId = existing?.id ?? randomUUID();
		if (existing === undefined) {
			db.prepare("INSERT INTO chain (id, conclusion_claim_id, created_at) VALUES (?, ?, ?)").run(
				chainId,
				input.conclusionId,
				nowIso(),
			);
			premises.forEach((claimId, ordinal) => {
				db.prepare("INSERT INTO chain_premise (chain_id, claim_id, ordinal) VALUES (?, ?, ?)").run(chainId, claimId, ordinal + 1);
			});
			if (input.provenanceNote !== undefined) {
				db.prepare("INSERT INTO provenance (claim_id, note) VALUES (?, ?)").run(input.conclusionId, input.provenanceNote);
			}
		}
		return { conclusionId: input.conclusionId, id: chainId, premiseIds: premises };
	});
	return run();
}

/** Records where a claim came from, so a node is never an orphan without a source. */
export function addProvenance(
	db: Database.Database,
	input: { claimId: string; sessionId?: string; stepId?: string; sourceId?: string; note?: string },
): number {
	if (!db.prepare("SELECT 1 FROM claim WHERE id = ?").get(input.claimId)) throw new Error(`узла ${input.claimId} нет в графе`);
	const info = db
		.prepare("INSERT INTO provenance (claim_id, session_id, step_id, source_id, note) VALUES (?, ?, ?, ?, ?)")
		.run(
			input.claimId,
			input.sessionId ?? null,
			input.stepId ?? null,
			input.sourceId ?? null,
			input.note ?? null,
		);
	return Number(info.lastInsertRowid);
}

/**
 * Removes a node. Chains are the reason a deletion can be refused: a premise of a
 * live chain would leave the chain implying its conclusion from fewer grounds than
 * it claims, and a conclusion with chains left behind would keep supports pointing
 * at nothing. The caller has to remove those chains first and say what it is doing.
 *
 * Everything that only *refers* to the node (provenance, doubts, aliases, its
 * embedding, repetition items) goes with it by cascade — the caller does not have
 * to know that list, and the test runs `foreign_key_check` after it.
 */
export function deleteClaim(db: Database.Database, id: string): void {
	if (!db.prepare("SELECT 1 FROM claim WHERE id = ?").get(id)) throw new Error(`узла ${id} нет; идентификатор берётся из graph_search`);
	const asConclusion = (db.prepare("SELECT id FROM chain WHERE conclusion_claim_id = ?").all(id) as { id: string }[]).map(
		(chain) => chain.id,
	);
	const asPremise = (db.prepare("SELECT chain_id AS id FROM chain_premise WHERE claim_id = ?").all(id) as { id: string }[]).map(
		(chain) => chain.id,
	);
	if (asConclusion.length > 0 || asPremise.length > 0) {
		const parts: string[] = [];
		if (asConclusion.length > 0) parts.push(`вывод ${asConclusion.join(", ")}`);
		if (asPremise.length > 0) parts.push(`посылка ${asPremise.join(", ")}`);
		throw new Error(
			`узел ${id} стоит в цепках: ${parts.join(" и ")} — сначала удали их, иначе цепка останется держаться на меньшем числе оснований`,
		);
	}
	db.prepare("DELETE FROM claim WHERE id = ?").run(id);
}

/** Removes a chain: the joint claim that its premises implied. Its premise links
 *  go with it; the nodes stay, they are the graph's memory. */
export function deleteChain(db: Database.Database, id: string): void {
	if (!db.prepare("SELECT 1 FROM chain WHERE id = ?").get(id)) throw new Error(`цепки ${id} нет`);
	db.prepare("DELETE FROM chain WHERE id = ?").run(id);
}

export function claimExists(db: Database.Database, id: string): boolean {
	return db.prepare("SELECT 1 FROM claim WHERE id = ?").get(id) !== undefined;
}

export type LexicalHit = { id: string; text: string; rank: number };

/** Lexical search over the canonical wording of nodes. bm25 is a cost: the smaller,
 *  the better, so plain ascending order ranks best first. Aliases are not indexed:
 *  a wording that reached the graph as an alias is stored once on its node, and the
 *  node is found by its canonical text. */
export function searchClaimsLexical(db: Database.Database, query: string, limit = 20): LexicalHit[] {
	const needle = query.trim();
	if (needle === "") throw new Error("пустой запрос поиска");
	// Words are joined with OR: a learner's phrase usually misses a word of the
	// stored wording, and a search that requires all of them answers «ничего не
	// найдено». bm25 still puts the node with more matching words first.
	const match = needle
		.split(/\s+/u)
		.filter((word) => word !== "")
		.map((word) => `"${word.replaceAll('"', "")}"`)
		.join(" OR ");
	const rows = db
		.prepare(
			`SELECT c.id AS id, c.text AS text, bm25(claim_fts) AS rank
			 FROM claim_fts f JOIN claim c ON c.id = f.claim_id
			 WHERE claim_fts MATCH ?
			 ORDER BY rank LIMIT ?`,
		)
		.all(match, limit) as { id: string; rank: number; text: string }[];
	return rows;
}

/** Nodes newest first, for a library screen that has to open without a query.
 *  Offset rather than cursor: the library is browsed by a person, not synced. */
export function listClaims(db: Database.Database, input: { limit?: number; offset?: number } = {}): ClaimRow[] {
	const limit = input.limit ?? 50;
	const offset = input.offset ?? 0;
	const rows = db
		.prepare("SELECT * FROM claim ORDER BY updated_at DESC, id LIMIT ? OFFSET ?")
		.all(limit, offset) as Record<string, unknown>[];
	return rows.map(rowToClaim);
}

/** Count of nodes, for the interactive-size guard the acceptance names. */
export function countClaims(db: Database.Database): number {
	return (db.prepare("SELECT COUNT(*) AS n FROM claim").get() as { n: number }).n;
}
