// Очередь практики поверх графа (D-009): элемент = узел + форма (припоминание,
// рассуждение, перенос). Перенос проверяется отдельно от припоминания: узел может
// быть стабилен на одном и мёртв на другом.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { elapsedDays, newRepeatCard, retrievability, reviewRepeat, type Rating, type RepeatCard } from "@learntogether/domain";

export const REPEAT_METHODS = ["recall", "reasoning", "transfer"] as const;
export type RepeatMethod = (typeof REPEAT_METHODS)[number];

export type QueueRow = {
	claimId: string;
	claimText: string;
	dueAt: string | null;
	/** true — раньше срока: очередь пустая, и это единственный способ не выдать пустой день. */
	early: boolean;
	hasDoubt: boolean;
	itemId: string;
	method: RepeatMethod;
};

type ItemRow = {
	claim_id: string;
	difficulty: number | null;
	lapses: number;
	last_rating: Rating | null;
	last_review_at: string | null;
	reps: number;
	stability: number | null;
	state: RepeatCard["state"];
};

function nowIso(): string {
	return new Date().toISOString();
}

/** Элемент практики для узла в конкретной форме. Повторный вызов — это тот же
 *  элемент (UNIQUE (claim_id, method)), а не вторая карточка на один узел. */
export function createRepeatItem(db: Database.Database, input: { claimId: string; method: RepeatMethod }): string {
	if (!REPEAT_METHODS.includes(input.method)) {
		throw new Error(`форма повторения "${input.method}" неизвестна; нужны ${REPEAT_METHODS.join(", ")}`);
	}
	if (!db.prepare("SELECT 1 FROM claim WHERE id = ?").get(input.claimId)) throw new Error(`узла ${input.claimId} нет в графе`);
	const existing = db.prepare("SELECT id FROM repeat_item WHERE claim_id = ? AND method = ?").get(input.claimId, input.method) as
		| { id: string }
		| undefined;
	if (existing !== undefined) return existing.id;
	const id = randomUUID();
	db.prepare(
		"INSERT INTO repeat_item (id, claim_id, method, state, due_at, created_at) VALUES (?, ?, ?, 'new', NULL, ?)",
	).run(id, input.claimId, input.method, nowIso());
	return id;
}

function cardOf(row: ItemRow): RepeatCard {
	if (row.stability === null || row.difficulty === null) return newRepeatCard();
	return {
		dueAt: null,
		lapses: row.lapses,
		lastRating: row.last_rating,
		lastReviewAt: row.last_review_at,
		memory: { difficulty: row.difficulty, stability: row.stability },
		reps: row.reps,
		state: row.state,
	};
}

/** Один повтор элемента: попытка уходит в attempt, состояние планировщика — в
 *  repeat_item. Вердикт попытки выводится из оценки, а не принимается извне: иначе
 *  «частично» и «снова» разошлись бы по разным полям одного события. */
export function reviewRepeatItem(
	db: Database.Database,
	itemId: string,
	input: { at?: string; rating: Rating; problemId?: string; verdictNote?: string },
): { card: RepeatCard; intervalDays: number | null; minutes: number | null } {
	const row = db.prepare("SELECT * FROM repeat_item WHERE id = ?").get(itemId) as (ItemRow & { id: string; claim_id: string }) | undefined;
	if (row === undefined) throw new Error(`элемента практики ${itemId} нет`);
	const at = input.at ?? nowIso();
	const outcome = reviewRepeat(cardOf(row), input.rating, at);
	const verdict = input.rating === "again" ? "incorrect" : input.rating === "hard" ? "partial" : "correct";

	const run = db.transaction((): void => {
		db.prepare(
			`UPDATE repeat_item
			 SET stability = ?, difficulty = ?, due_at = ?, last_rating = ?, reps = ?, lapses = ?, state = ?, last_review_at = ?
			 WHERE id = ?`,
		).run(
			outcome.card.memory.stability,
			outcome.card.memory.difficulty,
			outcome.card.dueAt,
			input.rating,
			outcome.card.reps,
			outcome.card.lapses,
			outcome.card.state,
			at,
			itemId,
		);
		db.prepare(
			"INSERT INTO attempt (id, repeat_item_id, session_id, claim_id, problem_id, verdict, rating, note, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
		).run(randomUUID(), itemId, row.claim_id, input.problemId ?? null, verdict, input.rating, input.verdictNote ?? null, at);
	});
	run();
	return outcome;
}

/** Один прогон очереди: узел не встречается дважды. */
function claimIdsOfChain(db: Database.Database, claimId: string): string[] {
	const rows = db
		.prepare(
			`SELECT DISTINCT x.other
			 FROM (
			       SELECT p.claim_id AS other FROM chain c JOIN chain_premise p ON p.chain_id = c.id WHERE c.conclusion_claim_id = ?
			       UNION ALL
			       SELECT c.conclusion_claim_id FROM chain c JOIN chain_premise p ON p.chain_id = c.id WHERE p.claim_id = ?
			       UNION ALL
			       SELECT p2.claim_id FROM chain_premise p1 JOIN chain_premise p2 ON p2.chain_id = p1.chain_id WHERE p1.claim_id = ? AND p2.claim_id <> ?
			     ) AS x
			 WHERE x.other <> ?`,
		)
		.all(claimId, claimId, claimId, claimId, claimId) as { other: string }[];
	return rows.map((row) => row.other);
}

/**
 * Очередь практики. Порядок: узлы с открытым сомнением, потом созревшие по давности,
 * потом новые (у них срока нет). Узлы одной цепочки в одно окно не попадают —
 * планировщик не моделирует семантическую интерференцию, и соседка выдаёт узнавание
 * вместо припоминания (D-038). Если не созрело ничего, возвращается ближайший по
 * сроку элемент с early: иначе экран практики был бы пустым днём без объяснения.
 */
export function practiceQueue(db: Database.Database, input: { at?: string; limit?: number } = {}): QueueRow[] {
	const limit = input.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(`limit — целое от 1 до 100, получено ${limit}`);
	const at = input.at ?? nowIso();
	const candidates = db
		.prepare(
			`SELECT r.id AS item_id, r.method AS method, r.due_at AS due_at, c.id AS claim_id, c.text AS claim_text,
			        EXISTS (SELECT 1 FROM doubt d WHERE d.claim_id = c.id AND d.resolved_at IS NULL) AS has_doubt
			 FROM repeat_item r JOIN claim c ON c.id = r.claim_id
			 ORDER BY
			   CASE
			     WHEN EXISTS (SELECT 1 FROM doubt d WHERE d.claim_id = c.id AND d.resolved_at IS NULL) THEN 0
			     WHEN r.due_at IS NOT NULL AND r.due_at <= ? THEN 1
			     WHEN r.due_at IS NULL THEN 2
			     ELSE 3
			   END,
			   r.due_at IS NOT NULL DESC,
			   r.due_at ASC,
			   c.created_at ASC`,
		)
		.all(at) as { claim_id: string; claim_text: string; due_at: string | null; has_doubt: number; item_id: string; method: RepeatMethod }[];

	const picked: QueueRow[] = [];
	const blocked = new Set<string>();
	let nearest: QueueRow | undefined;

	for (const row of candidates) {
		const item: QueueRow = {
			claimId: row.claim_id,
			claimText: row.claim_text,
			dueAt: row.due_at,
			early: false,
			hasDoubt: row.has_doubt === 1,
			itemId: row.item_id,
			method: row.method,
		};
		const isDue = row.has_doubt === 1 || row.due_at === null || row.due_at <= at;
		if (!isDue) {
			// Ближайший созревающий — единственный кандидат на «пустой день».
			nearest ??= { ...item, early: true };
			continue;
		}
		if (blocked.has(row.claim_id)) continue;
		picked.push(item);
		if (picked.length >= limit) return picked;
		// Соседи по цепочке закрываются на это окно.
		for (const other of claimIdsOfChain(db, row.claim_id)) blocked.add(other);
		blocked.add(row.claim_id);
	}
	if (picked.length === 0 && nearest !== undefined) return [nearest];
	return picked;
}

/** Что узел держит в разных формах: припоминание стабильно, перенос мёртв — это
 *  вызубренное, и практики это должно показывать, а не прятать за средней. */
export function repeatStatesForClaim(
	db: Database.Database,
	claimId: string,
	at = nowIso(),
): { method: RepeatMethod; retrievability: number | null }[] {
	const rows = db
		.prepare("SELECT method, stability, last_review_at FROM repeat_item WHERE claim_id = ? ORDER BY method")
		.all(claimId) as { last_review_at: string | null; method: RepeatMethod; stability: number | null }[];
	return rows.map((row) => {
		if (row.stability === null || row.last_review_at === null) return { method: row.method, retrievability: null };
		return { method: row.method, retrievability: retrievability(elapsedDays(row.last_review_at, at), row.stability) };
	});
}
