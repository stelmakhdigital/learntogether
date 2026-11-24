// Internal format shared by every adapter (docs/tool-contracts.md, "Внутренний
// формат"). An adapter's only job is to translate its wire protocol into these
// types and nothing else.

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	text: string;
}

export interface ToolCallBlock {
	type: "tool_call";
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: "tool_result";
	tool_call_id: string;
	content: string;
	is_error?: boolean;
}

export type RequestBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

/** Blocks an assistant turn can contain; a response never carries tool_result. */
export type ResponseBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export type StopReason = "end" | "tool_use" | "length" | "error";

export interface Usage {
	input: number;
	inputCacheRead: number;
	output: number;
	reasoning: number;
}

export interface AssistantResponse {
	blocks: ResponseBlock[];
	stop: StopReason;
	usage: Usage;
	/** Saved wire trace, for diagnostics (tool-contracts, «Внутренний формат»). */
	rawRef?: string;
}

/** Token budget for one call. Required, never defaulted: an unknown context
 *  window is measured or asked about, not replaced by a constant (D-006). */
export interface Budget {
	input: number;
	output: number;
}

export type ReasoningLevel = "none" | "low" | "medium" | "high";

/** Minimal request shape; canonical tool schema is enforced upstream (agent layer). */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Message {
	role: "user" | "assistant";
	content: RequestBlock[];
}

export interface Request {
	system: string;
	messages: Message[];
	tools: ToolDefinition[];
	budget: Budget;
	reasoningLevel: ReasoningLevel;
}

/** Normalized transport deltas. Empty and out-of-order optionals are the norm
 *  (tool-contracts rule 1); a call is identified by tool_call_delta itself,
 *  never by the stop reason (rule 2). */
export type TransportEvent =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_call_delta"; index: number; id?: string; name?: string; args_part?: string }
	| { type: "usage"; usage: Usage }
	| { type: "done"; stop: StopReason; usage: Usage; error?: string };

/** A transport only yields normalized events; assembling an `AssistantResponse`
 *  is the accumulator's job and cancellation belongs to the caller. */
export interface Transport {
	stream(request: Request, signal?: AbortSignal): AsyncIterable<TransportEvent>;
}
