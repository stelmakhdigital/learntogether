// Diagnostics: a fixed-size ring of recent events plus the durable `event`
// table. The ring answers "what just happened" without touching the database;
// the table answers "what happened last week" and survives a restart.
//
// Nothing private goes in either: no keys, no prompt bodies, no model output.
// Callers pass identifiers and a short fact, not content.

import type Database from "better-sqlite3";

export type EventLevel = "debug" | "info" | "warning" | "error";

export interface LogRecord {
	at: string;
	level: EventLevel;
	kind: string;
	message: string;
	sessionId: string | null;
}

const MAX_MESSAGE = 400;

/** Keep the tail: when a message is too long, the end carries the reason. */
function clip(text: string): string {
	return text.length <= MAX_MESSAGE ? text : `…${text.slice(-MAX_MESSAGE)}`;
}

export class Ring {
	private items: (LogRecord | undefined)[] = [];
	private start = 0;
	private readonly capacity: number;

	constructor(capacity = 500) {
		if (capacity < 1) throw new Error(`ring capacity must be positive, got ${capacity}`);
		this.capacity = capacity;
	}

	get size(): number {
		return this.items.filter((item) => item !== undefined).length;
	}

	push(record: LogRecord): void {
		if (this.items.length < this.capacity) {
			this.items.push(record);
			return;
		}
		this.items[this.start] = record;
		this.start = (this.start + 1) % this.capacity;
	}

	/** Oldest first — what a human reads when asking "what led to this". */
	toArray(): LogRecord[] {
		if (this.items.length < this.capacity) return this.items.filter((item) => item !== undefined) as LogRecord[];
		return [
			...this.items.slice(this.start),
			...this.items.slice(0, this.start),
		].filter((item) => item !== undefined) as LogRecord[];
	}

	clear(): void {
		this.items = [];
		this.start = 0;
	}
}

/** Durable copy in the `event` table: `kind` plus a JSON payload holding the
 *  level and the text. Separate from the ring so a failing insert stays visible. */
export class EventWriter {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	write(record: LogRecord): void {
		this.db
			.prepare("INSERT INTO event (session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
			.run(
				record.sessionId,
				record.kind,
				JSON.stringify({ level: record.level, message: record.message }),
				record.at,
			);
	}

	recent(limit = 100, level?: EventLevel): LogRecord[] {
		const rows =
			level === undefined
				? this.db.prepare("SELECT * FROM event ORDER BY id DESC LIMIT ?").all(limit)
				: this.db
					.prepare(
						"SELECT * FROM event WHERE json_extract(payload_json, '$.level') = ? ORDER BY id DESC LIMIT ?",
					)
					.all(level, limit);
		return (rows as Record<string, unknown>[]).map((row) => {
			const payload = JSON.parse(String(row.payload_json)) as { level?: string; message?: string };
			return {
				at: String(row.created_at),
				level: (payload.level ?? "info") as EventLevel,
				kind: String(row.kind),
				message: String(payload.message ?? ""),
				sessionId: (row.session_id as string | null) ?? null,
			};
		});
	}

	/** Drop diagnostics older than a moment; the export never carries them anyway. */
	pruneOlderThan(iso: string): number {
		return this.db.prepare("DELETE FROM event WHERE created_at < ?").run(iso).changes;
	}
}

/** The one object the rest of the server calls: ring always, table when it exists. */
export class Diagnostics {
	readonly ring: Ring;
	private writer: EventWriter | null;

	constructor(options: { capacity?: number; db?: Database.Database } = {}) {
		this.ring = new Ring(options.capacity);
		this.writer = options.db ? new EventWriter(options.db) : null;
	}

	record(level: EventLevel, kind: string, message: string, sessionId: string | null = null): void {
		const record: LogRecord = { at: new Date().toISOString(), level, kind, message: clip(message), sessionId };
		this.ring.push(record);
		this.writer?.write(record);
	}

	debug(kind: string, message: string, sessionId?: string): void {
		this.record("debug", kind, message, sessionId ?? null);
	}

	info(kind: string, message: string, sessionId?: string): void {
		this.record("info", kind, message, sessionId ?? null);
	}

	warning(kind: string, message: string, sessionId?: string): void {
		this.record("warning", kind, message, sessionId ?? null);
	}

	error(kind: string, message: string, sessionId?: string): void {
		this.record("error", kind, message, sessionId ?? null);
	}

	recent(limit = 100): LogRecord[] {
		return this.ring.toArray().slice(-limit);
	}
}
