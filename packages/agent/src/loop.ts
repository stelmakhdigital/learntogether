// One turn of the teaching loop: ask the model, run what it asked for, feed the
// results back, stop when it stops. Everything the caller must see goes through
// `onEvent` — text, thinking, calls, refusals — and exactly one `finished`
// event closes the turn on every path: cancellation, an error event, or an
// adapter that throws instead of reporting one (docs/tool-contracts.md, D-054).

import {
	createToolCallAccumulator,
	repairArgs,
	validateArgs,
	type Request,
	type ResponseBlock,
	type StopReason,
	type TextBlock,
	type ThinkingBlock,
	type ToolResultBlock,
	type Transport,
} from "@learntogether/models";
import type { ToolRegistry } from "./tools.ts";

export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
	| { type: "tool_result"; id: string; name: string; ok: boolean; content: string }
	| { type: "tool_rejected"; id: string; name: string; reason: string }
	/** `error` carries the failure in the words of whoever reported it — the model
	 *  server text of a `done` event or of a thrown adapter — never our own wording. */
	| { type: "finished"; stop: StopReason; error?: string };

export interface CallOutcome {
	id: string;
	name: string;
	state: "valid" | "rejected";
	error?: string;
}

export interface TurnResult {
	text: string;
	thinking: string;
	blocks: ResponseBlock[];
	stop: StopReason;
	calls: CallOutcome[];
	steps: number;
}

export interface TurnInput {
	transport: Transport;
	registry: ToolRegistry;
	request: Request;
	signal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
	/** Transport round-trips allowed in one turn. */
	maxSteps?: number;
	/** Refusals allowed per tool name before the turn is given up on. */
	maxRejects?: number;
}

/** Model calls in one turn. A lesson turn spends them before the learner sees a
 *  word: two graph searches, the phases of the lesson, the step, its showing and its
 *  check. 8 was measured too small — a live turn ran out right after present_step
 *  and left the step without a check (Qwen3.8 at vLLM, 2026-11-29). */
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_REJECTS = 2;

export async function runTurn(input: TurnInput): Promise<TurnResult> {
	const { transport, registry, signal, onEvent } = input;
	const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
	const maxRejects = input.maxRejects ?? DEFAULT_MAX_REJECTS;

	let request = input.request;
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const blocks: ResponseBlock[] = [];
	const calls: CallOutcome[] = [];
	const rejects = new Map<string, number>();
	let steps = 0;
	let closed = false;

	const emit = (event: AgentEvent): void => onEvent?.(event);
	// Exactly one `finished` on every path: the caller closes the stream on it. The
	// guard is what keeps it true when the throw arrives after we already left the
	// loop (a failing iterator.return()), when it arrives on top of a `finished` we
	// gave out for a cancellation, or when both error paths meet in one step.
	const finish = (stop: StopReason, error?: string): TurnResult => {
		if (!closed) {
			closed = true;
			emit(error === undefined ? { type: "finished", stop } : { type: "finished", stop, error });
		}
		return { blocks, calls, steps, stop, text: textParts.join(""), thinking: thinkingParts.join("") };
	};

	for (steps = 1; steps <= maxSteps; steps += 1) {
		if (signal?.aborted) return finish("error");

		const accumulator = createToolCallAccumulator();
		const stepText: string[] = [];
		const stepThinking: string[] = [];
		let stop: StopReason = "end";
		// Failure text of a `done` event, kept in the words it arrived in.
		let failure: string | undefined;

		try {
			for await (const event of transport.stream(request, signal)) {
				if (signal?.aborted) return finish("error");
				accumulator.apply(event);
				if (event.type === "text_delta") {
					stepText.push(event.text);
					textParts.push(event.text);
					emit({ type: "text", text: event.text });
				} else if (event.type === "thinking_delta") {
					stepThinking.push(event.text);
					thinkingParts.push(event.text);
					emit({ type: "thinking", text: event.text });
				} else if (event.type === "done") {
					stop = event.stop;
					failure = event.error;
				}
			}
		} catch (error) {
			// An adapter that throws instead of yielding an error event — a refused
			// connection, a non-2xx response, a non-JSON SSE chunk (openaiCompatible.ts
			// throws in all three cases) — ends the turn the same honest way: one
			// `finished`, stop "error", and the server's own words, never ours.
			const reason = error instanceof Error ? error.message : String(error);
			// What streamed before the throw survives where it survives on the
			// error-event path. A call cut in half is not kept: a tool_call without its
			// result would poison the next request.
			// shortcut: a call cut in half by the throw is dropped, never repeated;
			// change when a partial call has to reach the transcript of the turn.
			blocks.push(...assistantBlocks(stepText, stepThinking));
			return finish("error", reason);
		}

		const { calls: rawCalls, truncated } = accumulator.finish(stop);
		const stepBlocks = assistantBlocks(stepText, stepThinking);

		// A call whose arguments never arrived is dead: the model has to hear that
		// in the same words we would use for a broken argument (rule 3).
		const results: ToolResultBlock[] = [];
		for (const id of truncated) {
			const reason = "аргументы оборвались, вызов не выполнен";
			calls.push({ id, name: "", state: "rejected", error: reason });
			emit({ type: "tool_rejected", id, name: "", reason });
			results.push({ content: reason, is_error: true, tool_call_id: id, type: "tool_result" });
		}

		for (const call of rawCalls) {
			stepBlocks.push(call);
			emit({ type: "tool_call", id: call.id, name: call.name, args: call.args });

			const refusal = checkCall(registry, call.name, call.args);
			if (refusal !== null) {
				const seen = (rejects.get(call.name) ?? 0) + 1;
				rejects.set(call.name, seen);
				calls.push({ id: call.id, name: call.name, state: "rejected", error: refusal });
				emit({ type: "tool_rejected", id: call.id, name: call.name, reason: refusal });
				results.push({ content: refusal, is_error: true, tool_call_id: call.id, type: "tool_result" });
				if (seen >= maxRejects + 1) {
					// Same mistake again: another round would only burn the budget.
					return finish("error");
				}
				continue;
			}

			const tool = registry.get(call.name)!;
			let content: string;
			try {
				content = await tool.run(call.args, call.id);
			} catch (error) {
				// A tool that refused is data, not a crash: the model sees the text.
				content = error instanceof Error ? error.message : String(error);
				calls.push({ id: call.id, name: call.name, state: "valid", error: content });
				emit({ type: "tool_result", content, id: call.id, name: call.name, ok: false });
				results.push({ content, is_error: true, tool_call_id: call.id, type: "tool_result" });
				continue;
			}
			calls.push({ id: call.id, name: call.name, state: "valid" });
			emit({ type: "tool_result", content, id: call.id, name: call.name, ok: true });
			results.push({ content, tool_call_id: call.id, type: "tool_result" });
		}

		// No calls means the model stopped talking to us and is done with the learner.
		if (rawCalls.length === 0 && truncated.length === 0) {
			blocks.push(...stepBlocks);
			return finish(stop, failure);
		}

		blocks.push(...stepBlocks);
		const messages = [...request.messages];
		messages.push({ content: stepBlocks, role: "assistant" });
		if (results.length > 0) messages.push({ content: results, role: "user" });
		request = { ...request, messages };
	}

	// Out of steps, not out of ideas: the caller shows this as a truncated turn.
	return finish("length");
}

/** What the model produced in one step, in arrival order: only what arrived. */
function assistantBlocks(stepText: string[], stepThinking: string[]): ResponseBlock[] {
	const blocks: ResponseBlock[] = [];
	if (stepText.length > 0) blocks.push({ text: stepText.join(""), type: "text" } satisfies TextBlock);
	if (stepThinking.length > 0) {
		blocks.push({ text: stepThinking.join(""), type: "thinking" } satisfies ThinkingBlock);
	}
	return blocks;
}

/** Level 1 and 2 of the contract, plus the structural check. Returns the text the
 *  model gets back, or null when the call may run. */
function checkCall(registry: ToolRegistry, name: string, args: Record<string, unknown>): string | null {
	const tool = registry.get(name);
	if (tool === undefined) return `неизвестный инструмент "${name}"`;

	const repaired = repairArgs(tool.schema, args);
	if ("error" in repaired) return repaired.error;

	const problems = validateArgs(tool.schema, repaired.value);
	return problems.length === 0 ? null : problems.join("; ");
}
