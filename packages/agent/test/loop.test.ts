import test from "node:test";
import assert from "node:assert/strict";
import { createFakeTransport, type FakeScript } from "@learntogether/models";
import type { Request, Transport, TransportEvent } from "@learntogether/models";
import { ToolRegistry, runTurn, type AgentEvent } from "@learntogether/agent";

const stepSchema = {
	type: "object" as const,
	additionalProperties: false as const,
	required: ["statement", "kind"],
	properties: {
		statement: { type: "string" as const, minLength: 1 },
		kind: { type: "string" as const, enum: ["foundation", "derivation"] },
		motivation: { type: ["string", "null"] as const },
	},
};

function registryWith(run: (args: Record<string, unknown>, callId: string) => string) {
	return new ToolRegistry([
		{ name: "record_step", description: "записать шаг", schema: stepSchema, run },
	]);
}

function request(text = "объясни"): Request {
	return {
		budget: { input: 8000, output: 1000 },
		messages: [{ content: [{ text, type: "text" }], role: "user" }],
		reasoningLevel: "none",
		system: "учитель",
		tools: [],
	};
}

/** Transport that throws instead of yielding an error event, which is what a real
 *  adapter does on a refused connection, a non-2xx response or a non-JSON SSE
 *  chunk (openaiCompatible.ts throws in all three cases). */
function throwingTransport(events: TransportEvent[], error: Error): Transport {
	return {
		stream(): AsyncIterable<TransportEvent> {
			return (async function* generate(): AsyncGenerator<TransportEvent> {
				for (const event of events) yield event;
				throw error;
			})();
		},
	};
}

type FinishedEvent = Extract<AgentEvent, { type: "finished" }>;

/** The one `finished` the turn owes the caller, whatever else the events say. */
function onlyFinished(events: AgentEvent[]): FinishedEvent {
	const finished = events.filter((event) => event.type === "finished");
	assert.equal(finished.length, 1, "ровно одно finished");
	const event = finished[0]!;
	assert(event.type === "finished");
	return event;
}

function collect(script: FakeScript, overrides: { maxSteps?: number; maxRejects?: number } = {}) {
	const transport = createFakeTransport(script);
	const events: AgentEvent[] = [];
	return {
		events,
		transport,
		run: async (registry: ToolRegistry, input: Request = request()) =>
			runTurn({
				onEvent: (event) => events.push(event),
				registry,
				request: input,
				transport,
				...overrides,
			}),
	};
}

test("a turn without calls returns its text and ends", async () => {
	const turn = collect({ turns: [{ text: "вектор — это набор чисел" }] });
	const result = await turn.run(registryWith(() => "не вызывался"));

	assert.equal(result.text, "вектор — это набор чисел");
	assert.equal(result.stop, "end");
	assert.deepEqual(result.calls, []);
	assert.equal(turn.events.filter((event) => event.type === "finished").length, 1);
});

test("a call runs, and its result goes back in the next request", async () => {
	const args = { kind: "foundation", statement: "вектор — набор чисел" };
	const seen: { args: Record<string, unknown>; callId: string }[] = [];
	const registry = registryWith((toolArgs, callId) => {
		seen.push({ args: toolArgs, callId });
		return "шаг записан";
	});
	const turn = collect({
		turns: [{ calls: [{ args, id: "call_1", name: "record_step" }] }, { text: "записал" }],
	});

	const result = await turn.run(registry);

	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0]?.args, args);
	assert.equal(result.text, "записал");
	assert.deepEqual(result.calls, [{ id: "call_1", name: "record_step", state: "valid" }]);

	const sent = turn.transport.calls();
	assert.equal(sent.length, 2, "the model was asked twice");
	const blocks = sent[1]!.request.messages.flatMap((message) => message.content);
	assert.equal(blocks.filter((block) => block.type === "tool_call").length, 1);
	const results = blocks.filter((block) => block.type === "tool_result");
	assert.deepEqual(results, [{ content: "шаг записан", tool_call_id: "call_1", type: "tool_result" }]);
});

test("arguments that never arrived are refused, not guessed", async () => {
	const registry = registryWith(() => "не должен запускатся");
	// Dead arguments are repeated once (contract level 3), so a second turn exists.
	const turn = collect({
		turns: [
			{ calls: [{ args: { statement: "обрезано", kind: "foundation" }, id: "cut", name: "record_step" }], stop: "length" },
			{ text: "повторю запрос" },
		],
	});

	const result = await turn.run(registry);

	const rejected = turn.events.filter((event) => event.type === "tool_rejected");
	assert.equal(rejected.length, 1);
	assert(rejected[0]?.type === "tool_rejected");
	assert.match(rejected[0].reason, /аргументы оборвались/);
	assert.equal(result.calls[0]?.state, "rejected");
	assert.equal(turn.transport.calls().length, 2, "the call was repeated once");
});

test("a tool that refuses is reported to the model and the turn continues", async () => {
	const registry = registryWith(() => {
		throw new Error("такого узла нет");
	});
	const turn = collect({
		turns: [{ calls: [{ args: { kind: "foundation", statement: "шаг" }, id: "c1", name: "record_step" }] }, { text: "понял" }],
	});

	const result = await turn.run(registry);

	assert.equal(result.text, "понял");
	assert.deepEqual(
		turn.events.filter((event) => event.type === "tool_result"),
		[{ type: "tool_result", content: "такого узла нет", id: "c1", name: "record_step", ok: false }],
	);
	assert.equal(result.calls[0]?.error, "такого узла нет");
});

test("arguments the schema refuses are sent back with the reason", async () => {
	const registry = registryWith(() => "не должен запускатся");
	const turn = collect({
		turns: [{ calls: [{ args: { kind: "guess", statement: "" }, id: "c1", name: "record_step" }] }, { text: "исправлюсь" }],
	});

	const result = await turn.run(registry, request());

	const rejected = turn.events.find((event) => event.type === "tool_rejected");
	assert(rejected?.type === "tool_rejected");
	assert.match(rejected.reason, /kind/);
	assert.match(rejected.reason, /minLength/);
	assert.equal(result.calls[0]?.state, "rejected");
});

test("a transport that throws before any event still gives exactly one error finish", async () => {
	const boom = new Error("openai-compatible: POST http://127.0.0.1:8123 failed with HTTP 500: upstream unavailable");
	// The adapter may throw from stream() itself (fetch refused, non-2xx) or from
	// the first next(): both are the same honest refusal for the caller.
	const throwsFromTheCall: Transport = {
		stream(): AsyncIterable<TransportEvent> {
			throw boom;
		},
	};

	for (const transport of [throwsFromTheCall, throwingTransport([], boom)]) {
		const events: AgentEvent[] = [];
		const result = await runTurn({
			onEvent: (event) => events.push(event),
			registry: registryWith(() => "не должен запускатся"),
			request: request(),
			transport,
		});

		const finished = onlyFinished(events);
		assert.equal(finished.stop, "error");
		assert.match(finished.error ?? "", /HTTP 500: upstream unavailable/);
		assert.equal(result.stop, "error");
		assert.equal(result.text, "");
	}
});

test("a throw while leaving the stream does not add a second finish", async () => {
	// We cancel mid-stream, the loop leaves the for-await, and closing the iterator
	// fails: the `finished` we already gave out must stay the only one.
	const controller = new AbortController();
	const transport: Transport = {
		stream(): AsyncIterable<TransportEvent> {
			const iterator: AsyncIterator<TransportEvent> = {
				async next() {
					controller.abort();
					return { done: false as const, value: { type: "text_delta" as const, text: "а" } };
				},
				async return(): Promise<IteratorResult<TransportEvent>> {
					throw new Error("поток не закрылся: connection reset");
				},
			};
			return { [Symbol.asyncIterator]: () => iterator };
		},
	};

	const events: AgentEvent[] = [];
	const result = await runTurn({
		onEvent: (event) => events.push(event),
		registry: registryWith(() => "не должен запускатся"),
		request: request(),
		signal: controller.signal,
		transport,
	});

	const finished = onlyFinished(events);
	assert.equal(finished.stop, "error");
	assert.equal(result.stop, "error");
});

test("text streamed before a throw survives as it does on the error-event path", async () => {
	const events: AgentEvent[] = [];
	const result = await runTurn({
		onEvent: (event) => events.push(event),
		registry: registryWith(() => "не должен запускатся"),
		request: request(),
		transport: throwingTransport(
			[
				{ type: "text_delta", text: "вектор — это " },
				{ type: "text_delta", text: "набор чисел" },
				{ index: 0, name: "record_step", type: "tool_call_delta", id: "c1" },
				{ args_part: '{"kind":', index: 0, type: "tool_call_delta" },
			],
			new Error("openai-compatible: POST failed with HTTP 500: upstream unavailable"),
		),
	});

	const finished = onlyFinished(events);
	assert.equal(finished.stop, "error");
	assert.match(finished.error ?? "", /HTTP 500/);
	assert.equal(result.text, "вектор — это набор чисел");
	// The same place the successful path keeps it: a text block of the response.
	// The half-arrived call is not there — a call without its result is refused.
	assert.deepEqual(result.blocks, [{ text: "вектор — это набор чисел", type: "text" }]);
});

test("a non-JSON SSE chunk that throws is reported with the adapter's own words", async () => {
	const events: AgentEvent[] = [];
	const result = await runTurn({
		onEvent: (event) => events.push(event),
		registry: registryWith(() => "не должен запускатся"),
		request: request(),
		transport: throwingTransport(
			[{ type: "text_delta", text: "начало объяснения" }],
			new Error('openai-compatible: SSE payload is not JSON: {"choices":[{bad'),
		),
	});

	const finished = onlyFinished(events);
	assert.equal(finished.stop, "error");
	assert.match(finished.error ?? "", /SSE payload is not JSON/);
	assert.equal(result.text, "начало объяснения");
});

test("an error event closes the turn with the server's own words too", async () => {
	const turn = collect({ turns: [{ error: "контекст переполнен: нужно 12000, доступно 8192" }] });
	const result = await turn.run(registryWith(() => "не должен запускатся"));

	const finished = onlyFinished(turn.events);
	assert.equal(finished.stop, "error");
	assert.match(finished.error ?? "", /нужно 12000/);
	assert.equal(result.stop, "error");
});

test("a throwing tool executor keeps its refusal inside the turn", async () => {
	const registry = registryWith(() => {
		throw new Error("база данных закрыта");
	});
	const turn = collect({
		turns: [
			{ calls: [{ args: { kind: "foundation", statement: "шаг" }, id: "c1", name: "record_step" }] },
			{ text: "не получилось" },
		],
	});

	const result = await turn.run(registry);

	// The refusal went back to the model as data, so the turn ended normally.
	const finished = onlyFinished(turn.events);
	assert.equal(finished.stop, "end");
	assert.equal(result.stop, "end");
	assert.equal(result.text, "не получилось");
});

test("an unknown tool name is refused while the rest of the turn runs", async () => {
	const registry = registryWith(() => "ок");
	const turn = createFakeTransport({
		turns: [
			{
				calls: [
					{ args: { kind: "foundation", statement: "шаг" }, id: "bad", name: "graph_search" },
					{ args: { kind: "foundation", statement: "шаг" }, id: "good", name: "record_step" },
				],
			},
			{ text: "готово" },
		],
	});

	const events: AgentEvent[] = [];
	const result = await runTurn({ onEvent: (event) => events.push(event), registry, request: request(), transport: turn });

	assert.equal(
		events.filter((event) => event.type === "tool_rejected").length,
		1,
	);
	assert.deepEqual(
		result.calls.map((call) => call.state),
		["rejected", "valid"],
	);
	assert.equal(result.text, "готово");
});

test("running out of steps ends the turn as truncated", async () => {
	const registry = registryWith(() => "ок");
	const turn = createFakeTransport({
		turns: [
			{ calls: [{ args: { kind: "foundation", statement: "а" }, id: "1", name: "record_step" }] },
			{ calls: [{ args: { kind: "foundation", statement: "б" }, id: "2", name: "record_step" }] },
			{ text: "не дошли" },
		],
	});

	const events: AgentEvent[] = [];
	const result = await runTurn({
		maxSteps: 1,
		onEvent: (event) => events.push(event),
		registry,
		request: request(),
		transport: turn,
	});

	assert.equal(result.stop, "length");
	assert.equal(events.filter((event) => event.type === "finished").length, 1);
});

test("an already cancelled signal stops before the model is asked", async () => {
	const registry = registryWith(() => "ок");
	const turn = collect({ turns: [{ text: "не нужно" }] });
	const events: AgentEvent[] = [];

	const result = await runTurn({
		onEvent: (event) => events.push(event),
		registry,
		request: request(),
		signal: AbortSignal.abort(),
		transport: turn.transport,
	});

	assert.equal(result.stop, "error");
	assert.deepEqual(turn.transport.calls(), []);
	assert.equal(events.filter((event) => event.type === "finished").length, 1);
});

test("repeating the same refusal gives up instead of burning the budget", async () => {
	const registry = new ToolRegistry([
		{
			name: "record_step",
			description: "записать шаг",
			schema: stepSchema,
			run: () => "ок",
		},
	]);
	const turn = createFakeTransport({
		turns: [
			{ calls: [{ args: { kind: "нет", statement: "шаг" }, id: "1", name: "record_step" }] },
			{ calls: [{ args: { kind: "нет", statement: "шаг" }, id: "2", name: "record_step" }] },
			{ calls: [{ args: { kind: "нет", statement: "шаг" }, id: "3", name: "record_step" }] },
		],
	});

	const events: AgentEvent[] = [];
	const result = await runTurn({ maxRejects: 1, onEvent: (event) => events.push(event), registry, request: request(), transport: turn });

	assert.equal(result.stop, "error");
	assert.equal(events.filter((event) => event.type === "tool_rejected").length, 2);
	assert.equal(turn.calls().length, 2, "the model is not asked a third time");
});

test("duplicate tool names are refused at startup", () => {
	assert.throws(
		() =>
			new ToolRegistry([
				{ name: "record_step", description: "", schema: stepSchema, run: () => "" },
				{ name: "record_step", description: "", schema: stepSchema, run: () => "" },
			]),
		/record_step/,
	);
});

test("definitions are alphabetical so the request prefix stays stable", () => {
	const registry = new ToolRegistry([
		{ name: "record_step", description: "", schema: stepSchema, run: () => "" },
		{ name: "check_understanding", description: "", schema: stepSchema, run: () => "" },
	]);
	assert.deepEqual(
		registry.definitions().map((definition) => definition.name),
		["check_understanding", "record_step"],
	);
});
