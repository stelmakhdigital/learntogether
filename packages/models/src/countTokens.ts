// Exact input-token counting (D-051): render the request the way the transport
// renders it, then ask the server to count the rendered prompt. No approximation
// by characters — `chars/4` understates Russian by about a third (docs measured),
// and an understated count is an overflow on the real server. The counter is only
// built when the probe proved this server renders and counts (`tokenizerSource:
// "server"`); without that proof nothing here guesses a number (D-006).

import { wireMessages, wireTools, type FetchFn } from "./openaiCompatible.ts";
import type { Request } from "./types.ts";

export interface TokenCounterProfile {
	/** Server root without the "/v1" segment, e.g. "http://127.0.0.1:8123". */
	baseUrl: string;
	model: string;
	apiKey?: string;
	fetch?: FetchFn;
}

/** Counts the input side of one request, in the model's own tokens. */
export interface TokenCounter {
	count(request: Request): Promise<number>;
}

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function excerpt(body: string): string {
	return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

interface HttpBag {
	headers: Record<string, string>;
	send: FetchFn;
}

/** A missing endpoint is a different failure from a broken body: the first says
 *  "this server family does not count this way", the second says "this server is
 *  broken", and only the second one is worth a stack trace. */
async function postJson(bag: HttpBag, url: string, body: unknown, allowMissing: boolean): Promise<unknown | null> {
	let response: Response;
	try {
		response = await bag.send(url, {
			body: JSON.stringify(body),
			headers: { ...bag.headers, "content-type": "application/json" },
			method: "POST",
		});
	} catch (error) {
		throw new Error(`count: cannot reach ${url}: ${textOf(error)}`);
	}
	const text = await response.text();
	if (response.status === 404 && allowMissing) return null;
	if (!response.ok) {
		throw new Error(`count: POST ${url} failed with HTTP ${response.status}: ${excerpt(text)}`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`count: ${url} answered with non-JSON body: ${excerpt(text)}`);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** `tokens_count` and `tokens.length` come from the same server call; when they
 *  disagree the server is not counting what we sent, and a guessed count is the
 *  one thing the budget must never be. */
function countedTokens(raw: unknown, url: string): number {
	const body = record(raw);
	const tokens = body["tokens"];
	const declared = body["tokens_count"];
	const length = Array.isArray(tokens) ? tokens.length : null;
	if (length === null) throw new Error(`count: ${url} returned no token array: ${JSON.stringify(body)}`);
	if (declared !== undefined && declared !== length) {
		throw new Error(`count: ${url} reports tokens_count ${String(declared)} but sent ${length} tokens`);
	}
	return length;
}

/** The pair `/apply-template` then `/tokenize` (D-051). `/tokenize` does not
 *  apply a chat template, so the prompt must be rendered first with the very
 *  tools and system text the request carries — the template renders the tool
 *  schemas into the prompt, and leaving them out understates the count. */
export function createRenderTokenCounter(profile: TokenCounterProfile): TokenCounter {
	if (profile.baseUrl === "" || profile.baseUrl === undefined) {
		throw new Error("count: baseUrl is required and has no default (D-006)");
	}
	if (profile.model === "" || profile.model === undefined) {
		throw new Error("count: model is required and has no default (D-006)");
	}
	const root = profile.baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	if (profile.apiKey !== undefined && profile.apiKey !== "") {
		headers.authorization = `Bearer ${profile.apiKey}`;
	}
	const bag: HttpBag = { headers, send: profile.fetch ?? ((url, init) => globalThis.fetch(url, init)) };

	return {
		async count(request: Request): Promise<number> {
			const tools = request.tools.length > 0 ? wireTools(request.tools) : undefined;
			const rendered = await postJson(
				bag,
				`${root}/apply-template`,
				{
					add_generation_prompt: true,
					messages: wireMessages(request),
					model: profile.model,
					...(tools === undefined ? {} : { tools }),
				},
				true,
			);
			if (rendered === null) {
				throw new Error(
					`count: ${root}/apply-template does not exist on this server, its prompt cannot be counted exactly; ` +
						"give the tokenizer file or a server that renders templates",
				);
			}
			const prompt = record(rendered)["prompt"];
			if (typeof prompt !== "string") {
				throw new Error(`count: ${root}/apply-template returned no "prompt" string: ${JSON.stringify(rendered)}`);
			}
			const counted = await postJson(
				bag,
				`${root}/tokenize`,
				{ add_special: false, content: prompt, model: profile.model },
				false,
			);
			// `/tokenize` is not optional here: a request that rendered but cannot be
			// counted has no honest size, and the budget refuses to be guessed.
			return countedTokens(counted, `${root}/tokenize`);
		},
	};
}
