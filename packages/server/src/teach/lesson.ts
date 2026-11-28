// The tools that come before any step is taught: what the probing conversation
// showed, and the goal the lesson is steering at (docs/teaching-method.md
// sections 1 and 2). Steps, checks and repairs live in steps.ts.

import type Database from "better-sqlite3";
import { PROBE_STATES, setPlan, setSessionGoal, upsertProbe, type PlanNodeInput } from "@learntogether/data";
import type { Confidence, ProbeState } from "@learntogether/domain";
import { TOOL_SCHEMAS, type ToolPort } from "@learntogether/agent";
import { requireString, optionalString } from "./args.ts";

type Item = { confidence: number; statement: string; state: string; basis_ref?: string };

/** A field of a nested object, with the path in the refusal: the model has to
 *  know which item of the list it has to fix. */
function itemString(row: Record<string, unknown>, field: string, at: string): string {
	const value = row[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${at}.${field}: нужна непустая строка`);
	}
	return value;
}

function itemOptionalString(row: Record<string, unknown>, field: string, at: string): string | undefined {
	const value = row[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at}.${field}: нужна непустая строка или null`);
	return value;
}

function readItems(value: unknown): Item[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`items: нужен непустой список результатов зондирования, получено: ${JSON.stringify(value)}`);
	}
	return value.map((raw, index) => {
		if (typeof raw !== "object" || raw === null) throw new Error(`items[${index}]: нужен объект`);
		const row = raw as Record<string, unknown>;
		const at = `items[${index}]`;
		const basisRef = itemOptionalString(row, "basis_ref", at);
		return {
			...(basisRef === undefined ? {} : { basis_ref: basisRef }),
			confidence: row.confidence as number,
			statement: itemString(row, "statement", at),
			state: itemString(row, "state", at),
		};
	});
}

/** shortcut: basis_ref of a probe holds a transcript entry number only; graph
 *  nodes arrive with этап 4, and there the reference gets a real target. */
function basisEntryId(ref: string | undefined, index: number): number | undefined {
	if (ref === undefined) return undefined;
	const id = Number(ref);
	if (!Number.isInteger(id) || id < 1) {
		throw new Error(
			`items[${index}].basis_ref: пока можно указать только номер записи разговора; ссылка на узел графа появится с этапом 4, получено: ${ref}`,
		);
	}
	return id;
}

function readNodes(value: unknown): PlanNodeInput[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`nodes: нужен непустой список узлов плана, получено: ${JSON.stringify(value)}`);
	}
	return value.map((raw, index) => {
		if (typeof raw !== "object" || raw === null) throw new Error(`nodes[${index}]: нужен объект`);
		const row = raw as Record<string, unknown>;
		const at = `nodes[${index}]`;
		const dependsOn = row.depends_on;
		if (dependsOn !== undefined && dependsOn !== null && !Array.isArray(dependsOn)) {
			throw new Error(`nodes[${index}].depends_on: нужен список идентификаторов узлов`);
		}
		const parentId = itemOptionalString(row, "parent_id", at);
		return {
			...(parentId === undefined ? {} : { parentId }),
			dependsOn: (dependsOn as string[] | undefined) ?? [],
			label: itemString(row, "label", at),
			nodeId: itemString(row, "node_id", at),
			whyNeeded: itemString(row, "why_needed", at),
		};
	});
}

/** Tools that state what the learner holds and where the lesson is going. */
export function createLessonTools(db: Database.Database, sessionId: string): ToolPort[] {
	const probeRecord: ToolPort = {
		name: "probe_record",
		description: TOOL_SCHEMAS.probe_record!.description,
		schema: TOOL_SCHEMAS.probe_record!.parameters,
		run(args: Record<string, unknown>): string {
			const items = readItems(args.items);
			const seen: Record<string, number> = {};
			items.forEach((item, index) => {
				const state = item.state as ProbeState;
				if (!PROBE_STATES.includes(state)) {
					throw new Error(
						`items[${index}].state: нужно held, frontier, absent или contradicted — без замера шаг не строится, получено: ${item.state}`,
					);
				}
				if (!Number.isInteger(item.confidence) || item.confidence < 1 || item.confidence > 5) {
					throw new Error(`items[${index}].confidence: нужно целое 1..5 — уверенность ученика до показа результата`);
				}
				const basis = basisEntryId(item.basis_ref, index);
				upsertProbe(db, {
					...(basis === undefined ? {} : { basisEntryId: basis }),
					confidence: item.confidence as Confidence,
					sessionId,
					statement: item.statement,
					state,
				});
				seen[state] = (seen[state] ?? 0) + 1;
			});
			const words = Object.entries(seen)
				.map(([state, count]) => `${count} ${state}`)
				.join(", ");
			return `замер записан: ${words}; следующий вызов: goal_state`;
		},
	};

	const goalState: ToolPort = {
		name: "goal_state",
		description: TOOL_SCHEMAS.goal_state!.description,
		schema: TOOL_SCHEMAS.goal_state!.parameters,
		run(args: Record<string, unknown>): string {
			const readyWhen = requireString(args, "ready_when");
			if (!Array.isArray(args.statements) || args.statements.length === 0) {
				throw new Error("statements: нужен непустой список пунктов цели");
			}
			const statements = (args.statements as unknown[]).map((item, index) => {
				if (typeof item !== "string") throw new Error(`statements[${index}]: нужна строка`);
				return item;
			});
			// The words the learner typed stay with the goal: the goal is a refinement of
			// them, and a reader of the export has to see what was asked in the first place.
			const raw = optionalString(args, "raw") ?? statements.join("; ");
			setSessionGoal(db, { raw, readyWhen, sessionId, statements });
			return `цель зафиксирована: ${statements.length} пунктов, критерий готовности «${readyWhen}»; следующий вызов: plan_set`;
		},
	};

	const planSet: ToolPort = {
		name: "plan_set",
		description: TOOL_SCHEMAS.plan_set!.description,
		schema: TOOL_SCHEMAS.plan_set!.parameters,
		run(args: Record<string, unknown>): string {
			const { pruned } = setPlan(db, { nodes: readNodes(args.nodes), sessionId });
			// Pruning is reported, not hidden: the model has to know that a held node was
			// left out, or it will keep coming back to it.
			const words = pruned.length === 0 ? "" : `; убрано из плана как держимое: ${pruned.join(", ")}`;
			return `план задан${words}; следующий вызов: record_step для первого непройденного узла`;
		},
	};

	return [probeRecord, goalState, planSet];
}
