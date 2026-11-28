// The counter may only speak the server's numbers: it renders through
// /apply-template with the very tools and system text the request carries and
// counts through /tokenize (D-051). A missing endpoint or a self-contradicting
// answer is a refusal, never an estimate.

import test from "node:test";
import assert from "node:assert/strict";
import { createRenderTokenCounter, type FetchFn, type Request } from "../src/index.ts";

const ROOT = "http://127.0.0.1:8123";
const RENDERED = "system\nТы учитель\nuser\nчто такое производная\nassistant\n";

function request(overrides: Partial<Request> = {}): Request {
	return {
		budget: { input: 3000, output: 500 },
		messages: [{ content: [{ text: "что такое производная", type: "text" }], role: "user" }],
		reasoningLevel: "none",
		system: "Ты учитель",
		tools: [
			{
				description: "записать шаг",
				name: "record_step",
				parameters: { properties: { statement: { type: "string" } }, required: ["statement"], type: "object" },
			},
		],
		...overrides,
	};
}

interface CounterFixture {
	bodies: Record<string, unknown>;
	fetch: FetchFn;
}

function fixture(options: {
	prompt?: string | null;
	templateStatus?: number;
	tokenizeBody?: unknown;
}): CounterFixture {
	const bodies: Record<string, unknown> = {};
	const fetch: FetchFn = async (url, init) => {
		const path = new URL(url).pathname;
		bodies[path] = JSON.parse(String(init.body));
		if (path === "/apply-template") {
			if (options.templateStatus !== undefined && options.templateStatus !== 200) {
				return new Response("no such endpoint", { status: options.templateStatus });
			}
			const prompt = options.prompt === null ? {} : { prompt: options.prompt ?? RENDERED };
			return new Response(JSON.stringify(prompt), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		}
		if (path === "/tokenize") {
			const body = options.tokenizeBody ?? { tokens: new Array(208).fill(1), tokens_count: 208 };
			return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
		}
		return new Response(`unexpected ${path}`, { status: 500 });
	};
	return { bodies, fetch };
}

const profile = (fetch: FetchFn) => ({ baseUrl: ROOT, fetch, model: "qwen" });

test("the count is the server's own token count of the rendered prompt", async () => {
	const { bodies, fetch } = fixture({});
	assert.equal(await createRenderTokenCounter(profile(fetch)).count(request()), 208);
	// The rendering request carries the system text, the conversation and the tool
	// schemas: leaving the tools out would understate the prompt the server builds.
	const rendered = bodies["/apply-template"] as { add_generation_prompt: boolean; messages: unknown[]; tools: unknown[] };
	assert.equal(rendered.add_generation_prompt, true);
	assert.equal(rendered.messages.length, 2);
	assert.equal(rendered.tools.length, 1);
	const counted = bodies["/tokenize"] as { add_special: boolean; content: string };
	assert.equal(counted.add_special, false);
	assert.equal(counted.content, RENDERED);
});

test("no tools in the request means no tools in the render", async () => {
	const { bodies, fetch } = fixture({});
	await createRenderTokenCounter(profile(fetch)).count(request({ tools: [] }));
	assert.equal("/tools" in (bodies["/apply-template"] as Record<string, unknown>), false);
});

test("a server without /apply-template is named, not counted by characters", async () => {
	const { fetch } = fixture({ templateStatus: 404 });
	await assert.rejects(
		createRenderTokenCounter(profile(fetch)).count(request()),
		/apply-template does not exist.*cannot be counted exactly/s,
	);
});

test("a render without a prompt string is refused", async () => {
	const { fetch } = fixture({ prompt: null });
	await assert.rejects(createRenderTokenCounter(profile(fetch)).count(request()), /returned no "prompt" string/);
});

test("tokens_count disagreeing with the token array is refused", async () => {
	const { fetch } = fixture({ tokenizeBody: { tokens: new Array(208).fill(1), tokens_count: 100 } });
	await assert.rejects(
		createRenderTokenCounter(profile(fetch)).count(request()),
		/reports tokens_count 100 but sent 208 tokens/,
	);
});

test("an unreachable server is reported with its own failure", async () => {
	const boom: FetchFn = async () => {
		throw new Error("ECONNREFUSED");
	};
	await assert.rejects(
		createRenderTokenCounter(profile(boom)).count(request()),
		/count: cannot reach http:\/\/127\.0\.0\.1:8123\/apply-template: ECONNREFUSED/,
	);
});

test("a profile without a base url or a model is a configuration error", () => {
	assert.throws(() => createRenderTokenCounter({ baseUrl: "", model: "qwen", fetch: fixture({}).fetch }), /baseUrl/);
	assert.throws(() => createRenderTokenCounter({ baseUrl: ROOT, model: "", fetch: fixture({}).fetch }), /model/);
});
