// Readable export: SQLite stays the only source of truth, these files are a
// derived view (D-002). Byte-identical reruns are the point — a human may keep
// them in git and tell their own edit from a data change (docs/export-format.md).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getSession } from "../repos/sessions.ts";
import { checksForStep, stepsForSession } from "../repos/steps.ts";

type Row = Record<string, unknown>;

function all(db: Database.Database, sql: string, ...params: unknown[]): Row[] {
	return db.prepare(sql).all(...params) as Row[];
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			if (source[key] === undefined) continue;
			out[key] = sortKeys(source[key]);
		}
		return out;
	}
	return value;
}

/** One JSONL record: keys alphabetical, no newline inside the record. */
function jsonLine(value: unknown): string {
	const json = JSON.stringify(sortKeys(value));
	return json === undefined ? "null" : json;
}

function jsonList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function parseJson(text: unknown): unknown {
	if (typeof text !== "string" || text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		// A stored value we cannot read is a data bug, not a reason to print
		// "null" and hide it.
		throw new Error(`не читается JSON в экспортируемом поле: ${text.slice(0, 60)}`);
	}
}

/** `endpoint/model` as stored on the session, plus when it was measured. */
function probedAt(db: Database.Database, modelTeacher: string): string | null {
	const row = all(
		db,
		"SELECT probed_at FROM model_info WHERE endpoint_id || '/' || model_id = ?",
		modelTeacher,
	)[0];
	return typeof row?.probed_at === "string" ? row.probed_at : null;
}

const CHECK_KIND_RU: Record<string, string> = {
	single_choice: "один вариант",
	multi_choice: "несколько вариантов",
	free_recall: "свободное припоминание",
	predict: "предсказание",
	find_error: "поиск ошибки",
	transfer: "перенос",
};

export function renderSession(db: Database.Database, sessionId: string): string {
	const session = getSession(db, sessionId);
	if (session === undefined) throw new Error(`сессия не найдена: ${sessionId}`);

	const goal =
		session.goalId === null
			? undefined
			: all(db, "SELECT raw, ready_when FROM goal WHERE id = ?", session.goalId)[0];
	const title = typeof goal?.raw === "string" && goal.raw !== "" ? goal.raw : `Сессия ${session.kind}`;

	const out: string[] = [`# ${title}`, "", `- Идентификатор: ${session.id}`, `- Создана: ${session.createdAt}`];
	if (session.modelTeacher !== null) {
		out.push(`- Модель учителя: ${session.modelTeacher}`);
	}
	if (session.contextLimit !== null) {
		const measured = session.modelTeacher === null ? null : probedAt(db, session.modelTeacher);
		out.push(
			measured === null
				? `- Контекст: ${session.contextLimit}`
				: `- Контекст: ${session.contextLimit} (измерено: ${measured})`,
		);
	}
	if (session.closedAt !== null) {
		out.push(`- Закрыта: ${session.closedAt}`);
	}
	out.push("");

	const steps = stepsForSession(db, sessionId);
	if (steps.length === 0) {
		out.push("Шагов нет.", "");
	}
	for (const step of steps) {
		out.push(`## Шаг ${step.ordinal} — ${step.statement}`, "", step.statement, "");
		if (step.motivation !== null) out.push(`Зачем: ${step.motivation}`, "");
		if (step.premises.length > 0) out.push(`Посылки: ${step.premises.join(", ")}`, "");

		const checks = checksForStep(db, step.id);
		if (checks.length === 0) {
			out.push("> Проверок нет.", "");
			continue;
		}
		for (const check of checks) {
			const kind = CHECK_KIND_RU[check.kind] ?? check.kind;
			out.push(`> Проверка (${kind}): ${check.question}`);
			if (check.learnerAnswer !== null && check.verdict !== null) {
				const confidence = check.confidence === null ? "" : `, уверенность ${check.confidence}`;
				out.push(`> Ответ: ${JSON.stringify(check.learnerAnswer)} — ${check.verdict}${confidence}`);
			} else {
				out.push("> Ответ: нет");
			}
			if (check.hints > 0) out.push(`> Подсказок: ${check.hints}`);
			if (check.why !== null) out.push(`> Почему: ${check.why}`);
		}
		out.push("");
	}

	// A silently missing turn is worse than an ugly section: failed calls print here.
	const failed = all(
		db,
		"SELECT name, error FROM tool_call WHERE session_id = ? AND state = 'failed' ORDER BY created_at, id",
		sessionId,
	);
	if (failed.length > 0) {
		out.push("## Ошибки вызовов", "");
		for (const call of failed) {
			out.push(`- ${String(call.name)}: ${String(call.error ?? "текст ошибки не сохранён")}`);
		}
		out.push("");
	}

	return out.join("\n");
}

export function renderGraph(db: Database.Database): { claims: string; chains: string; doubts: string } {
	const claims = all(db, "SELECT id, text, area, tags_json, created_at, updated_at FROM claim ORDER BY id");
	const claimLines = claims.map((claim) => {
		const id = String(claim.id);
		const aliases = all(db, "SELECT text FROM claim_alias WHERE claim_id = ? ORDER BY text", id).map((row) =>
			String(row.text),
		);
		const provenance = all(
			db,
			"SELECT session_id, step_id, source_id FROM provenance WHERE claim_id = ? ORDER BY id",
			id,
		);
		const doubts = all(
			db,
			"SELECT id, source, note, created_at FROM doubt WHERE claim_id = ? AND resolved_at IS NULL ORDER BY id",
			id,
		);
		const repetition = all(
			db,
			"SELECT method, due_at, reps, lapses, last_rating FROM repeat_item WHERE claim_id = ? ORDER BY method",
			id,
		);
		return jsonLine({
			aliases,
			area: claim.area ?? null,
			created_at: claim.created_at,
			doubt: doubts,
			id,
			provenance,
			repetition,
			tags: jsonList(parseJson(claim.tags_json)),
			text: claim.text,
			updated_at: claim.updated_at,
		});
	});

	const chains = all(db, "SELECT id, conclusion_claim_id, created_at FROM chain ORDER BY id").map((chain) => {
		const id = String(chain.id);
		const premises = all(
			db,
			"SELECT claim_id FROM chain_premise WHERE chain_id = ? ORDER BY ordinal",
			id,
		).map((row) => String(row.claim_id));
		return jsonLine({
			conclusion: chain.conclusion_claim_id,
			created_at: chain.created_at,
			id,
			premises,
		});
	});

	const doubts = all(
		db,
		"SELECT id, claim_id, source, note, created_at FROM doubt WHERE resolved_at IS NULL ORDER BY id",
	).map((doubt) => jsonLine(doubt));

	return {
		claims: claimLines.length === 0 ? "" : `${claimLines.join("\n")}\n`,
		chains: chains.length === 0 ? "" : `${chains.join("\n")}\n`,
		doubts: doubts.length === 0 ? "" : `${doubts.join("\n")}\n`,
	};
}

/** Practice queue: what comes due, in the order the learner would meet it. */
export function renderQueue(db: Database.Database): string {
	const items = all(
		db,
		`SELECT r.id, r.method, r.due_at, r.reps, r.lapses, c.text
		   FROM repeat_item r JOIN claim c ON c.id = r.claim_id
		  ORDER BY (r.due_at IS NULL), r.due_at, r.id`,
	);
	if (items.length === 0) return "Очереди повторов нет.\n";
	const out = ["# Очередь повторов", ""];
	for (const item of items) {
		const due = item.due_at === null ? "срок не назначен" : String(item.due_at);
		out.push(`- ${due} — ${String(item.method)}: ${String(item.text)}`);
	}
	out.push("");
	return out.join("\n");
}

/** Write via a sibling temp file and rename: a reader never sees a half file. */
function writeAtomic(dir: string, relative: string, content: string): void {
	const target = path.join(dir, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, target);
}

function renderIndex(
	db: Database.Database,
	dir: string,
	exportedAt: string,
	written: string[],
): string {
	const sessions = all(
		db,
		"SELECT id, kind, state, created_at FROM session ORDER BY created_at, id",
	);
	const counts = {
		утверждения: all(db, "SELECT id FROM claim").length,
		цепочки: all(db, "SELECT id FROM chain").length,
		зоны_сомнения: all(db, "SELECT id FROM doubt WHERE resolved_at IS NULL").length,
		повторы: all(db, "SELECT id FROM repeat_item").length,
	};
	const out = ["# Указатель экспорта", "", `- Экспорт: ${exportedAt}`, ""];
	out.push(
		`Данные: утверждений ${counts.утверждения}, цепочек ${counts.цепочки}, открытых зон сомнения ${counts.зоны_сомнения}, элементов повторов ${counts.повторы}.`,
		"",
	);
	if (sessions.length === 0) {
		out.push("Сессий нет.", "");
	} else {
		out.push("## Сессии", "");
		for (const session of sessions) {
			out.push(
				`- ${String(session.created_at)} — ${String(session.id)} (${String(session.kind)}, ${String(session.state)}) — sessions/${String(session.id)}.md`,
			);
		}
		out.push("");
	}
	out.push("## Файлы", "");
	for (const file of [...written].sort()) out.push(`- ${file}`);
	out.push("");

	// Nothing sensitive belongs in the export (docs/export-format.md, «Чего в
	// экспорте нет»): keys, server settings, vectors and raw traces stay out.
	void dir;
	return out.join("\n");
}

/** Writes sessions, graph, queue and INDEX.md under `dir`; returns the written
 *  relative paths. `exportedAt` reaches INDEX.md only. */
export function exportAll(db: Database.Database, dir: string, exportedAt: string): string[] {
	const written: string[] = [];

	const sessions = all(db, "SELECT id FROM session ORDER BY created_at, id");
	for (const session of sessions) {
		const id = String(session.id);
		writeAtomic(dir, `sessions/${id}.md`, renderSession(db, id));
		written.push(`sessions/${id}.md`);
	}

	const graph = renderGraph(db);
	writeAtomic(dir, "graph/claims.jsonl", graph.claims);
	writeAtomic(dir, "graph/chains.jsonl", graph.chains);
	writeAtomic(dir, "graph/doubts.jsonl", graph.doubts);
	written.push("graph/claims.jsonl", "graph/chains.jsonl", "graph/doubts.jsonl");

	writeAtomic(dir, "practice/queue.md", renderQueue(db));
	written.push("practice/queue.md");

	// INDEX.md names itself only after it is written.
	const withoutIndex = [...written];
	writeAtomic(dir, "INDEX.md", renderIndex(db, dir, exportedAt, withoutIndex));
	written.push("INDEX.md");

	return written;
}
