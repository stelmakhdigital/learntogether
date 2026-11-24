import test from "node:test";
import assert from "node:assert/strict";
import { repairArgs } from "../src/repair.ts";
import type { CanonicalSchema, RepairOutcome } from "../src/repair.ts";

// Smallest schema that covers the rules: a number, a boolean, an array of
// strings, an enum, an optional field, a protected text field, a reference, and
// the record_step pair (kind + premises).
const schema: CanonicalSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		step_id: { type: "string" },
		limit: { type: "number" },
		ask_confidence: { type: "boolean" },
		claim_refs: { type: "array", items: { type: "string" } },
		kind: { type: "string", enum: ["derivation", "foundation"] },
		motivation: { type: ["string", "null"] },
		premises: { type: "array", items: { type: "string" } },
		question: { type: "string" },
		options: {
			type: "array",
			items: { type: "object", properties: { label: { type: "string" } } },
		},
		answer: { type: ["number", "null"] },
	},
};

function ok(result: RepairOutcome): Extract<RepairOutcome, { value: Record<string, unknown> }> {
	if ("error" in result) assert.fail(`unexpected error: ${result.error}`);
	return result;
}

test("a number in a string is coerced and written down in repairs", () => {
	const result = ok(repairArgs(schema, { limit: "12" }));
	assert.equal(result.value.limit, 12);
	assert.deepEqual(result.repairs, [{ level: 1, field: "limit", from: '"12"', to: "12" }]);
});

test('"true" becomes a boolean', () => {
	const result = ok(repairArgs(schema, { ask_confidence: "true" }));
	assert.equal(result.value.ask_confidence, true);
	assert.deepEqual(result.repairs, [{ level: 1, field: "ask_confidence", from: '"true"', to: "true" }]);
});

test("a JSON string becomes the array it holds, both directions", () => {
	const fromString = ok(repairArgs(schema, { claim_refs: '["a","b"]' }));
	assert.deepEqual(fromString.value.claim_refs, ["a", "b"]);
	assert.equal(fromString.repairs.length, 1);
	assert.equal(fromString.repairs[0]?.field, "claim_refs");

	const wrapped = ok(repairArgs(schema, { claim_refs: ['["a","b"]'] }));
	assert.deepEqual(wrapped.value.claim_refs, ["a", "b"]);
	assert.equal(wrapped.repairs.length, 1);
});

test("enum case is normalized to the value the schema declares", () => {
	const result = ok(repairArgs(schema, { kind: " Derivation ", premises: ["n1"] }));
	assert.equal(result.value.kind, "derivation");
	assert.deepEqual(result.repairs, [{ level: 1, field: "kind", from: '" Derivation "', to: '"derivation"' }]);
});

test("null in an optional field means the field is absent", () => {
	const result = ok(repairArgs(schema, { motivation: null }));
	assert.deepEqual(result.value, {});
	assert.deepEqual(result.repairs, [{ level: 1, field: "motivation", from: "null", to: "absent" }]);
});

test("protected fields are refused, not fixed", () => {
	assert.deepEqual(repairArgs(schema, { question: "  что такое вектор?  " }), {
		error: "protected field question",
	});
	assert.deepEqual(repairArgs(schema, { step_id: "step_1 " }), { error: "protected field step_id" });
});

test("duplicate option labels are a level 2 error", () => {
	const result = repairArgs(schema, {
		options: [{ label: "вектор" }, { label: " вектор " }],
	});
	assert.deepEqual(result, { error: 'options contain a duplicate label: "вектор"' });
});

test("answer must point at an existing option", () => {
	const byIndex = ok(repairArgs(schema, { options: [{ label: "а" }, { label: "б" }], answer: 1 }));
	assert.deepEqual(byIndex.repairs, []);
	const byLabel = ok(repairArgs(schema, { options: [{ label: "а" }, { label: "б" }], answer: "б" }));
	assert.deepEqual(byLabel.repairs, []);
	assert.deepEqual(repairArgs(schema, { options: [{ label: "а" }], answer: 3 }), {
		error: "answer does not reference an existing option: 3",
	});
});

test("derivation needs premises, foundation must not have them", () => {
	assert.deepEqual(repairArgs(schema, { kind: "derivation", premises: [] }), {
		error: 'premises must not be empty when kind is "derivation"',
	});
	assert.deepEqual(repairArgs(schema, { kind: "foundation", premises: ["n1"] }), {
		error: 'premises must be empty when kind is "foundation"',
	});
});

test("a null in a protected field means absent and is not an error", () => {
	const result = ok(repairArgs(schema, { answer: null, question: "вопрос" }));
	assert.deepEqual(result.value, { question: "вопрос" });
	assert.deepEqual(result.repairs, [{ level: 1, field: "answer", from: "null", to: "absent" }]);
});

test("protected content survives every coercion untouched", () => {
	// The invariant the whole honesty threshold rests on: whatever the model emits
	// in a protected field, the repaired call carries the same bytes.
	const cases: Record<string, unknown>[] = [
		{ question: "  вопрос  ", answer: 1, options: [{ label: " а " }] },
		{ question: null, answer: null, options: "[]" },
		{ question: "вопрос", answer: "0", options: [{ label: "а" }, { label: "б" }] },
	];
	for (const args of cases) {
		const result = repairArgs(schema, args);
		if ("error" in result) continue; // refused outright: nothing was rewritten
		for (const field of ["question", "answer", "options"]) {
			assert.deepEqual(result.value[field], args[field], `${field} changed`);
		}
	}
});

test("clean arguments come back unchanged with an empty repairs", () => {
	const args = {
		step_id: "step_1",
		limit: 3,
		kind: "foundation",
		premises: [],
		question: "вопрос",
		options: [{ label: "а" }, { label: "б" }],
		answer: 0,
	};
	const result = ok(repairArgs(schema, args));
	assert.deepEqual(result.repairs, []);
	assert.deepEqual(result.value, args);
});
