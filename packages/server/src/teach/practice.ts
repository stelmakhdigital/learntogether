// Executors of the practice tools: the problem is declared with its reference
// before the answer, the outcome carries the rating to the scheduler. Refusals are
// Errors: the loop hands their text back to the model (packages/agent/src/loop.ts).

import type Database from "better-sqlite3";
import { CHECK_VERDICTS, createProblem, problemsForClaim, REPEAT_METHODS, recordProblemOutcome } from "@learntogether/data";
import { RATINGS } from "@learntogether/domain";
import { TOOL_SCHEMAS, type ToolPort } from "@learntogether/agent";
import { requireString } from "./args.ts";

function requireRating(value: unknown): (typeof RATINGS)[number] {
	if (typeof value !== "string" || !RATINGS.includes(value as (typeof RATINGS)[number])) {
		throw new Error(`rating — один из ${RATINGS.join(", ")}`);
	}
	return value as (typeof RATINGS)[number];
}

export function createPracticeTools(db: Database.Database, sessionId: string): ToolPort[] {
	const poseProblem: ToolPort = {
		name: "pose_problem",
		description: TOOL_SCHEMAS.pose_problem!.description,
		schema: TOOL_SCHEMAS.pose_problem!.parameters,
		run(args: Record<string, unknown>): string {
			const claimId = requireString(args, "claim_id");
			// The contract v1 field name is `kind`; the storage column is `method`
			// (docs/tool-contracts.md). Only the tool speaks the model's name.
			const kind = requireString(args, "kind");
			if (!REPEAT_METHODS.includes(kind as (typeof REPEAT_METHODS)[number])) {
				throw new Error(`kind — один из ${REPEAT_METHODS.join(", ")}`);
			}
			const posed = createProblem(db, {
				claimId,
				hints: args.hints === undefined || args.hints === null ? [] : (args.hints as string[]),
				method: kind as (typeof REPEAT_METHODS)[number],
				sessionId,
				solution: requireString(args, "solution"),
				statement: requireString(args, "statement"),
			});
			// The wording of what was already asked on this node is the only way the
			// model can avoid repeating a form; without it variability is a wish.
			const asked = problemsForClaim(db, claimId).filter((problem) => problem.id !== posed);
			const next = asked.length === 0 ? "" : `\nраньше по этому узлу уже спрашивали: ${asked.map((problem) => `«${problem.statement}»`).join("; ")}`;
			return `задача ${posed} записана с эталоном; покажи её ученику и дождись ответа${next}`;
		},
	};

	const problemOutcome: ToolPort = {
		name: "problem_outcome",
		description: TOOL_SCHEMAS.problem_outcome!.description,
		schema: TOOL_SCHEMAS.problem_outcome!.parameters,
		run(args: Record<string, unknown>): string {
			const verdict = requireString(args, "verdict");
			if (!CHECK_VERDICTS.includes(verdict as (typeof CHECK_VERDICTS)[number])) {
				throw new Error(`verdict — один из ${CHECK_VERDICTS.join(", ")}`);
			}
			const hintCount = args.hint_count ?? 0;
			if (!Number.isInteger(hintCount) || (hintCount as number) < 0) throw new Error("hint_count — целое не меньше 0");
			const note = args.note === undefined || args.note === null ? undefined : requireString(args, "note");
			const outcome = recordProblemOutcome(db, requireString(args, "problem_id"), {
				hintCount: hintCount as number,
				...(note === undefined ? {} : { note }),
				rating: requireRating(args.rating),
				verdict: verdict as (typeof CHECK_VERDICTS)[number],
			});
			return outcome.minutes !== null
				? `итог записан; элемент вернётся через ${outcome.minutes} минут этой же сессии`
				: `итог записан; следующий повтор этого узла через ${outcome.intervalDays} дн.`;
		},
	};

	return [poseProblem, problemOutcome];
}
