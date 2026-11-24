// Accumulates tool_call_delta events into finished calls (docs/tool-contracts.md,
// "Внутренний формат" rules 1-3 and "Правила валидации и репарации", level 0).

import type { StopReason, ToolCallBlock, TransportEvent } from "./types.ts";

export interface ToolCallAccumulator {
	apply(event: TransportEvent): void;
	/** A call is a call because its deltas arrived, whatever the stop reason was.
	 *  Unparseable args mean the call is dead (truncated): we never guess the
	 *  rest of the JSON, so its id lands in `truncated` instead of `calls`. */
	finish(stop: StopReason): { calls: ToolCallBlock[]; truncated: string[] };}

interface PendingCall {
	index: number;
	id: string;
	name: string;
	rawArgs: string;
}

function parseArgs(raw: string): Record<string, unknown> | null {
	const text = raw.trim();
	if (text === "") return {}; // a tool may legitimately take no arguments
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function createToolCallAccumulator(): ToolCallAccumulator {
	// Keyed by delta index: one index is one call, deltas may interleave.
	const pending = new Map<number, PendingCall>();

	return {
		apply(event) {
			if (event.type !== "tool_call_delta") return;
			let call = pending.get(event.index);
			if (!call) {
				call = { index: event.index, id: "", name: "", rawArgs: "" };
				pending.set(event.index, call);
			}
			if (event.id !== undefined && event.id !== "") call.id = event.id;
			if (event.name !== undefined && event.name !== "") call.name = event.name;
			// Empty and missing args_part are the norm; we only glue what arrives.
			if (event.args_part !== undefined) call.rawArgs += event.args_part;
		},

		// A call is a call because its deltas arrived, whatever the stop reason said
		// (rule 2). `length` kills every call in flight: the server ran out of tokens
		// mid-generation, so even arguments that happen to parse may be missing the
		// tail (rule 3). Unparseable arguments are dead whatever the stop reason: we
		// never guess the rest of the JSON.
		finish(stop) {
			const calls: ToolCallBlock[] = [];
			const truncated: string[] = [];
			const byIndex = [...pending.values()].sort((a, b) => a.index - b.index);
			for (const call of byIndex) {
				const args = stop === "length" ? null : parseArgs(call.rawArgs);
				if (args !== null) {
					calls.push({ type: "tool_call", id: call.id, name: call.name, args });
				} else {
					truncated.push(call.id === "" ? `index:${call.index}` : call.id);
				}
			}
			return { calls, truncated };
		},
	};
}
