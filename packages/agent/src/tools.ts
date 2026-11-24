// A tool is a port: the loop never knows where an answer comes from. The server
// implements these over the repositories; tests implement them over fixtures.
// Layer rule: the agent package may not import the database layer.

import type { CanonicalSchema, ToolDefinition } from "@learntogether/models";

type SchemaJson = ToolDefinition["parameters"];

export interface ToolPort {
	name: string;
	description: string;
	schema: CanonicalSchema;
	/** Returning a string is the answer for the model; throwing means the tool
	 *  refused and the text of the error is what the model gets to see. */
	run(args: Record<string, unknown>, callId: string): string | Promise<string>;
}

export class ToolRegistry {
	private readonly byName: Map<string, ToolPort>;

	constructor(tools: ToolPort[]) {
		this.byName = new Map();
		for (const tool of tools) {
			if (this.byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
			this.byName.set(tool.name, tool);
		}
	}

	get(name: string): ToolPort | undefined {
		return this.byName.get(name);
	}

	/** Alphabetical: the request prefix stays stable between turns, which is what
	 *  makes prompt caching worth anything. */
	definitions(): ToolDefinition[] {
		return [...this.byName.values()]
			.sort((a, b) => a.name.localeCompare(b.name, "en"))
			.map(
				(tool) => ({
					description: tool.description,
					name: tool.name,
					// The canonical subset is a JSON Schema; the transport serializes it as is.
					parameters: tool.schema as unknown as SchemaJson,
				}),
			);
	}
}
