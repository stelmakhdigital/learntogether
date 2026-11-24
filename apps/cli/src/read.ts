// Read-only connection for external analysis. This is the only way the CLI opens
// a database: there is no write path here at all, so a mistake in a query cannot
// damage the store (docs/export-format.md, «Read-only CLI»).

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

export function openReadonly(file: string): Database.Database {
	if (file === ":memory:") throw new Error("read-only mode needs a database file, :memory: is writable");
	const db = new BetterSqlite3(file, { fileMustExist: true, readonly: true });
	db.pragma("foreign_keys = ON");
	return db;
}
