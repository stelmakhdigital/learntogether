// Canonical tool schemas for the v1 methodology toolset (docs/tool-contracts.md,
// «Набор инструментов v1»). Raw definitions are written in ordinary JSON Schema
// style — optional means "absent from required" — and are cleaned through
// `canonicalizeTool` once at module load. A dropped keyword is a bug, so
// canonicalization throws instead of silently losing schema content; the test
// suite re-runs it and asserts `dropped` is empty.
//
// Layer rule: the agent package gets `models` only, so enum literals are
// mirrored here from `packages/domain/src/state.ts` and the contract tables,
// not imported. Keep them in sync when either changes.

import { canonicalizeTool, type CanonicalTool } from "@learntogether/models";

interface RawTool {
	name: string;
	description: string;
	parameters: unknown;
}

const idField = { type: "string", minLength: 1 } as const;

/** Raw JSON Schema, pre-canonicalization. Optional = not listed in `required`;
 *  `canonicalizeTool` rewrites it to `[T, "null"]`. */
export const RAW_TOOL_SCHEMAS: readonly RawTool[] = [
	{
		name: "probe_record",
		description: "Зафиксировать результат зондирования: что ученик держит, что на границе, чего нет.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["items"],
			properties: {
				items: {
					type: "array",
					description: "По записи на каждое прозондированное утверждение.",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["statement", "state", "confidence"],
						properties: {
							statement: { type: "string", minLength: 1 },
							state: {
								type: "string",
								enum: ["held", "frontier", "absent"],
								description: "Держу / на границе / не держу.",
							},
							confidence: {
								type: "integer",
								minimum: 1,
								maximum: 5,
								description: "Уверенность ученика до показа результата.",
							},
							basis_ref: { type: "string", minLength: 1, description: "Опора: узел графа или источник." },
						},
					},
				},
			},
		},
	},
	{
		name: "plan_set",
		description: "Задать дерево плана урока. Авторство однократное; повторный вызов перезаписывает всё дерево.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["nodes"],
			properties: {
				nodes: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["node_id", "label", "why_needed", "depends_on"],
						properties: {
							node_id: idField,
							parent_id: { type: "string", minLength: 1, description: "Родитель в дереве плана." },
							label: { type: "string", minLength: 1 },
							why_needed: { type: "string", minLength: 1, description: "На какой вопрос ученика отвечает узел." },
							depends_on: {
								type: "array",
								description: "Идентификаторы узлов, без которых этот не держится.",
								items: idField,
							},
						},
					},
				},
			},
		},
	},
	{
		name: "record_step",
		description: "Объявить шаг до объяснения: что он утверждает, на что опирается и зачем нужен.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["statement", "kind", "premises"],
			properties: {
				statement: { type: "string", minLength: 1 },
				kind: { type: "string", enum: ["derivation", "foundation"] },
				premises: {
					type: "array",
					description: "Ссылки на node_id плана или узлы графа; пустой у foundation, непустой у derivation.",
					items: idField,
				},
				motivation: { type: "string", minLength: 1, description: "На какой вопрос ученика отвечает шаг." },
			},
		},
	},
	{
		name: "update_step",
		description: "Записать итог проверки шага после ответа ученика.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["step_id", "verdict", "hint_count"],
			properties: {
				step_id: idField,
				verdict: { type: "string", enum: ["correct", "incorrect", "partial"] },
				hint_count: {
					type: "integer",
					minimum: 0,
					description: "Сколько подсказок понадобилось; ответ с подсказки — не held.",
				},
				note: { type: "string", minLength: 1, description: "Где именно свернуло не туда." },
			},
		},
	},
	{
		name: "present_step",
		description: "Подать шаг ученику — до проверки понимания.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["step_id", "text"],
			properties: {
				step_id: idField,
				text: { type: "string", minLength: 1, description: "Текст объяснения шага." },
			},
		},
	},
	{
		name: "check_understanding",
		description: "Проверить понимание шага: вопрос, варианты, эталон ответа, запрос уверенности.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["step_id", "kind", "question", "answer", "ask_confidence"],
			properties: {
				step_id: idField,
				kind: {
					type: "string",
					// Values mirror the CHECK constraint on step_check.kind in 001_init.sql.
					enum: ["single_choice", "multi_choice", "free_recall", "predict", "find_error", "transfer"],
				},
				question: { type: "string", minLength: 8 },
				options: {
					// Shared array for every kind: the schema holds the shape,
					// presence per kind is the executor's semantic check.
					type: "array",
					minItems: 2,
					maxItems: 5,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["label"],
						properties: {
							label: { type: "string", minLength: 1 },
							text: { type: "string", minLength: 1 },
						},
					},
				},
				answer: {
					type: "array",
					minItems: 1,
					items: { type: "string", minLength: 1 },
					description: "Эталон: label/номер варианта или ожидаемая формулировка.",
				},
				why: { type: "string", minLength: 1, description: "Просьба сказать шаг своими словами." },
				ask_confidence: { type: "boolean", description: "Спросить уверенность до показа результата." },
			},
		},
	},
	{
		name: "doubt_add",
		description: "Отметить зону сомнения на узле графа: практика начинается с них.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["claim_id", "source"],
			properties: {
				claim_id: idField,
				// Values mirror the CHECK constraint on doubt.source in 001_init.sql.
				source: { type: "string", enum: ["check_failed", "contradicted", "missed_transfer", "calibration"] },
				note: { type: "string", minLength: 1, description: "Что именно вызывает сомнение." },
			},
		},
	},
];

function canonicalizeAll(raws: readonly RawTool[]): Record<string, CanonicalTool> {
	const schemas: Record<string, CanonicalTool> = {};
	for (const raw of raws) {
		const { tool, dropped } = canonicalizeTool(raw);
		if (dropped.length > 0) {
			throw new Error(`tool ${raw.name}: keywords dropped by canonicalization: ${dropped.join(", ")}`);
		}
		schemas[tool.name] = tool;
	}
	return schemas;
}

/** Cleaned once at module load; every key is present and `[T, "null"]`-optional. */
export const TOOL_SCHEMAS: Record<string, CanonicalTool> = canonicalizeAll(RAW_TOOL_SCHEMAS);
