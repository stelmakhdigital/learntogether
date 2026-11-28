// Endpoint probing (docs/architecture.md «Пробирование», D-006/D-046/D-051):
// every capability is measured against the live server or stays null — never a
// guessed constant. This module only talks to the wire; persisting the result
// belongs to the caller, because the models package does not import the
// database. Field names and endpoints follow the live trace of 2026-11-25 in
// docs/probes/2026-11-25-llama-cpp.md (build b12723).

import type { FetchFn } from "./openaiCompatible.ts";

export interface ProbeProfile {
	/** Server root without the "/v1" segment, e.g. "http://127.0.0.1:8123". */
	baseUrl: string;
	model: string;
	apiKey?: string;
	fetch?: FetchFn;
}

/** One column group of `model_info`. null means "this server did not tell us",
 *  never "zero" and never a default (D-006). */
export interface ModelProbe {
	modelId: string;
	contextTokens: number | null;
	maxOutputTokens: number | null;
	supportsTools: boolean | null;
	supportsReasoning: boolean | null;
	tokenizerSource: "server" | "none";
	probeMethod: string;
}

/** The tool we ask the model to call: one required field, nothing to get wrong.
 *  A call is verified by name, not by the stop reason (tool-contracts rule 2). */
const PROBE_TOOL_NAME = "probe_ping";
const PROBE_PROMPT = `Вызови инструмент ${PROBE_TOOL_NAME} со значением поля ping равным "ok" и больше ничего не пиши.`;

// Shared by the round trip and the token count: the token budget the server
// spends on a request includes the tool schemas rendered into the system turn,
// so /apply-template must be given the exact same tools the request carries or
// its count cannot match usage.prompt_tokens (measured 2026-11-29, b12723).
const PROBE_MESSAGES = [{ content: PROBE_PROMPT, role: "user" }];
const PROBE_TOOLS = [
	{
		function: {
			description: "Call this tool to confirm tool calling works.",
			name: PROBE_TOOL_NAME,
			parameters: {
				additionalProperties: false,
				properties: { ping: { type: "string" } },
				required: ["ping"],
				type: "object",
			},
		},
		type: "function",
	},
];

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A short excerpt of a body for the error text: enough to name the cause, not
 *  enough to flood the log. */
function excerpt(body: string): string {
	return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

interface HttpBag {
	send: FetchFn;
	headers: Record<string, string>;
}

async function requestJson(bag: HttpBag, url: string, init: RequestInit): Promise<unknown> {
	let response: Response;
	try {
		response = await bag.send(url, { ...init, headers: { ...bag.headers, ...init.headers } });
	} catch (error) {
		throw new Error(`probe: cannot reach ${url}: ${textOf(error)}`);
	}
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`probe: ${url} answered ${response.status}: ${excerpt(body)}`);
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error(`probe: ${url} answered with non-JSON body: ${excerpt(body)}`);
	}
}

/** 404 means the endpoint does not exist on this server family: for /props and
 *  /apply-template that is information, not a failure. Anything else throws. */
async function getJsonOr404(bag: HttpBag, url: string, init: RequestInit = {}): Promise<unknown | null> {
	let response: Response;
	try {
		response = await bag.send(url, { ...init, headers: { ...bag.headers, ...init.headers } });
	} catch (error) {
		throw new Error(`probe: cannot reach ${url}: ${textOf(error)}`);
	}
	const body = await response.text();
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`probe: ${url} answered ${response.status}: ${excerpt(body)}`);
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error(`probe: ${url} answered with non-JSON body: ${excerpt(body)}`);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

interface ModelsEntry {
	id?: string;
	meta?: Record<string, unknown>;
}

/** The serving window and the entry id from /v1/models (b12723 exposes
 *  meta.n_ctx there; the top-level n_ctx of D-029 does not exist). */
function modelEntry(raw: unknown, wanted: string): ModelsEntry | null {
	const data = asRecord(raw)["data"];
	if (!Array.isArray(data)) return null;
	const entries = data.filter((item): item is ModelsEntry => item !== null && typeof item === "object");
	const exact = entries.find((item) => item.id === wanted);
	if (exact !== undefined) return exact;
	// llama.cpp reports the GGUF path as the id; a bare file name matches its tail.
	const tail = entries.find((item) => typeof item.id === "string" && item.id.endsWith(`/${wanted}`));
	if (tail !== undefined) return tail;
	return entries.length === 1 ? entries[0]! : null;
}

/** Live tool-calling round trip: the template saying "supports_tool_calls" is
 *  not enough — the model itself has to emit a call we can parse by name. */
async function toolRoundTrip(
	bag: HttpBag,
	url: string,
	model: string,
): Promise<{ called: boolean; promptTokens: number | null }> {
	const body = JSON.stringify({
		messages: PROBE_MESSAGES,
		max_tokens: 64,
		model,
		stream: false,
		tools: PROBE_TOOLS,
	});
	const raw = asRecord(await requestJson(bag, url, { body, method: "POST" }));
	const choices = raw["choices"];
	const first = asRecord(Array.isArray(choices) ? choices[0] : undefined);
	const message = asRecord(first["message"]);
	const calls = message["tool_calls"];
	const called =
		Array.isArray(calls) &&
		calls.some((call) => asRecord(asRecord(asRecord(call)["function"]))["name"] === PROBE_TOOL_NAME);
	return { called, promptTokens: numberOrNull(asRecord(raw["usage"])["prompt_tokens"]) };
}

/** Exact token count without tokenizer.json (D-051): render with
 *  /apply-template — with the same tools the request carries — and count with
 *  /tokenize. The counting endpoint takes `content` (not `prompt`) and the
 *  `add_special` flag; it does not apply the template itself (live trace
 *  2026-11-25, re-verified against b12723 on 2026-11-29: diff 0). A count that
 *  disagrees with usage.prompt_tokens fails loudly, never guesses. */
async function verifyTokenizer(
	bag: HttpBag,
	root: string,
	model: string,
	promptTokens: number,
): Promise<boolean> {
	const rendered = await getJsonOr404(bag, `${root}/apply-template`, {
		body: JSON.stringify({
			add_generation_prompt: true,
			messages: PROBE_MESSAGES,
			model,
			tools: PROBE_TOOLS,
		}),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	if (rendered === null) return false;
	const prompt = asRecord(rendered)["prompt"];
	if (typeof prompt !== "string") return false;
	const counted = await requestJson(bag, `${root}/tokenize`, {
		body: JSON.stringify({ add_special: false, content: prompt, model }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const tokens = asRecord(counted)["tokens"];
	if (Array.isArray(tokens) && tokens.length === promptTokens) return true;
	const got = Array.isArray(tokens) ? String(tokens.length) : "no token array";
	throw new Error(
		`probe: /tokenize counted ${got}, usage.prompt_tokens says ${promptTokens}; ` +
			"the token counting for this server is unreliable, refusing to guess",
	);
}

/** Measures what the server reports and proves what it claims. Throws only
 *  when the server is unreachable, answers wrongly, or its token counting
 *  contradicts usage; every unreported capability comes back as null. */
export async function probeEndpoint(profile: ProbeProfile): Promise<ModelProbe> {
	const root = profile.baseUrl.replace(/\/+$/, "");
	const send: FetchFn = profile.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const headers: Record<string, string> = {};
	if (profile.apiKey !== undefined && profile.apiKey !== "") {
		headers["authorization"] = `Bearer ${profile.apiKey}`;
	}
	const bag: HttpBag = { headers, send };

	const props = asRecord(await getJsonOr404(bag, `${root}/props`));
	const modelsRaw = await requestJson(bag, `${root}/v1/models`, { headers: {} });
	const entry = modelEntry(modelsRaw, profile.model);
	if (entry === null) {
		throw new Error(
			`probe: ${root}/v1/models does not list model "${profile.model}"; ` +
				"check the model id against the models the server reports",
		);
	}
	const modelId = entry.id ?? profile.model;
	const contextTokens = numberOrNull(asRecord(entry.meta)["n_ctx"]);

	const caps = asRecord(props["chat_template_caps"]);
	const templateTools = booleanOrNull(caps["supports_tool_calls"]);
	const supportsReasoning =
		Object.keys(caps).length === 0
			? null
			: caps["supports_reasoning_effort"] === true || caps["supports_preserve_reasoning"] === true;
	const gen = asRecord(props["default_generation_settings"]);
	// n_predict <= 0 means "generate until EOS": no measured output cap.
	const nPredict = numberOrNull(gen["n_predict"]);
	const maxOutputTokens = nPredict !== null && nPredict > 0 ? nPredict : null;

	const trip = await toolRoundTrip(bag, `${root}/v1/chat/completions`, modelId);
	const supportsTools = templateTools === false ? false : trip.called;

	let tokenizerSource: ModelProbe["tokenizerSource"] = "none";
	const probeParts = ["v1/models:meta", "tool-round-trip"];
	if (Object.keys(props).length > 0) probeParts.unshift("props:chat_template_caps");
	if (trip.promptTokens !== null) {
		// The comparison itself is the measurement: only a matching count lets us
		// call the server tokenizer trustworthy (D-051, measured diff 0 on b12723).
		const exact = await verifyTokenizer(bag, root, modelId, trip.promptTokens);
		if (exact) {
			tokenizerSource = "server";
			probeParts.push("apply-template+tokenize==usage");
		} else {
			probeParts.push("tokenize-endpoint-absent");
		}
	}

	return {
		contextTokens,
		maxOutputTokens,
		modelId,
		probeMethod: probeParts.join("+"),
		supportsReasoning,
		supportsTools,
		tokenizerSource,
	};
}
