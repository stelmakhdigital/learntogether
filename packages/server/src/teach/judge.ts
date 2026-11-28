// The verdict of an answer (docs/teaching-method.md section 5). A choice answer is
// compared with the stored reference by us: the model that wrote the reference
// does not get to grade the choice. A free-form answer has to be compared in
// meaning, so the model compares it with that same reference and its answer is
// accepted only inside a schema — anything else is a refusal, never a silent
// "partial".

import type Database from "better-sqlite3";
import { runTurn, ToolRegistry, type ToolPort } from "@learntogether/agent";
import { openChecksForSession, type CheckOption, type CheckRow } from "@learntogether/data";
import type { Budget, Transport } from "@learntogether/models";
import type { CheckVerdict } from "@learntogether/domain";

/** The answer in the words the learner used. An option index becomes that option,
 *  so the transcript and the export read like the lesson, not like a form. */
export function learnerAnswerText(answer: string | number, options: CheckOption[]): string {
	if (typeof answer === "string") {
		const named = options.find((option) => option.label === answer);
		if (named !== undefined) return named.text === undefined ? named.label : `${named.label} — ${named.text}`;
		if (answer.trim() === "") throw new Error("пустой ответ: ученик ничего не сдал");
		return answer;
	}
	const option = options[answer];
	if (option === undefined) throw new Error(`варианта с номером ${answer} в проверке нет`);
	return option.text === undefined ? option.label : `${option.label} — ${option.text}`;
}

/** The labels the reference names, or null when the reference is not a choice
 *  (a free-recall reference is a wording, and comparing wordings is not
 *  arithmetic). */
function referenceLabels(check: CheckRow): string[] | null {
	const labels = check.options.map((option) => option.label);
	if (typeof check.answer === "number") {
		if (!Number.isInteger(check.answer) || check.answer < 0 || check.answer >= labels.length) {
			throw new Error(`эталон проверки ${check.id} ссылается на несуществующий вариант ${check.answer}`);
		}
		return [labels[check.answer]!];
	}
	// A multi-choice reference is spelled "a,c"; a single label stands alone.
	const parts = check.answer.split(",").map((part) => part.trim());
	return parts.length > 1 || labels.includes(check.answer.trim()) ? parts : null;
}

/** Verdict of a choice answer, or null when the kind needs a judgement about
 *  meaning. A multi-choice that hit only part of the reference is not correct:
 *  the method has no "почти угадал". */
export function mechanicalVerdict(check: CheckRow, answer: string | number): CheckVerdict | null {
	if (check.kind !== "single_choice" && check.kind !== "multi_choice") return null;
	const wanted = referenceLabels(check);
	if (wanted === null) return null;

	const given = new Set(
		String(answer)
			.split(",")
			.map((part) => learnerAnswerLabel(check.options, part.trim())),
	);
	const hits = wanted.filter((label) => given.has(label)).length;
	if (hits === 0) return "incorrect";
	return hits === wanted.length && given.size === wanted.length ? "correct" : "partial";
}

/** An answer may arrive as an index or as a label; both name the same option. */
function learnerAnswerLabel(options: CheckOption[], given: string): string {
	const index = Number(given);
	if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index]!.label;
	return given;
}

const GRADE_SCHEMA = {
	additionalProperties: false,
	properties: {
		reason: { minLength: 1, type: "string" },
		verdict: { enum: ["correct", "incorrect", "partial"], type: "string" },
	},
	required: ["verdict", "reason"],
	type: "object",
} as const;

const GRADE_SYSTEM = `Ты сверяешь ответ ученика с эталоном и вызываешь grade_answer.
"verdict" — "correct" (смысл совпадает с эталоном), "incorrect" (не совпадает) или
"partial" (часть смысла есть, часть потеряна); "reason" — одна фраза, где именно
расхождение. Оценивай смысл, а не дословное совпадение и не детали, которых в
эталопе нет. Отвечай вызовом инструмента, а не текстом.`;

/** Compare a free-form answer with the reference through the model. */
export async function judgeAnswer(
	transport: Transport,
	budget: Budget,
	check: CheckRow,
	answer: string,
	signal?: AbortSignal,
): Promise<{ verdict: CheckVerdict; reason: string }> {
	const reference = typeof check.answer === "number" ? (check.options[check.answer]?.text ?? String(check.answer)) : check.answer;
	const brief = [`Вопрос: ${check.question}`, `Эталон: ${reference}`, `Ответ ученика: ${answer}`].join("\n");

	let graded: { reason: string; verdict: CheckVerdict } | null = null;
	const tool: ToolPort = {
		description: "Записать итог сверки ответа ученика с эталоном.",
		name: "grade_answer",
		run: (args: Record<string, unknown>) => {
			graded = { reason: String(args.reason), verdict: args.verdict as CheckVerdict };
			return "итог принят";
		},
		schema: GRADE_SCHEMA,
	};
	const registry = new ToolRegistry([tool]);
	// The verdict arrives as a tool call, not as free text: the loop's reparation
	// of broken arguments then works here too. A 7B model asked for a JSON object
	// answered with a prose list of keys (live check 2026-11-28), which threw the
	// learner's answer away.
	const result = await runTurn({
		maxSteps: 3,
		registry,
		request: {
			budget,
			messages: [{ content: [{ text: brief, type: "text" as const }], role: "user" as const }],
			reasoningLevel: "none",
			system: GRADE_SYSTEM,
			tools: registry.definitions(),
		},
		...(signal === undefined ? {} : { signal }),
		transport,
	});
	if (graded === null) {
		throw new Error(
			`оценка не получена: модель не вызвала grade_answer${result.text === "" ? "" : ` — её слова: ${result.text.slice(0, 200)}`}`,
		);
	}
	return graded;
}

/** The check the learner is expected to answer now. More than one open check is a
 *  bug of the turn, so the oldest is served rather than hidden. */
export function pendingCheck(db: Database.Database, sessionId: string): CheckRow | null {
	return openChecksForSession(db, sessionId)[0] ?? null;
}
