import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

type MigrationRow = { name: string; checksum: string | null };

function checksumOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function columnsOf(db: Database.Database, table: string): string[] {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.map((column) => column.name);
}

// 001_init.sql creates `migration` itself, without a `checksum` column, so the
// bookkeeping cannot live in a .sql file: the table is created here only when
// it is still missing, and existing databases get the column via ALTER.
// shortcut: rows recorded before checksums exist stay NULL and are not
// verified; drop once no pre-checksum database is in the wild.
function ensureMigrationTable(db: Database.Database): void {
	const columns = columnsOf(db, "migration");
	if (columns.length === 0) {
		db.exec("CREATE TABLE migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT)");
	} else if (!columns.includes("checksum")) {
		db.exec("ALTER TABLE migration ADD COLUMN checksum TEXT");
	}
}

// Applies `*.sql` files from dir in name order, each inside one transaction
// together with its bookkeeping row. Returns the names applied by this call.
export function migrate(db: Database.Database, dir = "packages/data/migrations"): string[] {
	const applied = new Map<string, string | null>();
	if (columnsOf(db, "migration").length > 0) {
		ensureMigrationTable(db);
		const rows = db.prepare("SELECT name, checksum FROM migration").all() as MigrationRow[];
		for (const row of rows) applied.set(row.name, row.checksum);
	}

	const appliedNow: string[] = [];
	const names = readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort();
	for (const name of names) {
		const content = readFileSync(path.join(dir, name), "utf8");
		const checksum = checksumOf(content);
		if (applied.has(name)) {
			const stored = applied.get(name);
			if (stored !== null && stored !== checksum) {
				throw new Error(`migration checksum mismatch: ${name}`);
			}
			continue;
		}
		db.transaction(() => {
			db.exec(content);
			ensureMigrationTable(db);
			db.prepare("INSERT INTO migration (name, applied_at, checksum) VALUES (?, ?, ?)").run(
				name,
				new Date().toISOString(),
				checksum,
			);
		})();
		appliedNow.push(name);
	}
	return appliedNow;
}
