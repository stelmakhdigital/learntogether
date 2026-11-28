// The words the data screens put next to a row. They live here rather than in the
// components because `node --test` does not read JSX: this is the part of a screen
// a test can actually reach.

export interface QueueRow {
	dueAt: string | null;
	early: boolean;
	hasDoubt: boolean;
}

export interface GraphPage {
	/** Nodes in browse mode, count of nodes in the graph. */
	total: number;
	/** Search wording; empty means the library is browsed, not filtered. */
	query: string;
	shown: number;
	hits: number;
}

/** Why this item is in today's practice, in words a learner can act on. */
export function itemMark(item: QueueRow, today = new Date()): string {
	if (item.hasDoubt) return "на узле открыто сомнение";
	if (item.dueAt === null) return "ещё ни разу не повторялось";
	if (item.early) return "созреет позже — сегодня больше ничего нет";
	const date = new Date(item.dueAt);
	// A date without a month is not a date: the schedule says when, and «сегодня»
	// is what a person can act on today.
	if (date.toDateString() === today.toDateString()) return "срок сегодня";
	return `срок ${date.toLocaleDateString("ru-RU")}`;
}

/** What the library list currently holds. */
export function listCaption(page: Pick<GraphPage, "query" | "hits" | "total">): string {
	if (page.query !== "") return `найдено ${page.hits} по «${page.query}»`;
	return `узлов в графе: ${page.total}`;
}

/** PARTIAL is about what the page does not show, not about a broken load. */
export function hiddenCount(page: Pick<GraphPage, "query" | "hits" | "total" | "shown">): number {
	const listed = page.query === "" ? page.total : page.hits;
	return Math.max(0, listed - page.shown);
}
