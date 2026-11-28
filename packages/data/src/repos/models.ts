// Storage for what endpoint probing measured (docs/architecture.md
// «Пробирование»). A NULL column keeps meaning "not measured" (D-006): the
// repository never writes a default into context_tokens, and the reader that
// needs the number (budgetFor in the server) refuses on NULL.

import type Database from "better-sqlite3";

export type EndpointAuthMode = "none" | "api_key";

export type ModelInfoRow = {
	endpointId: string;
	modelId: string;
	contextTokens: number | null;
	maxOutputTokens: number | null;
	supportsTools: boolean | null;
	supportsReasoning: boolean | null;
	tokenizerSource: "file" | "server" | "none" | null;
	probedAt: string | null;
	probeMethod: string | null;
};

function nowIso(): string {
	return new Date().toISOString();
}

function flagToBool(value: number | null): boolean | null {
	return value === null ? null : value === 1;
}

export function saveEndpoint(
	db: Database.Database,
	input: { id: string; label: string; baseUrl: string; authMode?: EndpointAuthMode },
): void {
	const authMode = input.authMode ?? "none";
	if (authMode !== "none" && authMode !== "api_key") {
		throw new Error(`unknown auth mode "${authMode}"; allowed: none, api_key`);
	}
	db.prepare(
		`INSERT INTO endpoint (id, label, base_url, auth_mode, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET label = excluded.label, base_url = excluded.base_url, auth_mode = excluded.auth_mode`,
	).run(input.id, input.label, input.baseUrl, authMode, nowIso());
}

/** Stores one probe result. Integer flags arrive as 0/1 or null; null is kept
 *  as NULL, never coerced to 0 — "the server did not say" is a real answer. */
export function saveModelInfo(
	db: Database.Database,
	input: {
		endpointId: string;
		modelId: string;
		contextTokens: number | null;
		maxOutputTokens: number | null;
		supportsTools: boolean | null;
		supportsReasoning: boolean | null;
		tokenizerSource?: "file" | "server" | "none";
		probeMethod?: string;
	},
): void {
	const toFlag = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);
	db.prepare(
		`INSERT INTO model_info
		 (endpoint_id, model_id, context_tokens, max_output_tokens, supports_tools, supports_reasoning,
		  tokenizer_source, probed_at, probe_method)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(endpoint_id, model_id) DO UPDATE SET
		  context_tokens = excluded.context_tokens,
		  max_output_tokens = excluded.max_output_tokens,
		  supports_tools = excluded.supports_tools,
		  supports_reasoning = excluded.supports_reasoning,
		  tokenizer_source = excluded.tokenizer_source,
		  probed_at = excluded.probed_at,
		  probe_method = excluded.probe_method`,
	).run(
		input.endpointId,
		input.modelId,
		input.contextTokens,
		input.maxOutputTokens,
		toFlag(input.supportsTools),
		toFlag(input.supportsReasoning),
		input.tokenizerSource ?? null,
		nowIso(),
		input.probeMethod ?? null,
	);
}

export function getModelInfo(db: Database.Database, endpointId: string, modelId: string): ModelInfoRow | undefined {
	const row = db
		.prepare(
			`SELECT endpoint_id, model_id, context_tokens, max_output_tokens, supports_tools,
			        supports_reasoning, tokenizer_source, probed_at, probe_method
			 FROM model_info WHERE endpoint_id = ? AND model_id = ?`,
		)
		.get(endpointId, modelId) as Record<string, unknown> | undefined;
	if (row === undefined) return undefined;
	return {
		endpointId: row.endpoint_id as string,
		modelId: row.model_id as string,
		contextTokens: row.context_tokens as number | null,
		maxOutputTokens: row.max_output_tokens as number | null,
		supportsTools: flagToBool(row.supports_tools as number | null),
		supportsReasoning: flagToBool(row.supports_reasoning as number | null),
		tokenizerSource: row.tokenizer_source as ModelInfoRow["tokenizerSource"],
		probedAt: row.probed_at as string | null,
		probeMethod: row.probe_method as string | null,
	};
}
