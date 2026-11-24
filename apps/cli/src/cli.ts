// Read-only CLI over the store. Text output only: it is meant for `less`, `grep`
// and for a person checking what the app remembers about them.

import { getSession, searchEntries, stepsForSession, checksForStep } from "@learntogether/data";
import type Database from "better-sqlite3";
import { openReadonly } from "./read.ts";

const HELP = `learntogether — доступ только для чтения

  --db <файл>            база (по умолчанию LTH_DB или ~/.config/learntogether/learntogether.db)
  sessions [--limit N]   список сессий
  session <id>           шаги и проверки сессии
  search <текст>         полнотекстовый поиск по транскрипту
  queue                  очередь повторов
  help                   этот текст
`;

type Row = Record<string, unknown>;

function rows(db: Database.Database, sql: string, ...params: unknown[]): Row[] {
	return db.prepare(sql).all(...params) as Row[];
}

export function sessions(db: Database.Database, limit = 20): string {
	const list = rows(
		db,
		`SELECT s.id, s.kind, s.state, s.created_at, s.model_teacher,
		        (SELECT COUNT(*) FROM step WHERE session_id = s.id) AS steps
		   FROM session s ORDER BY s.created_at DESC LIMIT ?`,
		limit,
	);
	if (list.length === 0) return "Сессий нет.";
	return list
		.map((row) => `${String(row.created_at)}  ${String(row.id)}  ${String(row.kind)}  ${String(row.state)}  шагов ${String(row.steps)}  ${String(row.model_teacher ?? "модель не записана")}`)
		.join("\n");
}

export function session(db: Database.Database, id: string): string {
	const found = getSession(db, id);
	if (found === undefined) return `Сессия не найдена: ${id}`;
	const out = [`Сессия ${id}`, `состояние: ${found.state}`, `создана: ${found.createdAt}`];
	if (found.modelTeacher !== null) out.push(`модель учителя: ${found.modelTeacher}`);
	if (found.contextLimit !== null) out.push(`контекст: ${found.contextLimit}`);

	const steps = stepsForSession(db, id);
	if (steps.length === 0) {
		out.push("", "Шагов нет.");
		return out.join("\n");
	}
	for (const step of steps) {
		out.push("", `Шаг ${step.ordinal} [${step.state}] ${step.statement}`);
		for (const check of checksForStep(db, step.id)) {
			const answer = check.learnerAnswer === null ? "нет ответа" : JSON.stringify(check.learnerAnswer);
			out.push(`  проверка (${check.kind}) ${check.question} → ${answer}${check.verdict ? `, ${check.verdict}` : ""}`);
		}
	}
	return out.join("\n");
}

export function search(db: Database.Database, query: string, sessionId?: string): string {
	const hits = searchEntries(db, query, sessionId === undefined ? { limit: 20 } : { limit: 20, sessionId });
	if (hits.length === 0) return "Совпадений нет.";
	return hits.map((hit) => `${hit.sessionId} #${hit.ordinal} ${hit.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
}

export function queue(db: Database.Database): string {
	const list = rows(
		db,
		`SELECT r.due_at, r.method, r.reps, r.lapses, c.text
		   FROM repeat_item r JOIN claim c ON c.id = r.claim_id
		  ORDER BY (r.due_at IS NULL), r.due_at, r.id`,
	);
	if (list.length === 0) return "Очередь пуста.";
	return list
		.map((row) => `${String(row.due_at ?? "срок не назначен")}  ${String(row.method)}  повторов ${String(row.reps)}  срывов ${String(row.lapses)}  ${String(row.text)}`)
		.join("\n");
}

export function run(dbFile: string, args: string[]): string {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || command === "--help") return HELP;

	const db = openReadonly(dbFile);
	try {
		switch (command) {
			case "sessions":
				return sessions(db, rest[0] === "--limit" ? Number(rest[1]) : 20);
			case "session":
				if (rest[0] === undefined) throw new Error("нужен идентификатор сессии");
				return session(db, rest[0]);
			case "search":
				if (rest[0] === undefined) throw new Error("нужен текст запроса");
				return search(db, rest.join(" "));
			case "queue":
				return queue(db);
			default:
				throw new Error(`неизвестная команда "${command}"; напиши help`);
		}
	} finally {
		db.close();
	}
}

const invokedAs = process.argv[1]?.endsWith("cli/src/cli.ts") ?? false;
if (invokedAs) {
	const argv = process.argv.slice(2);
	const dbFlag = argv.indexOf("--db");
	const dbFile = (dbFlag >= 0 ? argv[dbFlag + 1] : undefined) ?? process.env.LTH_DB ?? "";
	const args = dbFlag >= 0 ? [...argv.slice(0, dbFlag), ...argv.slice(dbFlag + 2)] : argv;
	try {
		if (dbFile === "") throw new Error("не указан файл базы: --db <файл> или LTH_DB");
		process.stdout.write(`${run(dbFile, args)}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
