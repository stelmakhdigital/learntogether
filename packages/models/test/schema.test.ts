import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeTool, validateArgs } from "../src/schema.ts";
import type { CanonicalSchema } from "../src/repair.ts";

const raw = {
	name: "graph_search",
	description: "найти по графу",
	parameters: {
		type: "object",
		title: "поиск",
		oneOf: [],
		properties: {
			query: { type: "string", format: "date", minLength: 1 },
			limit: { type: "integer", minimum: 1, maximum: 20 },
			nodes: {
				type: "array",
				items: { type: "object", properties: { id: { type: "string" }, tag: { type: "string", pattern: "^[a-z]+$" } }, required: ["id"] },
			},
		},
		required: ["query"],
	},
};

test("unsupported keywords are dropped and reported by path", () => {
	const { tool, dropped } = canonicalizeTool(raw);
	// Nested paths come first, root keywords last: traversal order, and the same
	// for the same input every time.
	assert.deepEqual(dropped, [
		"properties.nodes.items.properties.tag.pattern",
		"properties.query.format",
		"oneOf",
		"title",
	]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(tool.parameters.required, ["query"]);
	assert.equal(tool.parameters.properties.query?.type, "string");
	// Inside the array items only "id" was required, so "tag" became optional too.
	assert.deepEqual(tool.parameters.properties.nodes?.items?.properties?.tag?.type, ["string", "null"]);
	assert.equal(tool.parameters.properties.nodes?.items?.properties?.id?.type, "string");
	assert.equal("pattern" in (tool.parameters.properties.nodes?.items?.properties?.tag ?? {}), false);
});

test("an optional property becomes a two-element type, a required one stays single", () => {
	const { tool } = canonicalizeTool(raw);
	assert.deepEqual(tool.parameters.properties.limit?.type, ["integer", "null"]);
	assert.equal(tool.parameters.properties.query?.type, "string");
});

test("a root without properties is refused", () => {
	assert.throws(
		() => canonicalizeTool({ name: "x", description: "", parameters: { type: "object" } }),
		/must be an object with "properties"/,
	);
	assert.throws(() => canonicalizeTool({ name: "x", description: "", parameters: [] }), /must be an object/);
});

const schema = {
	type: "object",
	additionalProperties: false,
	required: ["statement", "kind"],
	properties: {
		statement: { type: "string", minLength: 3 },
		kind: { type: "string", enum: ["foundation", "derivation"] },
		limit: { type: ["integer", "null"] as const },
		score: { type: ["number", "null"] as const },
		premises: { type: ["array", "null"] as const, items: { type: "string" as const }, minItems: 1 },
	} satisfies CanonicalSchema["properties"],
} satisfies CanonicalSchema;

test("valid arguments produce no problems", () => {
	assert.deepEqual(
		validateArgs(schema as CanonicalSchema, {
			statement: "шаг",
			kind: "foundation",
			limit: null,
			score: 1.5,
			premises: null,
		}),
		[],
	);
});

test("problems are reported per field and sorted by field name", () => {
	const args = { extra: 1, statement: "ш", kind: "guess", limit: 1.5, score: "1", premises: [] };
	const problems = validateArgs(schema as CanonicalSchema, args);
	assert.deepEqual(problems, [
		"$.kind: \"guess\" is not one of \"foundation\", \"derivation\"",
		"$.limit: expected integer or null, got number",
		"$.premises: fewer than minItems 1",
		"$.score: expected number or null, got string",
		"$.statement: shorter than minLength 3",
		'$: unknown field "extra", здесь есть поля kind, limit, premises, score, statement',
	]);
	// The same input twice must give the same text: retry messages get compared.
	assert.deepEqual(validateArgs(schema as CanonicalSchema, args), problems);
});

test("integer rejects a fraction, number accepts it", () => {
	assert.deepEqual(validateArgs(schema as CanonicalSchema, { statement: "шаг", kind: "foundation", limit: 1.5 }), [
		"$.limit: expected integer or null, got number",
	]);
	assert.deepEqual(validateArgs(schema as CanonicalSchema, { statement: "шаг", kind: "foundation", limit: 3 }), []);
});

test("a required field that is absent is named", () => {
	assert.deepEqual(validateArgs(schema as CanonicalSchema, { kind: "foundation" }), [
		"$.statement: required field is missing",
	]);
});

test("array items are checked element by element", () => {
	assert.deepEqual(
		validateArgs(schema as CanonicalSchema, {
			statement: "шаг",
			kind: "derivation",
			premises: ["n1", 2],
		}),
		["$.premises[1]: expected string, got integer"],
	);
});
