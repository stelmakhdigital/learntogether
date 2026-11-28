// One running turn per session, with two things the HTTP layer needs: a way to
// cancel it, and a live feed of its events. The transcript stays the source of
// truth (D-044) — this queue is only what the learner should see right now, so a
// late subscriber starts from the transcript and misses nothing but animation.

import { randomUUID } from "node:crypto";
import type { AgentEvent, ToolRegistry } from "@learntogether/agent";
import { runTurn } from "@learntogether/agent";
import type { Request, Transport } from "@learntogether/models";
import { appendEntry } from "@learntogether/data";
import type Database from "better-sqlite3";

export interface TurnHandle {
	turnId: string;
	sessionId: string;
	subscribe(listener: (event: AgentEvent) => void): () => void;
	cancel(): void;
	done: Promise<TurnSummary>;
}

/** What a window needs when it opens in the middle of someone's lesson. */
export interface TurnStatus {
	running: boolean;
	turnId: string | null;
	/** How the last finished turn ended; null while it has not ended. */
	stop: string | null;
}

export interface TurnSummary {
	turnId: string;
	stop: string;
	text: string;
	calls: { id: string; name: string; state: string; error?: string }[];
}

export interface TurnDeps {
	transport: Transport;
	/** Tools are per-session: they carry the session id in their closure. */
	registry(db: Database.Database, sessionId: string): ToolRegistry;
	/** The composition root owns the prompt, the context and the budget: what the
	 *  model may be given follows from a measured context window, not from a
	 *  constant (D-006). The learner's words are already in the transcript — the
	 *  route appended them before the turn started — so the context is read from
	 *  the database and does not depend on what a client chose to resend. */
	buildRequest(sessionId: string): Promise<Request>;
	/** The method invariant «no step without a check» is not a hope: when a turn
	 *  ends with a step shown and no check recorded, this returns the words that
	 *  send the model back to the call, or null when the lesson is consistent. */
	unmetCheck?(sessionId: string): string | null;
}

interface Subscriber {
	(event: AgentEvent): void;
}

export class TurnRunner {
	private readonly active = new Map<string, ActiveTurn>();
	// The last finished turn stays replayable: a client that subscribes after a
	// fast local model has already answered still gets the whole turn, not a 404.
	private readonly recent = new Map<string, ActiveTurn>();

	private readonly db: Database.Database;
	private readonly deps: TurnDeps;

	constructor(db: Database.Database, deps: TurnDeps) {
		this.db = db;
		this.deps = deps;
	}

	/** The running turn, or the one that just finished. */
	get(sessionId: string): TurnHandle | undefined {
		return this.active.get(sessionId) ?? this.recent.get(sessionId);
	}

	/** Turns run inside this process, so after a restart the honest answer is «no
	 *  turn» rather than a guess from the transcript: a turn that died with the
	 *  process is not resumable, and the learner should be able to start a new one. */
	status(sessionId: string): TurnStatus {
		const active = this.active.get(sessionId);
		if (active !== undefined) return { running: true, stop: null, turnId: active.turnId };
		const recent = this.recent.get(sessionId);
		return { running: false, stop: recent?.stop ?? null, turnId: recent?.turnId ?? null };
	}

	/** Starts a turn. A second request for the same session is refused: two
	 *  writers would interleave into one transcript. */
	start(sessionId: string): TurnHandle {
		if (this.active.has(sessionId)) {
			throw new Error(`ход сессии ${sessionId} уже идёт; сначала отмени его`);
		}
		const turn = new ActiveTurn(this.db, sessionId, this.deps, () => {
			this.active.delete(sessionId);
			this.recent.set(sessionId, turn);
		});
		this.active.set(sessionId, turn);
		return turn;
	}
}

/** How many times a turn is sent back for an unmet invariant. One retry is the
 *  point: a second silence is a model problem the learner should see, not a loop
 *  that burns the budget. */
const CHECK_RETRIES = 1;

class ActiveTurn implements TurnHandle {
	private readonly listeners = new Set<Subscriber>();
	private readonly replayed: AgentEvent[] = [];
	private replayedDone = false;
	private readonly controller = new AbortController();
	private summary: TurnSummary | null = null;
	readonly turnId: string;
	readonly done: Promise<TurnSummary>;

	readonly sessionId: string;
	private readonly db: Database.Database;

	constructor(
		db: Database.Database,
		sessionId: string,
		deps: TurnDeps,
		finished: () => void,
	) {
		this.db = db;
		this.sessionId = sessionId;
		this.turnId = randomUUID();
		this.done = this.run(deps, finished).then((summary) => {
			this.summary = summary;
			return summary;
		});
	}

	/** Null until the turn has ended: a running turn has no outcome yet. */
	get stop(): string | null {
		return this.summary?.stop ?? null;
	}

	/** Late subscribers get everything that already happened, then live events.
	 *  Cancelling a finished turn is a no-op, so no "canceled" frame is invented. */
	subscribe(listener: (event: AgentEvent) => void): () => void {
		for (const event of this.replayed.slice()) {
			try {
				listener(event);
			} catch {
				// A subscriber that throws during replay is simply not registered.
				return () => false;
			}
		}
		if (this.replayedDone) return () => false;
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancel(): void {
		this.controller.abort();
	}

	private emit(event: AgentEvent): void {
		this.replayed.push(event);
		if (event.type === "finished") this.replayedDone = true;
		// A dead subscriber must not stop the turn: swallow its transport errors.
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				this.listeners.delete(listener);
			}
		}
		this.record(event);
	}

	/** What survives into the transcript: the calls and their results. Tokens and
	 *  thinking are transient by design (D-044). */
	private record(event: AgentEvent): void {
		if (event.type === "tool_call") {
			appendEntry(this.db, {
				kind: "tool_call",
				role: "system",
				sessionId: this.sessionId,
				text: `${event.name} ${JSON.stringify(event.args)}`,
			});
		} else if (event.type === "tool_result" || event.type === "tool_rejected") {
			const reason = event.type === "tool_rejected" ? event.reason : event.content;
			appendEntry(this.db, {
				kind: "tool_result",
				role: "system",
				sessionId: this.sessionId,
				text: `${event.name}: ${reason}`,
			});
		}
	}

	private async run(deps: TurnDeps, finished: () => void): Promise<TurnSummary> {
		try {
			let request: Request;
			try {
				request = await deps.buildRequest(this.sessionId);
			} catch (error) {
				// The context itself could not be assembled (no budget, no room). The
				// learner must see why in the same honest shape as any other failure,
				// not a stream that simply stops (D-054).
				const reason = error instanceof Error ? error.message : String(error);
				this.emit({ error: reason, stop: "error", type: "finished" });
				return { calls: [], stop: "error", text: "", turnId: this.turnId };
			}
			const registry = deps.registry(this.db, this.sessionId);
			let result = await runTurn({
				onEvent: (event) => this.emit(event),
				registry,
				request,
				signal: this.controller.signal,
				transport: deps.transport,
			});
			if (result.text !== "") {
				appendEntry(this.db, { kind: "text", role: "teacher", sessionId: this.sessionId, text: result.text });
			}

			// «Ни одного шага без проверки» is an invariant of the method, so it is
			// checked rather than requested: a shown step with no check sends the model
			// back to the call once. The retry gets a fresh context from the database, so
			// no half-finished tool exchange is replayed.
			for (let retry = 0; retry < CHECK_RETRIES; retry += 1) {
				// A turn that ran out of steps is exactly as capable of leaving a shown
				// step uncheckes as one that stopped talking: the state is in the database
				// and the retry rebuilds its context from there (live 2026-11-29: the turn
				// ended on "length" right after present_step).
				const owed = result.stop === "end" || result.stop === "length";
				const words = owed ? (deps.unmetCheck?.(this.sessionId) ?? null) : null;
				if (words === null || this.controller.signal.aborted) break;
				const base = await deps.buildRequest(this.sessionId);
				const again = await runTurn({
					onEvent: (event) => this.emit(event),
					registry: deps.registry(this.db, this.sessionId),
					request: {
						...base,
						messages: [...base.messages, { content: [{ text: words, type: "text" }], role: "user" }],
					},
					signal: this.controller.signal,
					transport: deps.transport,
				});
				if (again.text !== "") {
					appendEntry(this.db, { kind: "text", role: "teacher", sessionId: this.sessionId, text: again.text });
				}
				result = { ...again, text: `${result.text}${result.text === "" ? "" : "\n"}${again.text}` };
			}

			return { calls: result.calls, stop: result.stop, text: result.text, turnId: this.turnId };
		} finally {
			this.listeners.clear();
			finished();
		}
	}
}


/** Tokens one teacher turn may spend on its answer when the server reports no output
 *  cap of its own. Our number, not a measurement of the server: it has to cover a
 *  step of speech plus its tool call, and on a small window it competes with the
 *  lesson's input. A model that thinks before answering spends it faster — raise it
 *  through LTH_OUTPUT_TOKENS rather than by changing this constant. */
export const DEFAULT_OUTPUT_ALLOWANCE = 1024;

/** Budget from a measured context window. An unmeasured model gets no turn: the
 *  alternative is a guessed number, and a guessed number overflows the server. */
export function budgetFor(
	db: Database.Database,
	endpointId: string,
	modelId: string,
	reserve: number,
	allowance = DEFAULT_OUTPUT_ALLOWANCE,
): { input: number; output: number } {
	const row = db
		.prepare("SELECT context_tokens, max_output_tokens FROM model_info WHERE endpoint_id = ? AND model_id = ?")
		.get(endpointId, modelId) as { context_tokens: number | null; max_output_tokens: number | null } | undefined;
	if (row === undefined) throw new Error(`модель ${endpointId}/${modelId} не пробирована`);
	if (row.context_tokens === null) {
		throw new Error(`размер контекста ${endpointId}/${modelId} не измерен: измерь его или задай вручную`);
	}
	const output = row.max_output_tokens ?? allowance;
	const input = row.context_tokens - reserve - output;
	if (input < 1024) {
		throw new Error(`для ${endpointId}/${modelId} после резерва остаётся ${input} токенов входа — слишком мало для урока`);
	}
	return { input, output };
}
