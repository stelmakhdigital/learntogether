// The lesson plan: a tree of nodes, each one justified, and the pruning of what
// the learner already holds. A node without a reason is refused by the schema
// (why_needed is NOT NULL) and a node whose wording the learner already holds is
// not taught (docs/teaching-method.md section 3).

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// `done` and `skipped` are written when a step's premises point at plan nodes,
// which is этап 4; until then the plan carries the intention and the pruning.
export type PlanNodeState = "todo" | "done" | "skipped" | "pruned_held";

export type PlanNodeInput = {
	nodeId: string;
	label: string;
	whyNeeded: string;
	parentId?: string;
	dependsOn?: string[];
};

export type PlanNodeRow = {
	id: string;
	planId: string;
	nodeId: string;
	parentId: string | null;
	label: string;
	whyNeeded: string;
	dependsOn: string[];
	state: PlanNodeState;
	ordinal: number;
};

function rowToNode(row: Record<string, unknown>): PlanNodeRow {
	return {
		id: row.id as string,
		planId: row.plan_id as string,
		nodeId: row.node_id as string,
		parentId: (row.parent_id as string | null) ?? null,
		label: row.label as string,
		whyNeeded: row.why_needed as string,
		dependsOn: JSON.parse(row.depends_on_json as string) as string[],
		state: row.state as PlanNodeState,
		ordinal: row.ordinal as number,
	};
}

/** Wording comparison for pruning: case, trailing punctuation and extra spaces
 *  are not a difference in what is held. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[.,;:!?]+$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

/** The plan the lesson is following right now, or null while it is still probing. */
export function activePlan(db: Database.Database, sessionId: string): { id: string; nodes: PlanNodeRow[] } | null {
	const plan = db
		.prepare("SELECT id FROM plan WHERE session_id = ? AND replaced_by IS NULL ORDER BY created_at DESC LIMIT 1")
		.get(sessionId) as { id: string } | undefined;
	if (plan === undefined) return null;
	const nodes = db.prepare("SELECT * FROM plan_node WHERE plan_id = ? ORDER BY ordinal ASC").all(plan.id) as Record<
		string,
		unknown
	>[];
	return { id: plan.id, nodes: nodes.map(rowToNode) };
}

/**
 * Replaces the plan of a session with a new tree.
 *
 * Refusals that protect the method rather than the rows:
 * - a node repeating the wording of a step already taught — the taught path is
 *   not rewritten under the learner's feet;
 * - a plan made only of what the learner already holds — then there is nothing
 *   to teach, and the honest answer is to say so instead of opening a lesson.
 *
 * A node whose wording matches a held probe is stored as `pruned_held`: it stays
 * visible in the plan so the pruning is auditable, and it is never taught.
 */
export function setPlan(
	db: Database.Database,
	input: { sessionId: string; nodes: PlanNodeInput[] },
): { planId: string; pruned: string[] } {
	if (input.nodes.length === 0) {
		throw new Error("nodes: план из нуля узлов — учить нечего");
	}
	const ids = new Set<string>();
	for (const [index, node] of input.nodes.entries()) {
		const label = node.label.trim();
		if (label === "") throw new Error(`nodes[${index}].label: нужна формулировка узла`);
		if (node.whyNeeded.trim() === "") {
			throw new Error(`nodes[${index}].why_needed: узел без ответа «зачем он нужен» в план не входит`);
		}
		if (ids.has(node.nodeId)) throw new Error(`nodes[${index}].node_id: узел ${node.nodeId} уже в плане`);
		ids.add(node.nodeId);
	}
	for (const [index, node] of input.nodes.entries()) {
		if (node.parentId !== undefined && !ids.has(node.parentId)) {
			throw new Error(`nodes[${index}].parent_id: узла ${node.parentId} в этом плане нет`);
		}
		for (const dependency of node.dependsOn ?? []) {
			if (!ids.has(dependency)) {
				throw new Error(`nodes[${index}].depends_on: узла ${dependency} в этом плане нет`);
			}
			if (dependency === node.nodeId) {
				throw new Error(`nodes[${index}].depends_on: узел ${node.nodeId} не может опираться сам на себя`);
			}
		}
	}

	const taught = new Set(
		(db
			.prepare("SELECT statement FROM step WHERE session_id = ? AND state IN ('presented','accepted','repaired')")
			.all(input.sessionId) as { statement: string }[]).map((row) => normalize(row.statement)),
	);
	for (const node of input.nodes) {
		if (taught.has(normalize(node.label))) {
			throw new Error(
				`узлы плана не переписывают пройденное: «${node.label}» уже пройден этим учеником — оставь в плане только то, что ещё не пройдено`,
			);
		}
	}

	const held = new Set(
		(
			db
				.prepare("SELECT statement FROM probe_item WHERE session_id = ? AND state = 'held'")
				.all(input.sessionId) as { statement: string }[]
		).map((row) => normalize(row.statement)),
	);
	const pruned = input.nodes.filter((node) => held.has(normalize(node.label))).map((node) => node.nodeId);
	if (pruned.length === input.nodes.length) {
		throw new Error("весь план уже держится учеником — урока нет, скажи это ученику и предложи следующую ступень");
	}

	const now = new Date().toISOString();
	const planId = randomUUID();
	db.transaction(() => {
		// The new plan first: replaced_by points at it, and the key would refuse the
		// other order.
		db.prepare("INSERT INTO plan (id, session_id, created_at, replaced_by) VALUES (?, ?, ?, NULL)").run(
			planId,
			input.sessionId,
			now,
		);
		const previous = db
			.prepare("SELECT id FROM plan WHERE session_id = ? AND replaced_by IS NULL AND id != ?")
			.all(input.sessionId, planId) as { id: string }[];
		for (const old of previous) {
			db.prepare("UPDATE plan SET replaced_by = ? WHERE id = ?").run(planId, old.id);
		}
		input.nodes.forEach((node, ordinal) => {
			db.prepare(
				`INSERT INTO plan_node (id, plan_id, node_id, parent_id, label, why_needed, depends_on_json, state, ordinal)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				randomUUID(),
				planId,
				node.nodeId,
				node.parentId ?? null,
				node.label.trim(),
				node.whyNeeded.trim(),
				JSON.stringify(node.dependsOn ?? []),
				pruned.includes(node.nodeId) ? "pruned_held" : "todo",
				ordinal + 1,
			);
		});
	})();
	return { planId, pruned };
}
