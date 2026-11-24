// Scripted transport for contract tests: no network, no live server, no wire
// protocol. It speaks the internal format only (docs/tool-contracts.md,
// "Внутренний формат"), so a test driving it checks the transport rules 1-3.

import type {
	Message,
	Request,
	RequestBlock,
	ResponseBlock,
	StopReason,
	ToolResultBlock,
	Transport,
	TransportEvent,
	Usage,
} from "./types.ts";

export interface FakeCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface FakeTurn {
	text?: string;
	thinking?: string;
	calls?: FakeCall[];
	stop?: StopReason;
	usage?: Usage;
	error?: string;
}

export interface FakeScript {
	turns: FakeTurn[];
}

export interface FakeTransportCall {
	request: Request;
	responses: ResponseBlock[];
}

export interface FakeTransport extends Transport {
	/** One call = one scripted turn, in script order. */
	stream(request: Request, signal?: AbortSignal): AsyncIterable<TransportEvent>;
	/** What was sent and what we answered, oldest first. */
	calls(): FakeTransportCall[];
	/** Tool results to carry into the next request. */
	queueToolResults(responses: ToolResultBlock[]): void;
}

/** 4 characters: small enough that every boundary cuts an argument in the
 *  middle, which is the shape the accumulator has to survive. */
const CHUNK = 4;

function* chunks(text: string): Generator<string> {
	for (let i = 0; i < text.length; i += CHUNK) yield text.slice(i, i + CHUNK);
}

/** Crude input proxy: raw character count of what the request carries, not
 *  tokens (no tokenizer in the fixture). Only ever compared against itself. */
function blockChars(block: RequestBlock): number {
	switch (block.type) {
		case "text":
		case "thinking":
			return block.text.length;
		case "tool_call":
			return block.name.length + JSON.stringify(block.args).length;
		case "tool_result":
			return block.content.length;
	}
}

function inputChars(request: Request): number {
	let chars = request.system.length;
	for (const message of request.messages) {
		for (const block of message.content) chars += blockChars(block);
	}
	return chars;
}

function responseBlocks(turn: FakeTurn): ResponseBlock[] {
	const blocks: ResponseBlock[] = [];
	if (turn.thinking !== undefined) blocks.push({ type: "thinking", text: turn.thinking });
	if (turn.text !== undefined) blocks.push({ type: "text", text: turn.text });
	for (const call of turn.calls ?? []) {
		blocks.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
	}
	return blocks;
}

export function createFakeTransport(script: FakeScript): FakeTransport {
	const history: FakeTransportCall[] = [];
	const pendingResults: ToolResultBlock[] = [];
	let turnIndex = 0;

	function nextTurn(): FakeTurn {
		const turn = script.turns[turnIndex];
		if (!turn) {
			throw new Error(
				`fake transport: turn ${turnIndex + 1} of ${script.turns.length} scripted is not available`,
			);
		}
		turnIndex += 1;
		return turn;
	}

	/** Tool results travel back in a user turn: Message has no "tool" role. The
	 *  assistant turn we produced stays in `history` for the caller to re-send —
	 *  the fake never invents history it was not given. */
	function drainQueued(): Message[] {
		if (pendingResults.length === 0) return [];
		return [{ role: "user", content: pendingResults.splice(0, pendingResults.length) }];
	}

	function eventList(turn: FakeTurn, usage: Usage): TransportEvent[] {
		const events: TransportEvent[] = [];
		if (turn.error !== undefined) {
			// A failed turn carries no blocks: the server text goes out on the done event.
			return [{ type: "done", stop: "error", usage, error: turn.error }];
		}
		if (turn.thinking !== undefined) events.push({ type: "thinking_delta", text: turn.thinking });
		if (turn.text !== undefined) {
			for (const part of chunks(turn.text)) events.push({ type: "text_delta", text: part });
		}
		const calls = turn.calls ?? [];
		calls.forEach((call, index) => {
			// One delta opens the call with id and name, the rest only carry args.
			events.push({ type: "tool_call_delta", index, id: call.id, name: call.name });
			for (const part of chunks(JSON.stringify(call.args))) {
				events.push({ type: "tool_call_delta", index, args_part: part });
			}
		});
		const stop: StopReason = turn.stop ?? (calls.length > 0 ? "tool_use" : "end");
		events.push({ type: "done", stop, usage });
		return events;
	}

	async function* run(request: Request, signal?: AbortSignal): AsyncGenerator<TransportEvent> {
		if (signal?.aborted) return;
		const turn = nextTurn();
		const sent: Request = { ...request, messages: [...request.messages, ...drainQueued()] };
		const usage: Usage = turn.usage ?? {
			input: inputChars(sent),
			inputCacheRead: 0,
			output: turn.text?.length ?? 0,
			reasoning: turn.thinking?.length ?? 0,
		};
		history.push({ request: sent, responses: responseBlocks(turn) });
		for (const event of eventList(turn, usage)) {
			if (signal?.aborted) return;
			yield event;
		}
	}

	return {
		stream(request, signal) {
			return run(request, signal);
		},
		calls() {
			return [...history];
		},
		queueToolResults(responses) {
			pendingResults.push(...responses);
		},
	};
}
