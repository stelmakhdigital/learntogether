import type Database from "better-sqlite3";

// Where a node sits on the screen (D-079). Nothing in the method reads this: the
// teacher's context never asks where a claim was drawn, so a re-layout cannot change
// what the learner is taught. It is stored because a person arranged it by hand.

export type NodePosition = { hidden: boolean; nodeId: string; x: number; y: number };

export type GraphEdge = { from: string; to: string };

function nowIso(): string {
	return new Date().toISOString();
}

export function nodePositions(db: Database.Database): Map<string, NodePosition> {
	const rows = db.prepare("SELECT node_id, x, y, hidden FROM node_position").all() as {
		hidden: number;
		node_id: string;
		x: number;
		y: number;
	}[];
	const positions = new Map<string, NodePosition>();
	for (const row of rows) {
		positions.set(row.node_id, { hidden: row.hidden === 1, nodeId: row.node_id, x: row.x, y: row.y });
	}
	return positions;
}

/** Positions are written as given, in one transaction: a half-saved drag leaves a
 *  node in two places at once, which is exactly what the learner will notice. */
export function saveNodePositions(db: Database.Database, positions: { nodeId: string; x: number; y: number }[]): void {
	if (positions.length === 0) return;
	const write = db.prepare(
		`INSERT INTO node_position (node_id, x, y, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
	);
	const known = db.prepare("SELECT 1 FROM claim WHERE id = ?");
	const run = db.transaction((rows: { nodeId: string; x: number; y: number }[]) => {
		for (const row of rows) {
			if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) {
				throw new Error(`позиция узла ${row.nodeId} не число: x=${row.x}, y=${row.y}`);
			}
			if (!known.get(row.nodeId)) throw new Error(`узла ${row.nodeId} нет в графе — позицию писать некуда`);
			write.run(row.nodeId, row.x, row.y, nowIso());
		}
	});
	run(positions);
}

/** Hiding a node is a reading choice, not a deletion: the node keeps its chains and
 *  its provenance, and the queue of practice still sees it. */
export function hideNode(db: Database.Database, nodeId: string, hidden: boolean): void {
	const result = db.prepare("UPDATE node_position SET hidden = ?, updated_at = ? WHERE node_id = ?").run(
		hidden ? 1 : 0,
		nowIso(),
		nodeId,
	);
	if (result.changes === 0) throw new Error(`у узла ${nodeId} нет позиции — сначала поставь его на экран`);
}

export function graphSettings(db: Database.Database): Record<string, string> {
	const rows = db.prepare("SELECT key, value FROM graph_setting").all() as { key: string; value: string }[];
	const settings: Record<string, string> = {};
	for (const row of rows) settings[row.key] = row.value;
	return settings;
}

export function saveGraphSetting(db: Database.Database, key: string, value: string): void {
	if (key.trim() === "") throw new Error("пустой ключ настройки графа");
	db.prepare(
		`INSERT INTO graph_setting (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(key, value, nowIso());
}

/** Edges for a set of nodes, derived from chains: a premise points at what it holds
 *  up. Nodes outside the set are dropped — a map of what is on screen, not of the
 *  whole graph. */
export function graphEdges(db: Database.Database, nodeIds: string[]): GraphEdge[] {
	if (nodeIds.length === 0) return [];
	const placeholders = nodeIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT cp.claim_id AS from_id, c.conclusion_claim_id AS to_id
			 FROM chain_premise cp JOIN chain c ON c.id = cp.chain_id
			 WHERE cp.claim_id IN (${placeholders}) AND c.conclusion_claim_id IN (${placeholders})`,
		)
		.all(...nodeIds, ...nodeIds) as { from_id: string; to_id: string }[];
	return rows.map((row) => ({ from: row.from_id, to: row.to_id }));
}
