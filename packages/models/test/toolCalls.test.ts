import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallAccumulator } from "../src/toolCalls.ts";
import type { Usage } from "../src/types.ts";

const zeroUsage: Usage = { input: 0, inputCacheRead: 0, output: 0, reasoning: 0 };

test("args arrive as deltas and are glued by index", () => {
	const acc = createToolCallAccumulator();
	acc.apply({ type: "tool_call_delta", index: 0, id: "call_1", name: "graph_search" });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: '{"query":' });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: '"векторы", "limit": 3}' });
	acc.apply({ type: "done", stop: "tool_use", usage: zeroUsage });
	const { calls, truncated } = acc.finish("tool_use");
	assert.deepEqual(calls, [
		{ type: "tool_call", id: "call_1", name: "graph_search", args: { query: "векторы", limit: 3 } },
	]);
	assert.deepEqual(truncated, []);
});

test("args can arrive in a single chunk", () => {
	const acc = createToolCallAccumulator();
	acc.apply({
		type: "tool_call_delta",
		index: 0,
		id: "call_2",
		name: "record_step",
		args_part: '{"statement": "шаг", "kind": "foundation"}',
	});
	const { calls, truncated } = acc.finish("tool_use");
	assert.deepEqual(calls, [
		{ type: "tool_call", id: "call_2", name: "record_step", args: { statement: "шаг", kind: "foundation" } },
	]);
	assert.deepEqual(truncated, []);
});

test("empty and missing args_part between chunks stay allowed", () => {
	const acc = createToolCallAccumulator();
	acc.apply({ type: "tool_call_delta", index: 0, id: "call_3", name: "plan_set" });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: "" });
	acc.apply({ type: "text_delta", text: "" });
	acc.apply({ type: "tool_call_delta", index: 0 });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: '{"nodes":' });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: "" });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: '[{"node_id": "n1"}]}' });
	const { calls, truncated } = acc.finish("tool_use");
	assert.deepEqual(calls, [
		{ type: "tool_call", id: "call_3", name: "plan_set", args: { nodes: [{ node_id: "n1" }] } },
	]);
	assert.deepEqual(truncated, []);
});

test("a call cut off at length with unparseable args is truncated, not called", () => {
	const acc = createToolCallAccumulator();
	acc.apply({ type: "tool_call_delta", index: 0, id: "call_cut", name: "record_step" });
	acc.apply({ type: "tool_call_delta", index: 0, args_part: '{"statement": "шаг без конца' });
	acc.apply({ type: "done", stop: "length", usage: zeroUsage });
	const { calls, truncated } = acc.finish("length");
	assert.deepEqual(calls, []);
	assert.deepEqual(truncated, ["call_cut"]);
});
