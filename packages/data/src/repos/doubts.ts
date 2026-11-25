import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// Mirrors the CHECK constraint on doubt.source in 001_init.sql.
export const DOUBT_SOURCES = ["check_failed", "contradicted", "missed_transfer", "calibration"] as const;
export type DoubtSource = (typeof DOUBT_SOURCES)[number];

export type DoubtRow = {
	id: string;
	claimId: string;
	source: DoubtSource;
	note: string | null;
	createdAt: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function rowToDoubt(row: Record<string, unknown>): DoubtRow {
	return {
		id: row.id as string,
		claimId: row.claim_id as string,
		source: row.source as DoubtSource,
		note: row.note as string | null,
		createdAt: row.created_at as string,
	};
}

/** Adds a doubt about a claim. Repeating the same (claim, source) while the
 *  earlier one is still open returns the existing id: one failing check must
 *  not pile up identical doubts. */
export function addDoubt(db: Database.Database, input: { claimId: string; source: DoubtSource; note?: string }): string {
	if (!DOUBT_SOURCES.includes(input.source)) {
		throw new Error(`unknown doubt source "${input.source}"; allowed: ${DOUBT_SOURCES.join(", ")}`);
	}
	const claim = db.prepare("SELECT 1 FROM claim WHERE id = ?").get(input.claimId);
	if (!claim) throw new Error(`claim not found: ${input.claimId}`);

	const run = db.transaction((): string => {
		const existing = db
			.prepare("SELECT id FROM doubt WHERE claim_id = ? AND source = ? AND resolved_at IS NULL")
			.get(input.claimId, input.source) as { id: string } | undefined;
		if (existing) return existing.id;
		const id = randomUUID();
		db.prepare("INSERT INTO doubt (id, claim_id, source, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
			id,
			input.claimId,
			input.source,
			input.note ?? null,
			nowIso(),
		);
		return id;
	});
	return run();
}

/** Open doubts, by id; optionally only for one claim. */
export function openDoubts(db: Database.Database, claimId?: string): DoubtRow[] {
	const sql = claimId === undefined
		? "SELECT id, claim_id, source, note, created_at FROM doubt WHERE resolved_at IS NULL ORDER BY id ASC"
		: "SELECT id, claim_id, source, note, created_at FROM doubt WHERE resolved_at IS NULL AND claim_id = ? ORDER BY id ASC";
	const rows = (claimId === undefined
		? db.prepare(sql).all()
		: db.prepare(sql).all(claimId)) as Record<string, unknown>[];
	return rows.map(rowToDoubt);
}

export function resolveDoubt(db: Database.Database, id: string): void {
	const row = db.prepare("SELECT resolved_at FROM doubt WHERE id = ?").get(id) as
		| { resolved_at: string | null }
		| undefined;
	if (!row) throw new Error(`doubt not found: ${id}`);
	if (row.resolved_at !== null) throw new Error(`doubt ${id} is already resolved`);
	db.prepare("UPDATE doubt SET resolved_at = ? WHERE id = ?").run(nowIso(), id);
}
