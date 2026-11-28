// A side question is not a turn of the lesson. It is one tool-less call to the same
// model, with no lesson phases, no tools and no claim on the session's liveness: a
// learner who wants a word explained while a check is open must be able to ask, and
// must not disturb the turn that is running.
//
// What the helper is shown is the lesson as the learner sees it — the spoken entries
// of the transcript — and nothing else. The reference answer of an open check and the
// solution of an active problem are not in the transcript at all, so they cannot leak
// from here; that is why this module reads the transcript and never the checks.

import type Database from "better-sqlite3";
import { ToolRegistry, runTurn } from "@learntogether/agent";
import {
	appendSideMessage,
	appendEntry,
	createSideThread,
	liveTextEntries,
	sideMessages,
	sideThread,
	sideThreads,
	type SideThreadRow,
} from "@learntogether/data";
import type { Budget, Transport } from "@learntogether/models";

const HELPER_PROMPT =
	"Отвечай отдельно от урока и коротко: одно-два предложения по существу вопроса. " +
	"Не веди урок, не ставь шагов и проверок, не перехваливай. " +
	"Если вопрос про то, что ученик сейчас решает сам, не подсказывай решение — верни к его условию.";

/** Output the helper may spend. Its own number: a side answer is a sentence or two,
 *  and spending the lesson's whole output allowance on it would compete with a turn
 *  that may be running at the same moment. */
const SIDE_OUTPUT_TOKENS = 256;

export interface SideDeps {
	db: Database.Database;
	transport: Transport;
	/** Same measured budget a turn gets; the side call reads it, never invents one. */
	budget: () => Budget;
	signal?: AbortSignal;
}

export interface SideService {
	/** Threads of the session with their messages. */
	list(sessionId: string): { messages: { ordinal: number; role: string; text: string }[]; thread: SideThreadRow }[];
	/** Asks in a thread, creating one when the learner did not pick a thread yet. */
	ask(input: { question: string; sessionId: string; stepId?: string | null; threadId?: string }): Promise<{
		answer: string;
		threadId: string;
	}>;
}

export function createSideService(deps: SideDeps): SideService {
	const { db, transport } = deps;

	return {
		list(sessionId) {
			return sideThreads(db, sessionId).map((thread) => ({ messages: sideMessages(db, thread.id), thread }));
		},

		async ask(input) {
			const question = input.question.trim();
			if (question === "") throw new Error("пустой вопрос не задают");
			if (sideThread(db, input.threadId ?? "") === undefined) {
				if (input.threadId !== undefined && input.threadId !== "") {
					throw new Error(`нити ${input.threadId} нет в этой базе`);
				}
			} else if (sideThread(db, input.threadId ?? "")?.sessionId !== input.sessionId) {
				throw new Error(`нить ${input.threadId} нельзя продолжить в другой сессии`);
			}

			const threadId =
				input.threadId !== undefined && input.threadId !== ""
					? input.threadId
					: createSideThread(db, { sessionId: input.sessionId, ...(input.stepId === undefined ? {} : { stepId: input.stepId }) });

			appendSideMessage(db, threadId, "learner", question);
			// The question is also in the lesson's own record: a learner who later reads
			// the transcript must be able to see that they asked it, while the answer
			// stays in the thread where it belongs.
			appendEntry(db, { kind: "system_note", role: "system", sessionId: input.sessionId, text: `вопрос в стороне: ${question}` });

			const budget = deps.budget();
			const spoken = liveTextEntries(db, input.sessionId)
				.map((entry) => `${entry.role === "learner" ? "Ученик" : "Учитель"}: ${entry.text}`)
				.join("\n");

			const history = sideMessages(db, threadId);
			const result = await runTurn({
				registry: new ToolRegistry([]),
				request: {
					budget: { input: budget.input, output: Math.min(budget.output, SIDE_OUTPUT_TOKENS) },
					messages: [
						{
							content: [{ text: spoken === "" ? "Урок ещё не начался." : `Урок, как его видит ученик:\n${spoken}`, type: "text" }],
							role: "user",
						},
						...history.map((message) => ({
							content: [{ text: message.text, type: "text" as const }],
							role: message.role === "learner" ? ("user" as const) : ("assistant" as const),
						})),
					],
					reasoningLevel: "none",
					system: HELPER_PROMPT,
					tools: [],
				},
				...(deps.signal === undefined ? {} : { signal: deps.signal }),
				transport,
			});

			const answer = result.text.trim();
			if (answer === "") {
				throw new Error(`модель не ответила на стороне (стоп: ${result.stop})`);
			}
			appendSideMessage(db, threadId, "helper", answer);
			return { answer, threadId };
		},
	};
}
