import Database from "better-sqlite3";

// SQLite is the single source of truth (decision D-002); every caller opens
// the database through this function so the pragmas below always hold.
export function openDb(path: string): Database.Database {
	const db = new Database(path);
	db.pragma("journal_mode = 'wal'");
	db.pragma("foreign_keys = 'on'");
	db.pragma("busy_timeout = 5000");
	return db;
}
