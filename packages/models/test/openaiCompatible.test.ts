// Replay tests on the recorded llama.cpp traces (docs/probes/raw) plus tests of
// the request shape and of the shapes no trace contains. The trace files are the
// source of truth: the expected values below are read off them by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	createOpenAICompatibleTransport,
	type FetchFn,
	type OpenAICompatibleProfile,
	type OpenAICompatibleTransport,
} from "../src/openaiCompatible.ts";
import { createToolCallAccumulator } from "../src/toolCalls.ts";
import type { Request, ToolCallBlock, ToolDefinition, TransportEvent, Usage } from "../src/types.ts";

type DoneEvent = Extract<TransportEvent, { type: "done" }>;
type ReasoningLevel = Request["reasoningLevel"];

const TRACES = new URL("../../../docs/probes/raw/", import.meta.url);

function trace(name: string): string {
	return readFileSync(new URL(`${name}_raw.txt`, TRACES), "utf8");
}

const TOOL: ToolDefinition = {
	description: "объявить шаг до объяснения",
	name: "record_step",
	parameters: {
		additionalProperties: false,
		properties: { kind: { enum: ["derivation", "foundation"], type: "string" }, statement: { type: "string" } },
		required: ["kind", "statement"],
		type: "object",
	},
};

function request(reasoningLevel: ReasoningLevel = "none"): Request {
	return {
		budget: { input: 4096, output: 512 },
		messages: [{ content: [{ text: "объясни, что такое вектор", type: "text" }], role: "user" }],
		reasoningLevel,
		system: "система урока",
		tools: [TOOL],
	};
}

/** Answers with the given SSE text, cut every 64 bytes so that a UTF-8 sequence
 *  and an SSE event both straddle reads — the parser must not care where it cuts. */
function replayFetch(text: string): FetchFn & { sent: { init: RequestInit; url: string }[] } {
	const sent: { init: RequestInit; url: string }[] = [];
	const fetch: FetchFn & { sent: { init: RequestInit; url: string }[] } = Object.assign(
		async (url: string, init: RequestInit) => {
			sent.push({ init, url });
			const bytes = new TextEncoder().encode(text);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.subarray(i, i + 64));
						controller.close();
					},
				}),
			);
		},
		{ sent },
	);
	return fetch;
}

function transportFor(fetch: FetchFn): OpenAICompatibleTransport {
	return createOpenAICompatibleTransport({
		baseUrl: "http://127.0.0.1:8123/v1",
		fetch,
		model: "/home/arka/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
	});
}

async function collect(events: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
	const seen: TransportEvent[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}

function doneOf(events: TransportEvent[]): DoneEvent {
	const last = events.at(-1);
	if (!last || last.type !== "done") assert.fail(`expected a done event, got ${JSON.stringify(last)}`);
	return last;
}

function usageOf(events: TransportEvent[]): Usage {
	const seen = events.flatMap((e) => (e.type === "usage" ? [e.usage] : []));
	assert.equal(seen.length, 1, `expected exactly one usage event, got ${seen.length}`);
	return seen[0]!;
}

/** Assembly is the accumulator's job, so the adapter is checked through it. */
function assemble(events: TransportEvent[]): { calls: ToolCallBlock[]; truncated: string[] } {
	const acc = createToolCallAccumulator();
	for (const event of events) acc.apply(event);
	return acc.finish(doneOf(events).stop);
}

function rawArgs(events: TransportEvent[]): string {
	return events.flatMap((e) => (e.type === "tool_call_delta" ? [e.args_part ?? ""] : [])).join("");
}

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const STATEMENT = "вектор — это стрелка с длиной";
const PROBE4_ARGS = { kind: "foundation", statement: STATEMENT };

test("probe4 replays into one record_step call assembled by the accumulator", async () => {
	const events = await collect(transportFor(replayFetch(trace("probe4"))).stream(request()));

	// The server sent no text at all: content was null in the first chunk.
	assert.deepEqual(events.filter((e) => e.type === "text_delta"), []);
	// Arguments arrived as many deltas, which is why the accumulator is needed.
	const parts = events.filter((e) => e.type === "tool_call_delta" && e.args_part !== undefined);
	assert.ok(parts.length > 20, `expected the args to be split into many deltas, got ${parts.length}`);

	const call: ToolCallBlock = { args: PROBE4_ARGS, id: "pEkCGi73MkUZxuJkU0mwskq4ya8bzf7H", name: "record_step", type: "tool_call" };
	assert.deepEqual(assemble(events), { calls: [call], truncated: [] });

	assert.deepEqual(usageOf(events), { input: 208, inputCacheRead: 0, output: 36, reasoning: Number.NaN });
	assert.deepEqual(doneOf(events), { stop: "tool_use", type: "done", usage: usageOf(events) });
});

test("probe5 cut by the budget is a dead call, not a repaired one", async () => {
	const events = await collect(transportFor(replayFetch(trace("probe5"))).stream(request()));

	const done = doneOf(events);
	assert.equal(done.stop, "length");
	// Rule 3: the fragment is exactly what the server sent and JSON.parse rejects
	// it; the adapter does not close the brace and the accumulator drops the call.
	assert.equal(rawArgs(events), '{"statement": "вектор — это');
	assert.throws(() => JSON.parse(rawArgs(events)));
	assert.deepEqual(assemble(events), { calls: [], truncated: ["CerIiZCECH0VFwz0qx2BfBqzD2V89pDZ"] });

	assert.deepEqual(usageOf(events), { input: 208, inputCacheRead: 207, output: 20, reasoning: Number.NaN });
});

test("probe6 replays two calls in index order, both parseable", async () => {
	const events = await collect(transportFor(replayFetch(trace("probe6"))).stream(request()));

	const indexes = [...new Set(events.flatMap((e) => (e.type === "tool_call_delta" ? [e.index] : [])))];
	assert.deepEqual(indexes, [0, 1]);

	const { calls, truncated } = assemble(events);
	assert.deepEqual(truncated, []);
	assert.deepEqual(calls, [
		{ args: { kind: "foundation", statement: STATEMENT }, id: "fBPiurdzph2MgK3B1l0qypdOqrh5FyQN", name: "record_step", type: "tool_call" },
		{
			args: { kind: "derivation", statement: "из этого следует что у вектора есть направление" },
			id: "dv5Nur1YKe9sudjsrvUsfeRxCbV5ryIr",
			name: "record_step",
			type: "tool_call",
		},
	]);
	assert.deepEqual(usageOf(events), { input: 241, inputCacheRead: 187, output: 73, reasoning: Number.NaN });
	assert.equal(doneOf(events).stop, "tool_use");
});

test("probe7 (server without --jinja) replays the same as probe4", async () => {
	const events = await collect(transportFor(replayFetch(trace("probe7"))).stream(request()));

	const { calls, truncated } = assemble(events);
	assert.deepEqual(truncated, []);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.args, PROBE4_ARGS);
	assert.equal(calls[0]!.name, "record_step");
	// The call id is generated per request, so only its presence is comparable.
	assert.ok(calls[0]!.id.length > 0);
	assert.equal(calls[0]!.id === "pEkCGi73MkUZxuJkU0mwskq4ya8bzf7H", false);

	assert.deepEqual(usageOf(events), { input: 208, inputCacheRead: 0, output: 36, reasoning: Number.NaN });
	assert.equal(doneOf(events).stop, "tool_use");
});

test("a stream of only [DONE] is an error, not an empty end_turn", async () => {
	for (const text of ["data: [DONE]\n\n", ": keep-alive\n\ndata: [DONE]\n\n"]) {
		const events = await collect(transportFor(replayFetch(text)).stream(request()));
		assert.equal(events.length, 1, `expected only the done event, got ${JSON.stringify(events)}`);
		const done = doneOf(events);
		assert.equal(done.stop, "error");
		assert.match(done.error ?? "", /finish_reason/);
		// No usage came, so no number is invented for it (D-006).
		assert.ok(Number.isNaN(done.usage.input));
	}
});

test("a body cut mid-line ends the iterator and reports an error", async () => {
	const full = trace("probe4");
	const cut = full.slice(0, Math.floor(full.length / 2));
	// The cut lands inside a data line: the last event of the body has no terminator.
	assert.equal(cut.endsWith("\n\n"), false);
	// No test timeout here is a hang: the iterator has to finish on its own.
	const events = await collect(transportFor(replayFetch(cut)).stream(request()));

	const done = doneOf(events);
	assert.equal(done.stop, "error");
	assert.match(done.error ?? "", /finish_reason/);
	// What did arrive before the cut is still reported as deltas.
	assert.ok(rawArgs(events).length > 0);
});

test("an already aborted signal ends the iteration without events", async () => {
	const events = await collect(
		transportFor(replayFetch(trace("probe4"))).stream(request(), AbortSignal.abort()),
	);
	assert.deepEqual(events, []);
});

test("aborting mid-stream ends the iterator instead of hanging on the server", async () => {
	const controller = new AbortController();
	const seen: TransportEvent[] = [];
	for await (const event of transportFor(replayFetch(trace("probe6"))).stream(request(), controller.signal)) {
		seen.push(event);
		if (seen.length === 5) controller.abort();
	}
	// The iterator closed on its own and added nothing after the cancellation.
	assert.equal(seen.length, 5);
	assert.equal(seen.some((event) => event.type === "done"), false);
});

test("HTTP 500 throws with the status and the server's own text", async () => {
	const transport = transportFor(async () => new Response("llama_server: no memory left", { status: 500 }));
	await assert.rejects(
		() => collect(transport.stream(request())),
		(error: unknown) => {
			assert.match(String(error), /HTTP 500/);
			assert.match(String(error), /no memory left/);
			return true;
		},
	);
});

test("the request carries the budget and no keys we did not probe for", async () => {
	const fetch = replayFetch(trace("probe4"));
	await collect(transportFor(fetch).stream(request()));

	assert.equal(fetch.sent.length, 1);
	assert.equal(fetch.sent[0]!.url, "http://127.0.0.1:8123/v1/chat/completions");
	const body = JSON.parse(String(fetch.sent[0]!.init.body)) as Record<string, unknown>;
	assert.equal(body.max_tokens, 512);
	assert.equal(body.model, "/home/arka/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf");
	assert.equal(body.stream, true);
	assert.deepEqual(body.stream_options, { include_usage: true });
	// Rule 4 and the sampling decision: neither key is sent at all.
	assert.equal("tool_choice" in body, false);
	assert.equal("temperature" in body, false);
	assert.deepEqual(body.tools, [{ function: TOOL, type: "function" }]);
	assert.deepEqual(body.messages, [
		{ content: "система урока", role: "system" },
		{ content: "объясни, что такое вектор", role: "user" },
	]);
});

test("thinking arrives as thinking_delta and is never sent back", async () => {
	const stream =
		sse({ choices: [{ delta: { reasoning_content: "думаю", role: "assistant" }, finish_reason: null, index: 0 }] }) +
		sse({ choices: [{ delta: { content: "шаг" }, finish_reason: null, index: 0 }] }) +
		sse({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] }) +
		"data: [DONE]\n\n";
	const fetch = replayFetch(stream);
	const events = await collect(transportFor(fetch).stream(request()));
	assert.deepEqual(events.slice(0, 2), [
		{ text: "думаю", type: "thinking_delta" },
		{ text: "шаг", type: "text_delta" },
	]);
	assert.equal(doneOf(events).stop, "end");

	// Replay of an assistant turn: thinking block dropped, call and result kept.
	const base: Request = {
		...request(),
		messages: [
			{ content: [{ text: "объясни", type: "text" }], role: "user" },
			{
				content: [
					{ text: "думаю", type: "thinking" },
					{ args: PROBE4_ARGS, id: "call_1", name: "record_step", type: "tool_call" },
				],
				role: "assistant",
			},
			{ content: [{ content: "шаг записан", tool_call_id: "call_1", type: "tool_result" }], role: "user" },
		],
	};
	await collect(transportFor(fetch).stream(base));
	const body = JSON.parse(String(fetch.sent.at(-1)!.init.body)) as { messages: unknown[] };
	assert.deepEqual(body.messages, [
		{ content: "система урока", role: "system" },
		{ content: "объясни", role: "user" },
		{
			content: "",
			role: "assistant",
			tool_calls: [{ function: { arguments: JSON.stringify(PROBE4_ARGS), name: "record_step" }, id: "call_1", type: "function" }],
		},
		{ content: "шаг записан", role: "tool", tool_call_id: "call_1" },
	]);
});

test("reasoningLevel above none is refused, not guessed", async () => {
	const transport = transportFor(replayFetch(trace("probe4")));
	assert.throws(() => transport.stream(request("low")), /reasoningLevel "low" is not supported/);
});

test("a profile without baseUrl or model is an error naming the field", () => {
	// A profile arrives from user config or from the database, so the fields can be
	// missing whatever the type says; the error has to name the missing one.
	const partial = (profile: Partial<OpenAICompatibleProfile>) => profile as OpenAICompatibleProfile;
	assert.throws(
		() => createOpenAICompatibleTransport(partial({ baseUrl: "", model: "m" })),
		/profile field "baseUrl" is required and has no default/,
	);
	assert.throws(
		() => createOpenAICompatibleTransport(partial({ baseUrl: "http://127.0.0.1:8123/v1" })),
		/profile field "model" is required and has no default/,
	);
	assert.throws(() => createOpenAICompatibleTransport(partial({})), /profile field "baseUrl" is required/);
});

test("a measured context window is handed back, an unprobed one stays absent", () => {
	const withWindow = createOpenAICompatibleTransport({
		baseUrl: "http://127.0.0.1:8123/v1",
		contextWindow: 6144,
		fetch: replayFetch(trace("probe4")),
		model: "m",
	});
	assert.equal(withWindow.contextWindow, 6144);

	const unprobed = createOpenAICompatibleTransport({
		baseUrl: "http://127.0.0.1:8123/v1",
		fetch: replayFetch(trace("probe4")),
		model: "m",
	});
	assert.equal("contextWindow" in unprobed, false);
});
