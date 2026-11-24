import test from "node:test";
import assert from "node:assert/strict";
import { createFakeTransport } from "../src/fakeTransport.ts";
import { createToolCallAccumulator } from "../src/toolCalls.ts";
import type { Request, ToolResultBlock, TransportEvent } from "../src/types.ts";

type TextDelta = Extract<TransportEvent, { type: "text_delta" }>;
type ToolCallDelta = Extract<TransportEvent, { type: "tool_call_delta" }>;
type DoneEvent = Extract<TransportEvent, { type: "done" }>;

async function collect(events: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
	const seen: TransportEvent[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}

function textDeltas(events: TransportEvent[]): TextDelta[] {
	return events.filter((e): e is TextDelta => e.type === "text_delta");
}

function toolCallDeltas(events: TransportEvent[]): ToolCallDelta[] {
	return events.filter((e): e is ToolCallDelta => e.type === "tool_call_delta");
}

function doneOf(events: TransportEvent[]): DoneEvent {
	const last = events.at(-1);
	if (!last || last.type !== "done") assert.fail(`expected a done event, got ${JSON.stringify(last)}`);
	return last;
}

function requestWith(text: string): Request {
	return {
		system: "система",
		messages: [{ role: "user", content: [{ type: "text", text }] }],
		tools: [],
		budget: { input: 8000, output: 1000 },
		reasoningLevel: "none",
	};
}

const TEXT = "объяснение шага";

test("a text turn arrives as several deltas and ends with done/end", async () => {
	const transport = createFakeTransport({ turns: [{ text: TEXT }] });
	const events = await collect(transport.stream(requestWith("цель")));

	const deltas = textDeltas(events);
	assert.ok(deltas.length > 1, `expected several deltas, got ${deltas.length}`);
	assert.equal(deltas.map((d) => d.text).join(""), TEXT);

	// StopReason in the internal format is end|tool_use|length|error, not "stop".
	const done = doneOf(events);
	assert.equal(done.stop, "end");
	assert.deepEqual(done.usage, { input: 11, inputCacheRead: 0, output: TEXT.length, reasoning: 0 });
});

test("call args arrive as deltas that glue into valid JSON", async () => {
	const args = { statement: "шаг", kind: "foundation" };
	const transport = createFakeTransport({
		turns: [{ thinking: "думаю", calls: [{ id: "call_1", name: "record_step", args }] }],
	});
	const events = await collect(transport.stream(requestWith("цель")));

	// Thinking comes as one delta, whatever its length.
	assert.deepEqual(
		events.filter((e) => e.type === "thinking_delta"),
		[{ type: "thinking_delta", text: "думаю" }],
	);

	const raw = toolCallDeltas(events).map((d) => d.args_part ?? "").join("");
	assert.deepEqual(JSON.parse(raw), args);

	const acc = createToolCallAccumulator();
	for (const event of events) acc.apply(event);
	const { calls, truncated } = acc.finish("tool_use");
	assert.deepEqual(calls, [{ type: "tool_call", id: "call_1", name: "record_step", args }]);
	assert.deepEqual(truncated, []);
	assert.equal(doneOf(events).stop, "tool_use");
	// The opening delta is the one that carries id and name.
	assert.deepEqual(toolCallDeltas(events)[0], {
		type: "tool_call_delta",
		index: 0,
		id: "call_1",
		name: "record_step",
	});
});

test("stop length with a cut argument leaves no call, only truncated", async () => {
	const transport = createFakeTransport({
		turns: [
			{ stop: "length", calls: [{ id: "call_cut", name: "record_step", args: { statement: "шаг без конца" } }] },
		],
	});
	const events = await collect(transport.stream(requestWith("цель")));
	assert.equal(doneOf(events).stop, "length");

	// Simulate the budget running out inside the last chunk of the arguments.
	const deltas = toolCallDeltas(events);
	const lastArgs = deltas.findLastIndex((d) => d.args_part !== undefined);
	const kept = deltas.filter((_, i) => i !== lastArgs);
	assert.throws(() => JSON.parse(kept.map((d) => d.args_part ?? "").join("")));

	const acc = createToolCallAccumulator();
	for (const delta of kept) acc.apply(delta);
	const { calls, truncated } = acc.finish("length");
	assert.deepEqual(calls, []);
	assert.deepEqual(truncated, ["call_cut"]);
});

test("an already aborted signal stops the iteration before any event", async () => {
	const transport = createFakeTransport({ turns: [{ text: TEXT }] });
	const events = await collect(transport.stream(requestWith("цель"), AbortSignal.abort()));
	assert.deepEqual(events, []);
	assert.deepEqual(transport.calls(), []);
});

test("a scripted error ends the turn with stop error and its text", async () => {
	const transport = createFakeTransport({ turns: [{ error: "HTTP 500 от сервера" }] });
	const events = await collect(transport.stream(requestWith("цель")));
	assert.deepEqual(events, [
		{
			type: "done",
			stop: "error",
			error: "HTTP 500 от сервера",
			usage: { input: 11, inputCacheRead: 0, output: 0, reasoning: 0 },
		},
	]);
});

test("queued tool results travel in the next request", async () => {
	const transport = createFakeTransport({
		turns: [
			{ calls: [{ id: "call_1", name: "record_step", args: { statement: "шаг" } }] },
			{ text: "ок" },
			{ text: "ещё" },
		],
	});
	const base = requestWith("цель");
	await collect(transport.stream(base));

	// The caller owns persistence and replays the assistant turn it was given.
	const previous = transport.calls()[0]!;
	const results: ToolResultBlock[] = [{ type: "tool_result", tool_call_id: "call_1", content: "шаг записан" }];
	transport.queueToolResults(results);
	await collect(
		transport.stream({ ...base, messages: [...base.messages, { role: "assistant", content: previous.responses }] }),
	);

	const blocks = transport.calls()[1]!.request.messages.flatMap((m) => m.content);
	assert.deepEqual(
		blocks.filter((b) => b.type === "tool_result"),
		results,
	);
	assert.equal(blocks.filter((b) => b.type === "tool_call").length, 1);

	// The queue is drained by that send: the next request carries no results.
	await collect(transport.stream(base));
	const later = transport.calls()[2]!.request.messages.flatMap((m) => m.content);
	assert.deepEqual(later.filter((b) => b.type === "tool_result"), []);
});
