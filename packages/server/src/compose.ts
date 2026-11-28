// Composition root of a live turn: probe the configured endpoint, persist what
// it measured, then assemble the TurnRunner (transport + tools + prompt +
// budget). Lives in the server because persistence is the server's business;
// the agent loop and the models layer stay free of the database.

import type Database from "better-sqlite3";
import { ToolRegistry } from "@learntogether/agent";
import { saveEndpoint, saveModelInfo } from "@learntogether/data";
import { createOpenAICompatibleTransport, probeEndpoint, type FetchFn } from "@learntogether/models";
import type { ModelSettings } from "./config.ts";
import { TEACHER_PROMPT } from "./teach/prompt.ts";
import { createStepTools } from "./teach/steps.ts";
import { budgetFor, TurnRunner } from "./turn.ts";

/** Single configured endpoint for now. shortcut: N profiles and role_assignment
 *  are the rest of stage 2; rename when the second profile exists. */
export const DEFAULT_ENDPOINT_ID = "default";

/** Room kept off the top of the window for the tool schemas and the next
 *  rounds of the loop; the output budget is separate (see budgetFor).
 *  shortcut: a flat reserve; make it measured per request once compactation
 *  lands (stage 2, «Бюджеты по ролям»). */
const INPUT_RESERVE_TOKENS = 1536;

export interface ComposeDeps {
	db: Database.Database;
	model: ModelSettings;
	log: (message: string) => void;
	/** Injectable for the contract test; production uses global fetch. */
	fetch?: FetchFn;
}

/** Probes, stores, refuses. An endpoint that cannot call tools cannot teach:
 *  every tool call is the method itself, so this is a startup failure with the
 *  probe's own words, not a degraded mode. */
export async function composeTurnRunner(deps: ComposeDeps): Promise<TurnRunner> {
	const { db, model, log } = deps;
	const probe = await probeEndpoint({
		baseUrl: model.baseUrl,
		model: model.model,
		...(model.apiKey === null ? {} : { apiKey: model.apiKey }),
		...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
	});

	saveEndpoint(db, { baseUrl: model.baseUrl, id: DEFAULT_ENDPOINT_ID, label: probe.modelId });
	saveModelInfo(db, {
		contextTokens: probe.contextTokens,
		endpointId: DEFAULT_ENDPOINT_ID,
		maxOutputTokens: probe.maxOutputTokens,
		modelId: probe.modelId,
		...(probe.probeMethod === "" ? {} : { probeMethod: probe.probeMethod }),
		supportsReasoning: probe.supportsReasoning,
		supportsTools: probe.supportsTools,
		tokenizerSource: probe.tokenizerSource,
	});
	log(
		`проба ${model.baseUrl}: модель ${probe.modelId}, контекст ${probe.contextTokens ?? "не измерен"}, ` +
			`инструменты ${probe.supportsTools === null ? "не проверены" : probe.supportsTools ? "есть" : "нет"}, ` +
			`токенизатор ${probe.tokenizerSource} (${probe.probeMethod})`,
	);

	if (probe.supportsTools !== true) {
		throw new Error(
			`модель ${probe.modelId} на ${model.baseUrl} не вызывает инструменты — урок невозможен; ` +
				"запусти сервер с поддержкой tool calling (для llama.cpp флаг --jinja либо шаблон внутри GGUF)",
		);
	}
	// Fail here, not on the first turn: an unmeasured window means no honest
	// budget exists (D-006), and the user learns it at startup, not mid-lesson.
	budgetFor(db, DEFAULT_ENDPOINT_ID, probe.modelId, INPUT_RESERVE_TOKENS);

	const transport = createOpenAICompatibleTransport({
		baseUrl: `${model.baseUrl}/v1`,
		model: probe.modelId,
		...(model.apiKey === null ? {} : { apiKey: model.apiKey }),
		...(probe.contextTokens === null ? {} : { contextWindow: probe.contextTokens }),
		...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
	});

	const runner = new TurnRunner(db, {
		transport,
		registry: (database, sessionId) => new ToolRegistry(createStepTools(database, sessionId)),
		buildRequest: (sessionId, learnerText) => {
			const registry = new ToolRegistry(createStepTools(db, sessionId));
			return {
				budget: budgetFor(db, DEFAULT_ENDPOINT_ID, probe.modelId, INPUT_RESERVE_TOKENS),
				messages: [{ content: [{ text: learnerText, type: "text" }], role: "user" }],
				reasoningLevel: "none",
				system: TEACHER_PROMPT,
				tools: registry.definitions(),
			};
		},
	});
	return runner;
}
