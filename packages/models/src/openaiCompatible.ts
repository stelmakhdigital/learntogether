// Adapter for the OpenAI-compatible /chat/completions wire format (D-005): what
// llama.cpp, vLLM, LM Studio and Ollama expose. Its only job is to translate that
// format into the internal events (docs/tool-contracts.md, «Внутренний формат»):
// call assembly stays in toolCalls.ts, budgets, retries and persistence stay with
// the caller. No SDK, no second accumulator, no retry policy in here.

import type { Request, StopReason, ToolDefinition, Transport, TransportEvent, Usage } from "./types.ts";

/** Everything the endpoint needs, stated explicitly. There is no default base
 *  url or model: guessing either would silently talk to a different server. */
export interface OpenAICompatibleProfile {
	/** API root including the version segment, e.g. "http://127.0.0.1:8123/v1". */
	baseUrl: string;
	model: string;
	apiKey?: string;
	/** Measured context window (D-006, D-046): absent means never probed. */
	contextWindow?: number;
	fetch?: FetchFn;
}

/** Narrow on purpose: the adapter makes one POST and reads its body. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A transport that also hands back the context window it was configured with.
 *  shortcut: the internal format has no field for a measured context window, so
 *  it travels on the transport instead of in `usage`; move it to the usage row
 *  once the storage schema has a column for it. */
export interface OpenAICompatibleTransport extends Transport {
	readonly contextWindow?: number;
}

interface WireToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface WireMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
}

interface WireToolCallDelta {
	index: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface WireChunk {
	choices?: { index: number; delta?: Record<string, unknown>; finish_reason?: string | null }[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	} | null;
}

type ToolCallDeltaEvent = Extract<TransportEvent, { type: "tool_call_delta" }>;

/** finish_reason values we have seen or that tool-contracts rule 2 asks us to
 *  accept. Anything else ends the turn as an error rather than as "end". */
const STOP_BY_FINISH: Record<string, StopReason> = {
	length: "length",
	stop: "end",
	tool: "tool_use",
	tool_calls: "tool_use",
};

/** The internal `Usage` has four required numbers, so "the server never said"
 *  cannot be `undefined` here. NaN keeps it honest: it is not 0 and not a
 *  guessed constant, and it poisons a sum instead of hiding inside one.
 *  shortcut: make the fields optional in types.ts and drop NaN when they are. */
const UNKNOWN_USAGE: Usage = { input: Number.NaN, inputCacheRead: Number.NaN, output: Number.NaN, reasoning: Number.NaN };

function requireProfileField(name: "baseUrl" | "model", value: string | undefined): string {
	if (value === undefined || value === "") {
		throw new Error(`openai-compatible: profile field "${name}" is required and has no default (D-006)`);
	}
	return value;
}

/** Rule 5 and the probe of 2026-11-25: this endpoint family has no confirmed
 *  reasoning support, so "none" sends no extra field and anything else refuses
 *  loudly instead of inventing a `reasoning_effort` key the server may reject. */
function rejectUnsupportedReasoning(request: Request): void {
	if (request.reasoningLevel !== "none") {
		throw new Error(
			`openai-compatible: reasoningLevel "${request.reasoningLevel}" is not supported by this adapter, ` +
				"the endpoint profile needs a probe that confirms its reasoning field first (rule 5)",
		);
	}
}

export function wireTools(tools: ToolDefinition[]): { type: "function"; function: ToolDefinition }[] {
	// The canonical schema was enforced upstream (schema.ts); we only wrap it.
	return tools.map((tool) => ({ function: tool, type: "function" }));
}

/** Exported for the token counter: rendering the same way the transport renders
 *  is the only way its count means anything (D-051). */
export function wireMessages(request: Request): WireMessage[] {
	const messages: WireMessage[] = [];
	if (request.system !== "") messages.push({ content: request.system, role: "system" });
	for (const message of request.messages) {
		const text: string[] = [];
		const calls: WireToolCall[] = [];
		const results: WireMessage[] = [];
		for (const block of message.content) {
			if (block.type === "text") text.push(block.text);
			if (block.type === "tool_call") {
				calls.push({
					function: { arguments: JSON.stringify(block.args), name: block.name },
					id: block.id,
					type: "function",
				});
			}
			if (block.type === "thinking") continue;
			if (block.type === "tool_result") {
				// shortcut: the wire format has no error flag on a tool result, only
				// its text; keep the flag in the transcript until a server echoes it.
				results.push({ content: block.content, role: "tool", tool_call_id: block.tool_call_id });
			}
		}
		if (text.length > 0 || calls.length > 0) {
			const wire: WireMessage = { content: text.join(""), role: message.role };
			if (calls.length > 0) wire.tool_calls = calls;
			messages.push(wire);
		}
		messages.push(...results);
	}
	return messages;
}

/** The one body shape of this adapter. The measuring call and the real call are
 *  built from it together: a size measured from a differently-shaped request is
 *  not the size of the request we are about to send. */
function bodyObject(request: Request, model: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		max_tokens: request.budget.output,
		messages: wireMessages(request),
		model,
		stream: true,
		stream_options: { include_usage: true },
	};
	// Rule 4: no tool_choice at all. Rule "none = do not send tools".
	if (request.tools.length > 0) body.tools = wireTools(request.tools);
	// No temperature: the caller owns sampling and the server default is its own.
	return body;
}

function wireBody(request: Request, model: string): string {
	return JSON.stringify(bodyObject(request, model));
}

/** Same request with the output cut to one token, no stream: enough for the
 *  server to answer with `usage.prompt_tokens` of the prompt we sent. Measured on
 *  vLLM 2026-11-29: prompt_tokens is the same at max_tokens 1 and 64 (337 = 337)
 *  and the call costs one prefill (0.12 s with a warm prefix cache). */
export function measureBody(request: Request, model: string): Record<string, unknown> {
	const body = bodyObject(request, model);
	body["max_tokens"] = 1;
	body["stream"] = false;
	delete body["stream_options"];
	return body;
}

/** A number the server did not send stays unknown, never 0 (D-006). */
function count(value: unknown): number {
	return typeof value === "number" ? value : Number.NaN;
}

function usageFrom(raw: NonNullable<WireChunk["usage"]>): Usage {
	return {
		input: count(raw.prompt_tokens),
		inputCacheRead: count(raw.prompt_tokens_details?.cached_tokens),
		output: count(raw.completion_tokens),
		reasoning: count(raw.completion_tokens_details?.reasoning_tokens),
	};
}

/** Payload of one SSE event, or null for an event with no data line. Comment
 *  lines (": ...") are keep-alives; `event:` and `id:` fields are not used by the
 *  servers we probed (docs/probes/2026-11-25-llama-cpp.md).
 *  shortcut: only `data:` is honored, add `event:` dispatching when a server
 *  actually sends one. */
function dataOf(block: string): string | null {
	const lines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("data:")) lines.push(line.slice("data:".length).replace(/^ /, ""));
	}
	if (lines.length === 0) return null;
	return lines.join("\n");
}

function parsePayload(payload: string): WireChunk {
	try {
		return JSON.parse(payload) as WireChunk;
	} catch {
		throw new Error(`openai-compatible: SSE payload is not JSON: ${payload.slice(0, 200)}`);
	}
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	// Cancelling a stream that already ended is not our problem: the stream is over.
	await reader.cancel().catch(() => undefined);
}

/** Next chunk of the body, or null when the stream is over or was aborted. */
async function readNext(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	if (signal?.aborted) {
		await cancelQuietly(reader);
		return null;
	}
	const read = reader.read();
	let onAbort: (() => void) | undefined;
	try {
		if (signal) {
			const aborted = new Promise<"aborted">((resolve) => {
				onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			});
			// Cancelling the reader resolves the pending read as done, so a server
			// that stopped sending cannot leave the consumer hanging.
			if ((await Promise.race([read, aborted])) === "aborted") {
				// The read we abandon may reject because cancelling killed the request;
				// the cancellation is what we were waiting for, so it is not a failure.
				read.catch(() => undefined);
				await cancelQuietly(reader);
				return null;
			}
		}
		const result = await read;
		return result.done ? null : result.value;
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** JSON payloads of the streamed chunks, in arrival order, up to "[DONE]". */
async function* ssePayloads(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const chunk = await readNext(reader, signal);
			// null means the body ended or we were cancelled. Anything still in the
			// buffer is an incomplete event and stays dropped: we never guess the rest
			// of a cut payload (rule 3), the missing finish_reason makes the turn an error.
			if (chunk === null) return;
			buffer += decoder.decode(chunk, { stream: true });
			for (;;) {
				// shortcut: events are separated by an empty line written as "\n\n", which
				// is what llama.cpp, vLLM and LM Studio send; "\r\n\r\n" is unhandled until
				// a server that sends it shows up in a probe.
				const cut = buffer.indexOf("\n\n");
				if (cut === -1) break;
				const block = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				const payload = dataOf(block);
				if (payload === "[DONE]") return;
				if (payload !== null) yield payload;
			}
		}
	} finally {
		await cancelQuietly(reader);
	}
}

function toolCallDelta(raw: WireToolCallDelta): ToolCallDeltaEvent {
	if (typeof raw.index !== "number") {
		// Without an index the deltas of two calls cannot be told apart (rule 1).
		throw new Error(`openai-compatible: tool_call delta without "index": ${JSON.stringify(raw)}`);
	}
	const delta: ToolCallDeltaEvent = { index: raw.index, type: "tool_call_delta" };
	if (typeof raw.id === "string" && raw.id !== "") delta.id = raw.id;
	if (typeof raw.function?.name === "string") delta.name = raw.function.name;
	if (typeof raw.function?.arguments === "string") delta.args_part = raw.function.arguments;
	return delta;
}

async function* streamChat(
	request: Request,
	baseUrl: string,
	model: string,
	send: FetchFn,
	apiKey?: string,
	signal?: AbortSignal,
): AsyncGenerator<TransportEvent> {
	const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

	const init: RequestInit = { body: wireBody(request, model), headers, method: "POST" };
	// The caller's cancellation reaches the socket, not just our reader.
	if (signal) init.signal = signal;
	let response: Response;
	try {
		response = await send(url, init);
	} catch (error) {
		// Cancelled by the caller: it closes the turn itself, this is not a failure.
		// Anything else (DNS, connection refused) is reported as it came, no retry.
		if (signal?.aborted) return;
		throw error;
	}
	if (!response.ok) {
		// A failure is reported with the server's own words and never retried here:
		// retries belong to the call level, not to the adapter.
		const text = (await response.text()).slice(0, 500);
		throw new Error(`openai-compatible: POST ${url} failed with HTTP ${response.status}: ${text}`);
	}
	if (response.body === null) {
		throw new Error(`openai-compatible: POST ${url} returned no response body to stream`);
	}

	let usage: Usage = UNKNOWN_USAGE;
	let finish: string | null = null;
	for await (const payload of ssePayloads(response.body, signal)) {
		const chunk = parsePayload(payload);
		// `timings` rides along in the usage chunk of llama.cpp and is ignored (D-052).
		if (chunk.usage) {
			usage = usageFrom(chunk.usage);
			yield { type: "usage", usage };
		}
		// shortcut: only choice 0 is read; we never send n > 1, so nothing else exists.
		const choice = chunk.choices?.[0];
		const delta = choice?.delta as Record<string, unknown> | undefined;
		const content = delta?.content;
		if (typeof content === "string") yield { text: content, type: "text_delta" };
		const reasoning = delta?.reasoning_content;
		if (typeof reasoning === "string") yield { text: reasoning, type: "thinking_delta" };
		const calls = delta?.tool_calls;
		if (Array.isArray(calls)) {
			for (const call of calls as WireToolCallDelta[]) yield toolCallDelta(call);
		}
		if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
	}

	// The caller cancelled: it closes the turn itself, we add nothing.
	if (signal?.aborted) return;

	if (finish === null) {
		// A stream that never said why it stopped is not a finished turn, and we do
		// not report it as one.
		yield {
			type: "done",
			stop: "error",
			usage,
			error: "stream ended without finish_reason (the connection or the server stopped early)",
		};
		return;
	}
	const stop = STOP_BY_FINISH[finish];
	if (stop === undefined) {
		yield { type: "done", stop: "error", usage, error: `unknown finish_reason "${finish}" from the server` };
		return;
	}
	// `length` is the truncation signal: the caller drops every call in flight
	// through the accumulator (rule 3), there is nothing else to mark here.
	yield { type: "done", stop, usage };
}

export function createOpenAICompatibleTransport(profile: OpenAICompatibleProfile): OpenAICompatibleTransport {
	const baseUrl = requireProfileField("baseUrl", profile.baseUrl);
	const model = requireProfileField("model", profile.model);
	const send: FetchFn = profile.fetch ?? ((url, init) => globalThis.fetch(url, init));

	const transport: OpenAICompatibleTransport = {
		...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
		stream(request, signal) {
			rejectUnsupportedReasoning(request);
			// Deliberately not assembled here: an adapter only yields normalized
			// events, `createToolCallAccumulator` is what turns deltas into calls.
			return streamChat(request, baseUrl, model, send, profile.apiKey, signal);
		},
	};
	return transport;
}
