// HTTP surface of the server process: JSON routes over SQLite plus an SSE feed
// of transcript entries. Persistence stays in @learntogether/data; this layer
// only translates between the wire and the repositories.

import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { appendEntry, createSession, entries, exportAll, getSession, searchEntries, SESSION_KINDS } from "@learntogether/data";
// openDb is referenced only to name the handle type, hence a type import.
import type { openDb, SessionKind } from "@learntogether/data";
import { type Config } from "./config.ts";
import type { AnswerService } from "./teach/answer.ts";
import type { TurnRunner } from "./turn.ts";

/** The handle as data opens it, so this package does not need better-sqlite3 types. */
type Db = ReturnType<typeof openDb>;

export interface AppDeps {
	db: Db;
	config: Config;
	/** Destination for internals (stack traces, service messages). Never the token. */
	log: (message: string) => void;
	/** Absent until a model transport is configured: turn routes then answer 503
	 *  instead of pretending a lesson can run. */
	turn?: TurnRunner;
	/** Absent for the same reason: a verdict of a free-form check needs the model. */
	answer?: AnswerService;
}

const POLL_MS = 200;
const HEARTBEAT_MS = 15_000;
const ENTRY_PAGE = 200;
const LIMIT_MAX = 500;

function bearerOf(header: string | undefined): string | null {
	const match = /^Bearer (.+)$/i.exec(header ?? "");
	return match?.[1] ?? null;
}

/** Compared without an early byte-by-byte return: response time must not leak
 *  how much of the token was already right. */
function tokenMatches(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function isHealth(request: { method?: string; url: string }): boolean {
	return request.method === "GET" && (request.url === "/healthz" || request.url.startsWith("/healthz?"));
}

type IntParse = { ok: true; value: number | null } | { ok: false; error: string };

function parseUnsigned(raw: unknown, name: string, max: number): IntParse {
	if (raw === undefined || raw === "") return { ok: true, value: null };
	const text = String(raw);
	const value = Number(text);
	if (!Number.isInteger(value) || value < 0 || value > max) {
		return { ok: false, error: `${name} должен быть целым числом от 0 до ${max}, получено ${text}` };
	}
	return { ok: true, value };
}

/** SSE frame: one JSON payload per `data:` group. */
function dataFrame(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export function createApp(deps: AppDeps): FastifyInstance {
	const { db, config, log } = deps;
	const app = Fastify({ logger: false });

	// Access gate. The token value never reaches the reply or the log.
	app.addHook("onRequest", async (request, reply) => {
		if (config.accessToken === null || isHealth(request)) return;
		const given = bearerOf(request.headers.authorization);
		if (given !== null && tokenMatches(given, config.accessToken)) return;
		await reply
			.code(401)
			.headers({ "www-authenticate": 'Bearer realm="learntogether", error="invalid_token"' })
			.send({ error: "нужен токен" });
	});

	app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
		const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
		log(`${request.method} ${request.url}: ${error.stack ?? error.message}`);
		reply.code(status).send({ error: error.message });
	});

	app.get("/healthz", () => {
		const row = db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number };
		return { ok: true, version: "0.0.0", db: row.n };
	});

	app.post<{ Body: { kind?: unknown; modelTeacher?: unknown } }>("/sessions", (request, reply) => {
		const body = request.body;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({ error: "нужно тело JSON с полем kind" });
		}
		const { kind, modelTeacher } = body as { kind?: unknown; modelTeacher?: unknown };
		if (typeof kind !== "string" || !(SESSION_KINDS as readonly string[]).includes(kind)) {
			return reply.code(400).send({ error: `неизвестный kind, допустимо: ${SESSION_KINDS.join(", ")}` });
		}
		if (modelTeacher !== undefined && typeof modelTeacher !== "string") {
			return reply.code(400).send({ error: "modelTeacher должен быть строкой" });
		}
		const id = createSession(db, { kind: kind as SessionKind, ...(modelTeacher ? { modelTeacher } : {}) });
		return reply.code(201).send({ id });
	});

	app.get<{ Params: { id: string } }>("/sessions/:id", (request, reply) => {
		const session = getSession(db, request.params.id);
		if (!session) return reply.code(404).send({ error: `сессии ${request.params.id} нет` });
		return session;
	});

	app.get<{ Params: { id: string }; Querystring: { afterOrdinal?: string; limit?: string } }>(
		"/sessions/:id/entries",
		(request, reply) => {
			const { id } = request.params;
			if (!getSession(db, id)) return reply.code(404).send({ error: `сессии ${id} нет` });
			const after = parseUnsigned(request.query.afterOrdinal, "afterOrdinal", Number.MAX_SAFE_INTEGER);
			if (!after.ok) return reply.code(400).send({ error: after.error });
			const limit = parseUnsigned(request.query.limit, "limit", LIMIT_MAX);
			if (!limit.ok) return reply.code(400).send({ error: limit.error });
			return {
				entries: entries(db, id, {
					...(after.value !== null ? { afterOrdinal: after.value } : {}),
					...(limit.value !== null && limit.value > 0 ? { limit: limit.value } : {}),
				}),
			};
		},
	);

	// Transcript feed. An ordinal cursor over an append-only table (D-020) lets a
	// reconnecting client resume without gaps and without re-reading the session.
	app.get<{ Params: { id: string }; Querystring: { afterOrdinal?: string } }>(
		"/sessions/:id/stream",
		(request, reply) => {
			const { id } = request.params;
			if (!getSession(db, id)) return reply.code(404).send({ error: `сессии ${id} нет` });
			const after = parseUnsigned(request.query.afterOrdinal, "afterOrdinal", Number.MAX_SAFE_INTEGER);
			if (!after.ok) return reply.code(400).send({ error: after.error });

			reply.hijack();
			const res = reply.raw;
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			let cursor = after.value ?? 0;
			let done = false;
			let poll: ReturnType<typeof setInterval> | undefined;
			let beat: ReturnType<typeof setInterval> | undefined;

			const stop = () => {
				clearInterval(poll);
				clearInterval(beat);
				poll = undefined;
				beat = undefined;
			};
			const flush = () => {
				for (const entry of entries(db, id, { afterOrdinal: cursor, limit: ENTRY_PAGE })) {
					cursor = entry.ordinal;
					res.write(dataFrame(entry));
				}
			};
			const finish = (withEnd: boolean) => {
				if (done) return;
				done = true;
				stop();
				request.raw.removeListener("close", onClientClose);
				if (withEnd) res.write("event: end\ndata: {}\n\n");
				res.end();
			};
			// The client is gone: drop the timers before anything else, otherwise the
			// poll keeps a live handle and reads the database forever.
			const onClientClose = () => {
				done = true;
				stop();
			};
			const tick = () => {
				flush();
				const session = getSession(db, id);
				if (session === undefined || session.state === "closed") {
					flush();
					finish(true);
				}
			};

			request.raw.on("close", onClientClose);
			poll = setInterval(tick, POLL_MS);
			beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
			tick();
		},
	);

	// Turn routes. The turn itself is started by the client with the learner's
	// message; live events go to a separate stream (D-044), while the transcript
	// keeps the durable copy.
	app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/sessions/:id/turn", (request, reply) => {
		const runner = deps.turn;
		if (runner === undefined) return reply.code(503).send({ error: "транспорт модели не настроен" });
		const { id } = request.params;
		if (!getSession(db, id)) return reply.code(404).send({ error: `сессии ${id} нет` });
		const body = request.body as { text?: unknown } | null;
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		if (text === "") return reply.code(400).send({ error: "нужно сообщение ученика в поле text" });

		try {
			appendEntry(db, { kind: "text", role: "learner", sessionId: id, text });
			// Context, prompt and budget are the composition root's business and are
			// read from the database; the route only carries the learner's words here.
			const handle = runner.start(id);
			handle.done.catch((error: unknown) => {
				log(`ход ${handle.turnId}: ${error instanceof Error ? error.message : String(error)}`);
			});
			return reply.code(202).send({ turnId: handle.turnId, sessionId: id });
		} catch (error) {
			return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post<{ Params: { id: string } }>("/sessions/:id/turn/cancel", (request, reply) => {
		const runner = deps.turn;
		if (runner === undefined) return reply.code(503).send({ error: "транспорт модели не настроен" });
		const handle = runner.get(request.params.id);
		if (handle === undefined) return reply.code(404).send({ error: "хода нет" });
		handle.cancel();
		return { canceled: handle.turnId };
	});

	// Live events of the running turn. Not a source of truth: after a
	// disconnect the client resumes the transcript stream instead.
	app.get<{ Params: { id: string } }>("/sessions/:id/turn/stream", (request, reply) => {
		const runner = deps.turn;
		if (runner === undefined) return reply.code(503).send({ error: "транспорт модели не настроен" });
		const handle = runner.get(request.params.id);
		if (handle === undefined) return reply.code(404).send({ error: "хода нет" });

		reply.hijack();
		const res = reply.raw;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

		let closed = false;
		// Assigned after subscribe: a replay can reach `finished` synchronously, and
		// closing during that replay must not touch a binding that is not there yet.
		let unsubscribe: () => unknown = () => undefined;
		const close = () => {
			if (closed) return;
			closed = true;
			unsubscribe();
			res.end();
		};
		unsubscribe = handle.subscribe((event) => {
			res.write(dataFrame(event));
			if (event.type === "finished") close();
		});
		request.raw.on("close", close);
		handle.done.then(
			() => {
				close();
			},
			() => close(),
		);
		return undefined;
	});

	// The check the learner is expected to answer, and the answer itself. The
	// verdict of a choice is computed by us; a free-form one is compared with the
	// stored reference through the model (decision D-056).
	app.get<{ Params: { id: string } }>("/sessions/:id/check", (request, reply) => {
		const service = deps.answer;
		if (service === undefined) return reply.code(503).send({ error: "транспорт модели не настроен" });
		if (!getSession(db, request.params.id)) return reply.code(404).send({ error: `сессии ${request.params.id} нет` });
		const check = service.pending(request.params.id);
		if (check === null) return { check: null };
		return {
			check: {
				askConfidence: check.askConfidence,
				id: check.id,
				kind: check.kind,
				options: check.options,
				question: check.question,
			},
		};
	});

	app.post<{ Params: { id: string }; Body: { answer?: unknown; confidence?: unknown; hints?: unknown } }>(
		"/sessions/:id/check/answer",
		async (request, reply) => {
			const service = deps.answer;
			if (service === undefined) return reply.code(503).send({ error: "транспорт модели не настроен" });
			if (!getSession(db, request.params.id)) return reply.code(404).send({ error: `сессии ${request.params.id} нет` });
			const body = request.body as { answer?: unknown; confidence?: unknown; hints?: unknown } | null;
			const answer = body?.answer;
			if (typeof answer !== "string" && typeof answer !== "number") {
				return reply.code(400).send({ error: "нужно поле answer: номер варианта или слова ученика" });
			}
			if (typeof answer === "string" && answer.trim() === "") {
				return reply.code(400).send({ error: "пустой ответ: напиши формулировку или нажми вариант" });
			}
			try {
				const outcome = await service.answer(request.params.id, {
					answer,
					...(typeof body?.confidence === "number" ? { confidence: body.confidence } : {}),
					...(typeof body?.hints === "number" ? { hints: body.hints } : {}),
				});
				// The teacher must react to an answer: repair the step or move on. Starting
				// the turn here keeps the reaction on the server, so a client that closed
				// the tab during the answer still finds an answered lesson.
				const runner = deps.turn;
				if (runner === undefined) return { ...outcome, turnId: null };
				try {
					const handle = runner.start(request.params.id);
					handle.done.catch((error: unknown) => {
						log(`ход после ответа ${handle.turnId}: ${error instanceof Error ? error.message : String(error)}`);
					});
					return { ...outcome, turnId: handle.turnId };
				} catch (error) {
					// The answer is stored; only the reaction did not start. Saying so is
					// better than pretending the whole call failed.
					return { ...outcome, turnId: null, warning: error instanceof Error ? error.message : String(error) };
				}
			} catch (error) {
				return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
			}
		},
	);

	app.post("/export", () => {
		const written = exportAll(db, config.exportDir, new Date().toISOString());
		log(`экспорт: ${written.length} файлов в ${config.exportDir}`);
		return { files: written.length, dir: config.exportDir };
	});

	app.get<{ Querystring: { q?: string } }>("/search", (request, reply) => {
		const query = (request.query.q ?? "").trim();
		if (query === "") return reply.code(400).send({ error: "нужен непустой запрос q" });
		try {
			return { hits: searchEntries(db, query) };
		} catch (error) {
			// FTS5 syntax comes straight from the query string, so a malformed
			// expression is the caller's mistake, not a server failure.
			const reason = error instanceof Error ? error.message : String(error);
			return reply.code(400).send({ error: `запрос не разобран: ${reason}` });
		}
	});

	return app;
}
