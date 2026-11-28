// Contract tests on a fixture transport shaped like llama.cpp b12723 (see
// docs/probes/2026-11-25-llama-cpp.md). The probe talks to a fetch we hand it,
// so no live server is needed; the wire shapes below are copied from the
// recorded /props and /v1/models answers.

import test from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, type ModelProbe } from "../src/probe.ts";
import type { FetchFn } from "../src/openaiCompatible.ts";

const ROOT = "http://127.0.0.1:8123";
const MODEL = "/home/arka/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf";

const PROPS = {
	chat_template_caps: {
		supports_parallel_tool_calls: true,
		supports_reasoning_effort: false,
		supports_tool_calls: true,
		supports_tools: true,
	},
	default_generation_settings: { n_ctx: 6144, n_predict: -1 },
};

interface FixtureOptions {
	toolCalls?: boolean;
	nCtx?: number | null;
	// vLLM reports the window at the top level of the model entry instead.
	maxModelLen?: number;
	// A reasoning model can spend the probe's whole output allowance thinking.
	truncatedUntil?: number | null;
	promptTokens?: number;
	// Prompt size as reported by the measuring call (max_tokens 1).
	promptTokensAtOne?: number;
	tokenizeCount?: number;
	hasApplyTemplate?: boolean;
	hasProps?: boolean;
}

function fixture(options: FixtureOptions = {}): { calls: string[]; fetch: FetchFn } {
	const promptTokens = options.promptTokens ?? 208;
	const tokenizeCount = options.tokenizeCount ?? promptTokens;
	const toolCalls = options.toolCalls ?? true;
	const hasApplyTemplate = options.hasApplyTemplate ?? true;
	const hasProps = options.hasProps ?? true;
	const promptTokensAtOne = options.promptTokensAtOne ?? promptTokens;
	const calls: string[] = [];

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	const fetch: FetchFn = async (url, init) => {
		const path = new URL(url).pathname;
		calls.push(`${init?.method ?? "GET"} ${path}`);
		if (path === "/props") return hasProps ? json(PROPS) : new Response("not found", { status: 404 });
		if (path === "/v1/models") {
			const meta = options.nCtx === null ? {} : { n_ctx: options.nCtx ?? 6144, n_ctx_train: 32768 };
			const entry: Record<string, unknown> = { id: MODEL, meta };
			if (options.maxModelLen !== undefined) entry.max_model_len = options.maxModelLen;
			return json({ data: [entry], type: "list" });
		}
		if (path === "/v1/chat/completions") {
			const sent = JSON.parse(String(init?.body)) as { max_tokens?: number };
			const asking = sent.max_tokens === 1 ? promptTokensAtOne : promptTokens;
			// Below the retry allowance the model is still thinking: no call yet.
			const called = toolCalls && (options.truncatedUntil === undefined || options.truncatedUntil === null
				? true
				: (sent.max_tokens ?? 0) >= options.truncatedUntil);
			const truncated = !called && options.truncatedUntil !== undefined && options.truncatedUntil !== null;
			return json({
				choices: [
					{
						finish_reason: called ? "tool_calls" : truncated ? "length" : "stop",
						index: 0,
						message: called
							? { content: "", role: "assistant", tool_calls: [{ function: { arguments: '{"ping":"ok"}', name: "probe_ping" }, id: "c1", type: "function" }] }
							: { content: "готово", role: "assistant" },
					},
				],
				usage: { completion_tokens: 8, prompt_tokens: asking, total_tokens: asking + 8 },
			});
		}
		if (path === "/apply-template") {
			if (!hasApplyTemplate) return new Response("not found", { status: 404 });
			return json({ prompt: "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n" });
		}
		if (path === "/tokenize") return json({ tokens: new Array(tokenizeCount).fill(1), tokens_count: tokenizeCount });
		return new Response(`unexpected ${path}`, { status: 500 });
	};
	return { calls, fetch };
}

function profile(fetch: FetchFn) {
	return { baseUrl: ROOT, fetch, model: MODEL };
}

test("a full probe reads context, tools, reasoning and the tokenizer", async () => {
	const { fetch } = fixture();
	const probe = await probeEndpoint(profile(fetch));
	const expected: ModelProbe = {
		contextTokens: 6144,
		maxOutputTokens: null,
		modelId: MODEL,
		probeMethod: "props:chat_template_caps+v1/models:meta+tool-round-trip(512)+apply-template+tokenize==usage",
		supportsReasoning: false,
		supportsTools: true,
		tokenizerSource: "server",
	};
	assert.deepEqual(probe, expected);
});

test("n_predict of -1 is no measured output cap, kept as null", async () => {
	const probe = await probeEndpoint(profile(fixture().fetch));
	assert.equal(probe.maxOutputTokens, null);
});

test("an endpoint with no meta.n_ctx leaves the context unmeasured (D-006)", async () => {
	const probe = await probeEndpoint(profile(fixture({ nCtx: null }).fetch));
	assert.equal(probe.contextTokens, null);
});

test("a model that answers without a call is recorded as no tool support", async () => {
	const probe = await probeEndpoint(profile(fixture({ toolCalls: false }).fetch));
	assert.equal(probe.supportsTools, false);
});

test("tokenize disagreeing with usage.prompt_tokens fails loudly, never guesses", async () => {
	await assert.rejects(
		probeEndpoint(profile(fixture({ tokenizeCount: 999 }).fetch)),
		/\/tokenize counted 999, usage\.prompt_tokens says 208/, // never a guessed constant (D-006)
	);
});

test("without /apply-template the prompt size is read from usage, once it agrees", async () => {
	const { fetch } = fixture({ hasApplyTemplate: false });
	const probe = await probeEndpoint(profile(fetch));
	assert.equal(probe.tokenizerSource, "usage");
	assert.match(probe.probeMethod, /usage-count==prompt_tokens/);
});

test("a server reporting two prompt sizes for one request is refused, not averaged", async () => {
	const { fetch } = fixture({ hasApplyTemplate: false, promptTokensAtOne: 209 });
	await assert.rejects(
		() => probeEndpoint(profile(fetch)),
		/counted 209 at max_tokens 1 and 208 in the round trip/,
	);
});

test("a vLLM-shaped server gives its window at the top level and no /props", async () => {
	const { fetch } = fixture({ hasApplyTemplate: false, hasProps: false, maxModelLen: 262144, nCtx: null });
	const probe = await probeEndpoint(profile(fetch));
	assert.equal(probe.contextTokens, 262144);
	assert.equal(probe.maxOutputTokens, null);
	assert.equal(probe.supportsReasoning, null);
	assert.equal(probe.tokenizerSource, "usage");
	assert.match(probe.probeMethod, /v1\/models:max_model_len/);
});

test("a tool call behind the thinking is found on the retry, not called a refusal", async () => {
	const { calls, fetch } = fixture({ truncatedUntil: 2048 });
	const probe = await probeEndpoint(profile(fetch));
	assert.equal(probe.supportsTools, true);
	assert.match(probe.probeMethod, /tool-round-trip\(512\)\+truncated\+tool-round-trip\(2048\)/);
	assert.equal(calls.filter((call) => call.includes("chat/completions")).length, 2);
});

test("a model that never reaches a call within the allowance is an error, not a false", async () => {
	const { fetch } = fixture({ truncatedUntil: 99999 });
	await assert.rejects(
		() => probeEndpoint(profile(fetch)),
		/spent 2048 output tokens of the probe without producing a tool call/,
	);
});

test("an unreachable server is named, not defaulted", async () => {
	const boom: FetchFn = async () => {
		throw new Error("ECONNREFUSED");
	};
	await assert.rejects(probeEndpoint(profile(boom)), /cannot reach http:\/\/127\.0\.0\.1:8123\/props: ECONNREFUSED/);
});

test("a model id the server does not list is refused with its name", async () => {
	const notThere: FetchFn = async () =>
		new Response(JSON.stringify({ data: [], type: "list" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	await assert.rejects(probeEndpoint({ ...profile(notThere), model: "qwen-nope" }), /does not list model "qwen-nope"/);
});
