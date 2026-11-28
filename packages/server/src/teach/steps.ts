// Executors of the four tools that move a step, over the steps repository.
// A refusal is an Error: the loop turns its message into a tool_result for the
// model (packages/agent/src/loop.ts), so it names the id, the field and the
// actual state — never a stack, never a path.

import type Database from "better-sqlite3";
import { TOOL_SCHEMAS, type ToolPort } from "@learntogether/agent";
import {
	appendEntry,
	CHECK_KINDS,
	createStep,
	presentStep,
	recordCheck,
	STEP_KINDS,
	type CheckOption,
	type EntryKind,
	type StepAnswer,
} from "@learntogether/data";
import { kindRequiresPremises, nextStepState, type StepKind, type StepState } from "@learntogether/domain";

// The contract asks for a dedicated entry kind "teacher_step"; neither
// ENTRY_KINDS nor the CHECK on transcript_entry.kind allows it, so the
// explanation is recorded as a plain teacher message.
// shortcut: switch to "teacher_step" once a migration widens the CHECK and
// ENTRY_KINDS in packages/data.
const PRESENTED_ENTRY_KIND: EntryKind = "text";

type StepRow = {
	id: string;
	session_id: string;
	ordinal: number;
	statement: string;
	kind: StepKind;
	state: StepState;
};

function requireOwnStep(db: Database.Database, sessionId: string, stepId: string): StepRow {
	const row = db
		.prepare("SELECT id, session_id, ordinal, statement, kind, state FROM step WHERE id = ?")
		.get(stepId) as StepRow | undefined;
	if (row === undefined) {
		// A real model reaches for the ordinal it sees in the lesson ("step 1") instead
		// of the id. Naming the step it probably meant is the difference between a
		// corrected call and a wasted round.
		const byOrdinal = db
			.prepare("SELECT ordinal, id FROM step WHERE session_id = ? AND ordinal = ?")
			.get(sessionId, Number(stepId)) as { ordinal: number; id: string } | undefined;
		if (byOrdinal !== undefined && Number.isInteger(Number(stepId))) {
			throw new Error(`шага со step_id "${stepId}" нет: это номер шага, а нужен его id — шаг ${byOrdinal.ordinal} имеет id ${byOrdinal.id}`);
		}
		throw new Error(`шага ${stepId} нет`);
	}
	if (row.session_id !== sessionId) throw new Error(`шаг ${stepId} не из этой сессии`);
	return row;
}

function requireString(args: Record<string, unknown>, field: string): string {
	const value = args[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field}: нужна непустая строка`);
	}
	return value;
}

/** Canonical schema spells optional as ["T", "null"], so an absent field may
 *  arrive as null; both mean "not given". */
function optionalString(args: Record<string, unknown>, field: string): string | undefined {
	const value = args[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field}: нужна непустая строка или null`);
	}
	return value;
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${field}: нужен массив непустых строк`);
	}
	return value as string[];
}

function readOptions(value: unknown): CheckOption[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) throw new Error("options: нужен массив вариантов");
	return value.map((item) => {
		if (typeof item !== "object" || item === null) throw new Error("options: вариант — объект с label");
		const option = item as Record<string, unknown>;
		if (typeof option.label !== "string" || option.label.trim() === "") {
			throw new Error("options: у варианта нужен непустой label");
		}
		const text = option.text;
		if (text !== undefined && text !== null && (typeof text !== "string" || text.trim() === "")) {
			throw new Error(`options: у варианта "${option.label}" text должен быть непустой строкой`);
		}
		return typeof text === "string" ? { label: option.label, text } : { label: option.label };
	});
}

/** The canonical schema of check_understanding spells `answer` as a list of
 *  labels while step_check.answer_json holds one scalar; a single-element list
 *  is that scalar, more than one has nowhere to live. */
function readAnswer(value: unknown): StepAnswer {
	if (typeof value === "number" || typeof value === "string") return value;
	if (Array.isArray(value) && value.length === 1) return readAnswer(value[0]);
	throw new Error(
		`answer: нужен один эталон — номер варианта или формулировка; несколько правильных вариантов step_check пока не хранит, получено: ${JSON.stringify(value)}`,
	);
}

/** Tools that move a step of the current session. The session id is closed over
 *  so a call can never write into another learner's lesson. */
export function createStepTools(db: Database.Database, sessionId: string): ToolPort[] {
	const recordStep: ToolPort = {
		name: "record_step",
		description: TOOL_SCHEMAS.record_step!.description,
		schema: TOOL_SCHEMAS.record_step!.parameters,
		run(args: Record<string, unknown>): string {
			const rawKind = requireString(args, "kind");
			const kind = STEP_KINDS.find((candidate) => candidate === rawKind);
			if (kind === undefined) {
				throw new Error(`kind "${rawKind}" неизвестен; нужны ${STEP_KINDS.join(" или ")}`);
			}
			// A derivation without premises is refused by the repository itself:
			// the rule belongs to the step, not to this executor.
			const premises = args.premises === undefined || args.premises === null ? [] : requireStringArray(args.premises, "premises");
			const statement = requireString(args, "statement");
			const motivation = optionalString(args, "motivation");
			const created = createStep(db, {
				sessionId,
				statement,
				kind,
				premises,
				...(motivation === undefined ? {} : { motivation }),
			});
			return `шаг ${created.id} под номером ${created.ordinal}; следующий вызов — present_step со step_id ${created.id}`;
		},
	};

	const updateStep: ToolPort = {
		name: "update_step",
		description: TOOL_SCHEMAS.update_step!.description,
		schema: TOOL_SCHEMAS.update_step!.parameters,
		run(args: Record<string, unknown>): string {
			const stepId = requireString(args, "step_id");
			const step = requireOwnStep(db, sessionId, stepId);
			if (step.state === "accepted") {
				throw new Error(`шаг ${stepId} в состоянии "accepted" — принятую формулировку не правим`);
			}
			const statement = optionalString(args, "statement");
			const motivation = optionalString(args, "motivation");
			const hasPremises = args.premises !== undefined && args.premises !== null;
			if (statement === undefined && motivation === undefined && !hasPremises) {
				throw new Error("update_step: не передано ни одного поля — statement, motivation или premises");
			}
			let premisesJson: string | undefined;
			if (hasPremises) {
				const premises = requireStringArray(args.premises, "premises");
				if (kindRequiresPremises(step.kind) && premises.length === 0) {
					throw new Error(`шаг ${stepId} — "${step.kind}": premises не может быть пустым`);
				}
				premisesJson = JSON.stringify(premises);
			}
			// null means "keep what is there"; clearing motivation is not a
			// request the method makes, so one statement stays enough.
			db.prepare(
				`UPDATE step
				 SET statement = COALESCE(?, statement),
				     motivation = COALESCE(?, motivation),
				     premises_json = COALESCE(?, premises_json)
				 WHERE id = ?`,
			).run(statement ?? null, motivation ?? null, premisesJson ?? null, stepId);
			return `обновлён шаг ${stepId}`;
		},
	};

	const presentStepTool: ToolPort = {
		name: "present_step",
		description: TOOL_SCHEMAS.present_step!.description,
		schema: TOOL_SCHEMAS.present_step!.parameters,
		run(args: Record<string, unknown>): string {
			const stepId = requireString(args, "step_id");
			const step = requireOwnStep(db, sessionId, stepId);
			const next = nextStepState(step.state, "present");
			if (typeof next !== "string") {
				throw new Error(`шаг ${stepId} в состоянии "${step.state}" — показать нельзя`);
			}
			// The wording that enters the transcript is the step's own, taken from
			// storage; the explanation text the model sent survives as the tool_call
			// entry of the same turn (packages/server/src/turn.ts).
			appendEntry(db, {
				sessionId,
				kind: PRESENTED_ENTRY_KIND,
				role: "teacher",
				text: step.statement,
			});
			presentStep(db, stepId);
			// The result names the next required call: a small local model that finished
			// the step and stopped talking left the step without a check (live check
			// 2026-11-28), and the method does not allow a step without one.
			return `показан шаг ${step.ordinal}; следующий вызов — check_understanding со step_id ${step.id}`;
		},
	};

	const checkUnderstanding: ToolPort = {
		name: "check_understanding",
		description: TOOL_SCHEMAS.check_understanding!.description,
		schema: TOOL_SCHEMAS.check_understanding!.parameters,
		run(args: Record<string, unknown>): string {
			const stepId = requireString(args, "step_id");
			const step = requireOwnStep(db, sessionId, stepId);
			// The repository refuses a check on a step that is not presented; naming the
			// call the lesson really owes turns that refusal into a course change.
			if (step.state === "accepted") {
				throw new Error(
					`шаг ${step.ordinal} уже принят учеником — проверок ему больше не нужно; следующий вызов: record_step для следующего шага`,
				);
			}
			const rawKind = requireString(args, "kind");
			const kind = CHECK_KINDS.find((candidate) => candidate === rawKind);
			if (kind === undefined) {
				throw new Error(`kind "${rawKind}" неизвестен; нужны ${CHECK_KINDS.join(", ")}`);
			}
			const options = readOptions(args.options);
			if ((kind === "single_choice" || kind === "multi_choice") && options === null) {
				throw new Error(`kind "${kind}": нужны options — ученик выбирает из вариантов`);
			}
			const why = optionalString(args, "why");
			const checkId = recordCheck(db, {
				stepId,
				kind,
				question: requireString(args, "question"),
				...(options === null ? {} : { options }),
				answer: readAnswer(args.answer),
				...(why === undefined ? {} : { why }),
				askConfidence: args.ask_confidence !== false,
			});
			return `проверка ${checkId}`;
		},
	};

	return [recordStep, updateStep, presentStepTool, checkUnderstanding];
}
