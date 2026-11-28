// Reading the graph from inside a lesson (docs/tool-contracts.md): search answers
// «did we already cover this», the reading answers «what holds it and what rests on
// it». Both are read-only on purpose — the teacher cannot rewrite the graph in the
// middle of an explanation; nodes are written by the lesson's accepted steps.

import type Database from "better-sqlite3";
import { readClaim, searchClaimsLexical } from "@learntogether/data";
import { TOOL_SCHEMAS, type ToolPort } from "@learntogether/agent";
import { requireString } from "./args.ts";

export function createGraphTools(db: Database.Database, _sessionId: string): ToolPort[] {
	const search: ToolPort = {
		name: "graph_search",
		description: TOOL_SCHEMAS.graph_search!.description,
		schema: TOOL_SCHEMAS.graph_search!.parameters,
		run(args: Record<string, unknown>): string {
			const query = requireString(args, "query");
			let k = 8;
			if (args.k !== undefined && args.k !== null) {
				if (typeof args.k !== "number" || !Number.isInteger(args.k) || args.k < 1 || args.k > 20) {
					throw new Error("k — целое от 1 до 20");
				}
				k = args.k;
			}
			const hits = searchClaimsLexical(db, query, k);
			// An empty graph is not «the learner knows nothing»: it says the search
			// found no wording, which is a different fact and asks for a different next
			// move (probe the learner).
			// A live lesson showed the model inventing ids for graph_read after an empty
			// search, which costs a refused call.
			if (hits.length === 0)
				return "в графе ничего не найдено — это не значит, что ученик не знает, спроси его; id для graph_read берутся только из ответов этого поиска";
			// The next call is spelled out with a real id: after a bare list of ids the
			// model invented its own (live lesson 2026-11-28: graph_read "производная_скорость").
			const lines = hits.map((hit) => `${hit.id}: ${hit.text}`);
			lines.push(`следующий вызов: graph_read {"id":"${hits[0]!.id}"}`);
			return lines.join("\n");
		},
	};

	const read: ToolPort = {
		name: "graph_read",
		description: TOOL_SCHEMAS.graph_read!.description,
		schema: TOOL_SCHEMAS.graph_read!.parameters,
		run(args: Record<string, unknown>): string {
			const id = requireString(args, "id");
			const { claim, chains, usedIn, provenance, openDoubts } = readClaim(db, id);
			const lines = [`узел «${claim.text}»${claim.area ? `, область: ${claim.area}` : ""}`];
			if (chains.length > 0) {
				for (const chain of chains) lines.push(`держится на посылках: ${chain.premiseIds.join(", ")}`);
			} else {
				lines.push("посылок нет — базовое или непроверенное");
			}
			if (usedIn.length > 0) lines.push(`на него опираются цепки: ${usedIn.map((chain) => chain.id).join(", ")}`);
			for (const row of provenance) {
				lines.push(`взято: ${row.sourceId ?? (row.sessionId ? `урок ${row.sessionId}` : "неизвестно откуда")}${row.note ? ` (${row.note})` : ""}`);
			}
			for (const doubt of openDoubts) lines.push(`под сомнением: ${doubt.note ?? doubt.source}`);
			return lines.join("\n");
		},
	};

	return [search, read];
}
