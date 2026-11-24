import test from "node:test";
import assert from "node:assert/strict";
import { createFakeTransport, type FakeScript } from "@learntogether/models";
import type { Request } from "@learntogether/models";
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
