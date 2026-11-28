import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeTool, validateArgs } from "@learntogether/models";
import { RAW_TOOL_SCHEMAS, TOOL_SCHEMAS } from "@learntogether/agent";

const TOOL_NAMES = [
	"check_understanding",
	"doubt_add",
	"goal_state",
	"plan_set",
	"present_step",
	"probe_record",
	"record_step",
	"update_step",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

// Minimal structurally correct arguments per tool (docs/tool-contracts.md).
const VALID_ARGS: Record<ToolName, Record<string, unknown>> = {
	probe_record: {
		items: [
			{ statement: "Сложение не зависит от порядка слагаемых", state: "held", confidence: 4, basis_ref: null },
		],
	},
	plan_set: {
		nodes: [
			{
				node_id: "n1",
				parent_id: null,
				label: "Порядок слагаемых",
				why_needed: "Без него умножение кажется заученным",
				depends_on: [],
			},
		],
	},
	record_step: {
		statement: "От перестановки слагаемых сумма не меняется",
		kind: "foundation",
		premises: [],
		motivation: "Отвечает на вопрос «зачем вообще менять местами»",
	},
	update_step: { step_id: "s1", statement: "Сумма не меняется от порядка слагаемых", motivation: null },
	goal_state: {
		statements: ["Объяснить, почему сумма не зависит от порядка"],
		ready_when: "ученик сам выводит перестановку на новых числах",
		raw: null,
	},
	present_step: { step_id: "s1", text: "Сложи 3 и 4, а потом 4 и 3 — результат один и тот же." },
	check_understanding: {
		step_id: "s1",
		kind: "single_choice",
		question: "Какое выражение считает сумма 3 и 4?",
		options: [
			{ label: "3 + 4", text: "Первый порядок" },
			{ label: "4 + 3", text: "Второй порядок" },
		],
		answer: ["3 + 4"],
		why: null,
		ask_confidence: true,
	},
	doubt_add: { claim_id: "c1", source: "check_failed", note: null },
};

function toolFor(name: ToolName) {
	const tool = TOOL_SCHEMAS[name];
	assert.ok(tool, `tool ${name} is missing from TOOL_SCHEMAS`);
	return tool;
}

function problems(name: ToolName, args: Record<string, unknown>): string[] {
	return validateArgs(toolFor(name).parameters, args);
}

test("canonicalization drops no keywords for every tool", () => {
	assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...TOOL_NAMES].sort());
	for (const raw of RAW_TOOL_SCHEMAS) {
		const { dropped } = canonicalizeTool(raw);
		assert.deepEqual(dropped, [], `tool ${raw.name} lost schema keywords`);
	}
});

test("every tool keeps its name and description", () => {
	for (const name of TOOL_NAMES) {
		const tool = toolFor(name);
		assert.equal(tool.name, name);
		assert.ok(tool.description.length > 0, `${name}: empty description`);
	}
});

test("minimal correct arguments validate clean", () => {
	for (const name of TOOL_NAMES) {
		assert.deepEqual(problems(name, VALID_ARGS[name]), [], `${name}: unexpected problems`);
	}
});

test("unknown field is caught by every tool", () => {
	for (const name of TOOL_NAMES) {
		const args = { ...VALID_ARGS[name], unexpected_field: "мусор" };
		assert.deepEqual(problems(name, args), ['$: unknown field "unexpected_field"'], `${name}: leaked extra field`);
	}
});

test("missing required field is caught by every tool", () => {
	for (const name of TOOL_NAMES) {
		const required = toolFor(name).parameters.required ?? [];
		assert.ok(required.length > 0, `${name}: schema declares no required fields`);
		for (const key of required) {
			const args = { ...VALID_ARGS[name] };
			delete args[key];
			const found = problems(name, args);
			assert.ok(
				found.some((text) => text === `$.${key}: required field is missing`),
				`${name}: missing ${key} not reported (${JSON.stringify(found)})`,
			);
		}
	}
});

test("check_understanding enforces question, answer and options bounds", () => {
	const base = VALID_ARGS.check_understanding;
	assert.ok(problems("check_understanding", { ...base, question: "" }).some((t) => t.includes("$.question")));
	assert.ok(
		problems("check_understanding", { ...base, question: "ас" }).some((t) => t.includes("shorter than minLength 8")),
	);
	const noAnswer = { ...base };
	delete noAnswer.answer;
	assert.ok(problems("check_understanding", noAnswer).some((t) => t === "$.answer: required field is missing"));
	const oneOption = { ...base, options: [{ label: "3 + 4", text: "Первый порядок" }] };
	assert.ok(problems("check_understanding", oneOption).some((t) => t.includes("fewer than minItems 2")));
});

test("record_step checks kind and premises shape", () => {
	const base = VALID_ARGS.record_step;
	const badKind = problems("record_step", { ...base, kind: "guess" });
	assert.ok(badKind.some((t) => t.includes("$.kind") && t.includes("is not one of")));
	assert.deepEqual(problems("record_step", { ...base, premises: ["n1", "c7"] }), []);
	const numeric = problems("record_step", { ...base, kind: "derivation", premises: [42] });
	assert.ok(numeric.some((t) => t.includes("$.premises[0]") && t.includes("expected string, got integer")));
});

test("plan_set requires nodes and string-only depends_on", () => {
	assert.deepEqual(problems("plan_set", {}), ['$.nodes: required field is missing']);
	const [node] = VALID_ARGS.plan_set.nodes as Array<Record<string, unknown>>;
	assert.ok(node);
	const numeric = problems("plan_set", { nodes: [{ ...node, depends_on: [7] }] });
	assert.ok(numeric.some((t) => t.includes("depends_on[0]") && t.includes("expected string, got integer")));
});

test("validator text is stable across repeated calls on the same input", () => {
	const bad = { ...VALID_ARGS.check_understanding, kind: "maybe", unexpected: 1, question: "ас" };
	const first = problems("check_understanding", bad);
	const second = problems("check_understanding", bad);
	assert.ok(first.length >= 3, `expected several problems, got ${JSON.stringify(first)}`);
	assert.deepEqual(second, first);
});
