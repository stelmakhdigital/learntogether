// Context of one turn (docs/architecture.md «Поток одного хода», шаг 2): what the
// teacher may see is assembled from the database, never taken from the client.
// Three parts, in this order:
//
//   1. the method directive (the composition root's prompt),
//   2. the lesson state — steps with their states, the check awaiting an answer,
//      what the probe found held. Durable tables, so a server restart or a second
//      device cannot lose it and a client cannot inflate it,
//   3. the conversation: the one active summary, then the verbatim text entries
//      above the compaction watermark.
//
// Size is measured with the server's own tokenizer (D-051), never estimated by
// characters. When the request does not fit, the oldest exchanges are folded into
// the summary by one model call and the request is assembled again.

import type Database from "better-sqlite3";
import {
	activeSummary,
	checksForStep,
	foldTranscript,
	probesForSession,
	stepsForSession,
} from "@learntogether/data";
import type { TokenCounter } from "@learntogether/models";
import type { Budget, Message, Request, Transport } from "@learntogether/models";

/** Verbatim exchanges that stay as messages after a fold. The lesson state block is
 *  never folded away: it is what keeps the next turn on the same step.
 *  shortcut: a fixed tail; make it "as much as the budget leaves" once the method
 *  state has a measured size of its own. */
const KEEP_MESSAGES = 6;
const MAX_FOLDS_PER_TURN = 2;

const SUMMARIZER_PROMPT = `Ты сжимаешь ход урока, чтобы тот же урок мог продолжиться в другом окне контекста.
Верни список фактов:
- что ученик уже держит (проверено проверкой);
- на каком шаге урок и что на нём спрашивали;
- где ученик ошибся и в чём состояла ошибка;
- о чём договорились дальше.
Без обращений к ученику, без похвалы, без вежливых форм. Только то, что есть в тексте.`;

type LiveEntry = { ordinal: number; role: string; text: string };

function textMessage(role: Message["role"], text: string): Message {
	return { content: [{ text, type: "text" }], role };
}

/** Text entries above the watermark, oldest first. Tool calls and results are
 *  skipped on purpose: they are durable in their own tables and return to the
 *  model as the state block, which keeps a replayed history free of dangling
 *  calls without results. */
function liveEntries(db: Database.Database, sessionId: string): LiveEntry[] {
	const watermark = activeSummary(db, sessionId)?.watermark ?? 0;
	return db
		.prepare(
			`SELECT ordinal, role, text FROM transcript_entry
			 WHERE session_id = ? AND ordinal > ? AND kind = 'text' AND text <> ''
			 ORDER BY ordinal ASC`,
		)
		.all(sessionId, watermark) as LiveEntry[];
}

/** The durable lesson state in the method's own words. Without this the teacher
 *  starts the lesson from zero on every turn — the failure the live check of
 *  2026-11-28 caught on a real model. */
export function lessonStateBlock(db: Database.Database, sessionId: string): string {
	const lines: string[] = ["Состояние урока:"];
	const steps = stepsForSession(db, sessionId);
	if (steps.length === 0) {
		lines.push("- шагов ещё нет: первый запиши record_step, потом покажи present_step");
	}
	for (const step of steps) {
		const checks = checksForStep(db, step.id);
		// The id is spelled out because the model addresses steps by it: with only
		// the ordinal on screen a real model passed present_step "1" and got a
		// refusal (live check 2026-11-28).
		const parts = [`шаг ${step.ordinal} (id ${step.id}, ${step.kind}, ${step.state}): ${step.statement}`];
		const open = checks.filter((check) => check.answeredAt === null);
		if (open.length > 0) {
			const pending = open[open.length - 1]!;
			const options =
				pending.options.length > 0
					? ` варианты: ${pending.options.map((option) => `${option.label} — ${option.text ?? ""}`.trim()).join("; ")}`
					: "";
			parts.push(`ждёт ответа ученика: ${pending.question}${options}`);
		} else if (step.state === "presented") {
			parts.push(`проверки нет — следующий вызов: check_understanding со step_id ${step.id}`);
		} else if (step.state === "planned") {
			parts.push(`ещё не показан — следующий вызов: present_step со step_id ${step.id}`);
		}
		for (const check of checks.filter((item) => item.answeredAt !== null)) {
			parts.push(
				`проверка «${check.question}» — ${check.verdict}, ответ ${JSON.stringify(check.learnerAnswer)}, уверенность ${check.confidence ?? "не указана"}`,
			);
		}
		lines.push(`- ${parts.join(" | ")}`);
	}

	const held = probesForSession(db, sessionId).filter((probe) => probe.state === "held");
	if (held.length > 0) {
		lines.push(`- ученик уже держит: ${held.map((probe) => probe.statement).join("; ")}`);
	}
	lines.push("- это твоя служебная сводка, не показывай её ученику как раздел урока");
	return lines.join("\n");
}

/** One model call that returns the summary of what is being folded away. */
async function summarize(transport: Transport, budget: Budget, text: string, signal?: AbortSignal): Promise<string> {
	const parts: string[] = [];
	for await (const event of transport.stream({ budget, messages: [textMessage("user", text)], reasoningLevel: "none", system: SUMMARIZER_PROMPT, tools: [] }, signal)) {
		if (event.type === "text_delta") parts.push(event.text);
		if (event.type === "done" && event.stop !== "end") {
			throw new Error(
				`компакция не удалась: модель оборвала сводку (${event.stop})${event.error === undefined ? "" : ` — ${event.error}`}`,
			);
		}
	}
	const summary = parts.join("").trim();
	if (summary === "") throw new Error("компакция не удалась: модель вернула пустую сводку");
	return summary;
}

export interface FitContext {
	db: Database.Database;
	sessionId: string;
	/** The method directive; the composition root owns the wording. */
	system: string;
	/** Budget, tools and reasoning level of the teacher call; the context fills in
	 *  the system text and the messages. */
	request: Request;
	transport: Transport;
	counter: TokenCounter;
	signal?: AbortSignal;
	log?: (message: string) => void;
}

/** Assembles the request, measures it with the server's tokenizer and folds the
 *  oldest turns while it does not fit. Throws when there is nothing left to fold:
 *  the honest answer there is a bigger window, not a shorter lesson (D-006). */
export async function fitRequest(context: FitContext): Promise<Request> {
	const { db, sessionId, system, request, counter, transport, signal } = context;
	const log = context.log ?? (() => undefined);

	for (let fold = 0; ; fold += 1) {
		const summary = activeSummary(db, sessionId);
		const state = lessonStateBlock(db, sessionId);
		const head = summary === null ? state : `${state}\n\nЧто было до этого (сводка):\n${summary.text}`;
		const candidate: Request = {
			...request,
			messages: liveEntries(db, sessionId).map((entry) => textMessage(entry.role === "learner" ? "user" : "assistant", entry.text)),
			system: `${system}\n\n${head}`,
		};
		const used = await counter.count(candidate);
		if (used <= request.budget.input) return candidate;

		if (candidate.messages.length <= KEEP_MESSAGES) {
			throw new Error(
				`ход не влезает в измеренный контекст: ${used} токенов входа при бюджете ${request.budget.input}; ` +
					"разговора мало, а состояние урока сжимать нельзя — подними окно сервера или возьми модель с бо́льшим контекстом",
			);
		}
		if (fold >= MAX_FOLDS_PER_TURN) {
			throw new Error(
				`после ${fold} компакций вход всё ещё ${used} токенов при бюджете ${request.budget.input}: сводка не умещается, нужен контекст больше`,
			);
		}

		const dropped = liveEntries(db, sessionId).slice(0, candidate.messages.length - KEEP_MESSAGES);
		const body = dropped
			.map((entry) => `${entry.role === "learner" ? "Ученик" : "Учитель"}: ${entry.text}`)
			.join("\n");
		const merged = summary === null ? body : `${summary.text}\n\n${body}`;
		const text = await summarize(transport, request.budget, merged, signal);
		foldTranscript(db, { sessionId, text, throughOrdinal: dropped[dropped.length - 1]!.ordinal });
		log(`компакция ${fold + 1}: вход был ${used} токенов, сводка закрыла ординалы до ${dropped[dropped.length - 1]!.ordinal}`);
	}
}
