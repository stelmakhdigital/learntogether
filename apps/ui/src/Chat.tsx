import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, probeServer } from "./api.ts";
import { groupView, viewItem } from "./view.ts";
import type { Entry, ViewItem } from "./view.ts";
import { StateView } from "./states.ts";
import type { ScreenState } from "./states.ts";

// The live lesson: one session, its transcript, the running turn and the check
// awaiting an answer. The server API is same-origin through the dev proxy
// ("/api" → the server port). A live turn streams AgentEvents over SSE; the
// transcript stays the source of truth, so after every finished turn the panel
// refetches entries (D-044). An answer goes to its own route, never through the
// message box: the verdict of a check belongs to the check (D-056).

interface OpenCheck {
	id: string;
	kind: string;
	question: string;
	options: { label: string; text?: string }[];
	askConfidence: boolean;
}

type Verdict = { reason: string; verdict: string };

/** Answer of GET /sessions/:id/turn: is the teacher writing right now, and how did
 *  the previous turn end. */
type TurnStatus = { running: boolean; stop: string | null; turnId: string | null };

/** A side thread: the learner's own question and the helper's short answer (D-078). */
type SideThread = {
	createdAt: string;
	id: string;
	messages: { ordinal: number; role: "helper" | "learner"; text: string }[];
};

type LiveEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; name: string }
	| { type: "tool_result"; name: string; ok: boolean }
	| { type: "tool_rejected"; name: string; reason: string }
	| { type: "finished"; stop: string; error?: string };

const LONG_TEXT = 700;
const VERDICT_LABEL: Record<string, string> = {
	correct: "Верно",
	incorrect: "Неверно",
	partial: "Не полностью",
};

/** Speech of the lesson: what the learner wrote and what the teacher said. */
function Speech({ item }: { item: ViewItem & { kind: "speech" } }): ReactNode {
	const long = item.text.length > LONG_TEXT;
	const body = long
		? <details className="chat__long"><summary>{item.text.slice(0, LONG_TEXT)}…</summary><p>{item.text.slice(LONG_TEXT)}</p></details>
		: <p>{item.text}</p>;
	return (
		<li className={`chat__entry chat__entry--${item.actor === "Вы" ? "learner" : "teacher"}`}>
			<span className="chat__role">{item.actor}</span>
			{body}
		</li>
	);
}

/** Tool traffic, folded by default. It is the honest record of what the lesson did
 *  — but six lines of «ответ: probe_record» between the teacher's speech push the
 *  lesson itself off the screen. */
function ServiceGroup({ items }: { items: ViewItem[] }): ReactNode {
	return (
		<li className="chat__services">
			<details>
				<summary>служебные записи хода: {items.length}</summary>
				<ul>
					{items.map((item) =>
						item.kind === "service" ? (
							<li className="chat__service" key={item.ordinal}>
								<span className="chat__service-name">{item.text}</span>
								{item.detail !== null && <span className="chat__service-detail">{item.detail}</span>}
							</li>
						) : null,
					)}
				</ul>
			</details>
		</li>
	);
}

function CheckForm({
	check,
	disabled,
	onSubmit,
}: {
	check: OpenCheck;
	disabled: boolean;
	onSubmit: (answer: string | number, confidence?: number) => Promise<void>;
}): ReactNode {
	const [choice, setChoice] = useState<number | null>(null);
	const [words, setWords] = useState("");
	const [confidence, setConfidence] = useState<number | null>(null);
	const isChoice = check.options.length > 0;
	const ready = isChoice ? choice !== null : words.trim() !== "";
	const confidenceReady = !check.askConfidence || confidence !== null;

	return (
		<form
			className="chat__check"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				const answer = isChoice ? (choice as number) : words.trim();
				void onSubmit(answer, confidence ?? undefined);
			}}
		>
			<p className="chat__check-question">{check.question}</p>
			{isChoice ? (
				<div className="chat__options" role="radiogroup" aria-label="Варианты ответа">
					{check.options.map((option, index) => (
						<label className="chat__option" key={option.label}>
							<input
								type="radio"
								name={`check-${check.id}`}
								checked={choice === index}
								disabled={disabled}
								onChange={() => setChoice(index)}
							/>
							<span>
								{option.label}
								{option.text !== undefined && option.text !== "" ? ` — ${option.text}` : ""}
							</span>
						</label>
					))}
				</div>
			) : (
				<textarea
					className="chat__words"
					aria-label="Ваш ответ"
					rows={3}
					value={words}
					disabled={disabled}
					placeholder="Сформулируйте своими словами"
					onChange={(event) => setWords(event.target.value)}
				/>
			)}
			{check.askConfidence && (
				<div className="chat__confidence" role="radiogroup" aria-label="Насколько вы уверены">
					<span className="chat__confidence-label">Уверенность до ответа:</span>
					{[1, 2, 3, 4, 5].map((level) => (
						<label className="chat__option" key={level}>
							<input
								type="radio"
								name={`confidence-${check.id}`}
								checked={confidence === level}
								disabled={disabled}
								onChange={() => setConfidence(level)}
							/>
							<span>{level}</span>
						</label>
					))}
				</div>
			)}
			<button className="chat__send" type="submit" disabled={disabled || !ready || !confidenceReady}>
				{disabled ? "Учитель отвечает…" : "Ответить"}
			</button>
		</form>
	);
}

export function Chat({
	kind = "teach",
	session = null,
	onSession,
}: {
	kind?: "practice" | "teach";
	session?: string | null;
	/** The screen above keeps the id: switching tabs must not abandon the lesson. */
	onSession?: (id: string) => void;
}): ReactNode {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [sessionId, setSessionId] = useState<string | null>(session);
	// null = online; a text = what the server refused or why it is unreachable.
	const [failure, setFailure] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [liveText, setLiveText] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [check, setCheck] = useState<OpenCheck | null>(null);
	const [side, setSide] = useState<SideThread[]>([]);
	const [sideQuestion, setSideQuestion] = useState("");
	const [sideBusy, setSideBusy] = useState(false);
	const [sideFailure, setSideFailure] = useState<string | null>(null);
	const [verdict, setVerdict] = useState<Verdict | null>(null);
	const streamRef = useRef<EventSource | null>(null);

	const refresh = useCallback(async (id: string) => {
		const [transcript, open] = await Promise.all([
			api<{ entries: Entry[] }>(`/sessions/${id}/entries`),
			api<{ check: OpenCheck | null }>(`/sessions/${id}/check`),
		]);
		setEntries(transcript.entries);
		setCheck(open.check);
	}, []);

	useEffect(() => {
		void probeServer().then((reason) => setFailure(reason === null ? null : reason));
		return () => streamRef.current?.close();
	}, []);

	const retry = useCallback(() => {
		setFailure(null);
		void probeServer().then((reason) => setFailure(reason));
	}, []);

	/** Subscribes to the live turn. The stream is a convenience: whatever it misses,
	 *  the transcript refill brings back. */
	const watchTurn = useCallback(
		(id: string) => {
			setRunning(true);
			const source = new EventSource(`/api/sessions/${id}/turn/stream`);
			streamRef.current = source;
			source.onmessage = (message) => {
				const event = JSON.parse(message.data as string) as LiveEvent;
				if (event.type === "text") setLiveText((previous) => previous + event.text);
				if (event.type === "tool_call") setNotice(`инструмент: ${event.name}`);
				if (event.type === "tool_rejected") setNotice(`отказ инструмента: ${event.name} — ${event.reason}`);
				if (event.type === "finished") {
					source.close();
					streamRef.current = null;
					setRunning(false);
					setLiveText("");
					if (event.error !== undefined) setFailure(event.error);
					void refresh(id).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
				}
			};
			source.onerror = () => {
				// The stream closes by design when a turn finishes; a real drop without
				// a `finished` frame shows itself as a stuck LOADING plus this message.
				if (streamRef.current === null) return;
				source.close();
				streamRef.current = null;
				setRunning(false);
				setFailure("Связь с ходом потеряна. Отправьте сообщение ещё раз или обновите страницу.");
			};
		},
		[refresh],
	);

	const cancel = useCallback(async () => {
		const id = sessionId;
		if (id === null) return;
		try {
			await api<{ canceled: string }>(`/sessions/${id}/turn/cancel`, { method: "POST" });
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		}
	}, [sessionId]);

	/** Opens a session: its transcript, and whether the teacher is mid-turn right
	 *  now. A reload in the middle of a lesson must not look like a stalled one —
	 *  the turn stream replays what already happened, so the learner sees the turn
	 *  continue rather than restart, and can always cancel it. */
	const resume = useCallback(
		async (id: string) => {
			const transcript = await api<{ entries: Entry[] }>(`/sessions/${id}/entries`);
			setEntries(transcript.entries);
			void api<{ threads: SideThread[] }>(`/sessions/${id}/side`)
				.then((answered) => setSide(answered.threads))
				.catch(() => setSide([]));
			const turn = await api<TurnStatus>(`/sessions/${id}/turn`);
			if (turn.running) watchTurn(id);
			else await refresh(id);
		},
		[refresh, watchTurn],
	);

	// A session started on another screen arrives as a prop: adopt it, refill it.
	useEffect(() => {
		if (session === null) return;
		setSessionId(session);
		void resume(session).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
	}, [resume, session]);

	/** A side question goes to its own route and never through the lesson composer:
	 *  it must not answer a check, must not start a turn and must not be lost if the
	 *  teacher is writing at the same moment. */
	const askSide = useCallback(
		async (event: FormEvent) => {
			event.preventDefault();
			const id = sessionId;
			const question = sideQuestion.trim();
			if (id === null || question === "" || sideBusy) return;
			setSideBusy(true);
			setSideFailure(null);
			try {
				const last = side.at(-1);
				await api<{ answer: string; threadId: string }>(`/sessions/${id}/side`, {
					body: JSON.stringify({ question, ...(last === undefined ? {} : { threadId: last.id }) }),
					method: "POST",
				});
				setSideQuestion("");
				// The answer is read back from the server rather than pasted in: the
				// thread is the record, and the window should show the record.
				const threads = await api<{ threads: SideThread[] }>(`/sessions/${id}/side`);
				setSide(threads.threads);
			} catch (error) {
				setSideFailure(error instanceof Error ? error.message : String(error));
			} finally {
				setSideBusy(false);
			}
		},
		[side, sideBusy, sideQuestion, sessionId],
	);

	const ensureSession = useCallback(async (): Promise<string> => {
		if (sessionId !== null) return sessionId;
		const created = await api<{ id: string }>("/sessions", {
			body: JSON.stringify({ kind }),
			method: "POST",
		});
		setSessionId(created.id);
		onSession?.(created.id);
		return created.id;
	}, [kind, onSession, sessionId]);

	const submit = useCallback(
		async (event: FormEvent) => {
			event.preventDefault();
			const text = draft.trim();
			if (text === "" || running) return;
			setDraft("");
			setFailure(null);
			setNotice(null);
			setLiveText("");
			try {
				const id = await ensureSession();
				await api(`/sessions/${id}/turn`, { body: JSON.stringify({ text }), method: "POST" });
				void refresh(id).catch(() => undefined);
				watchTurn(id);
			} catch (error) {
				setFailure(error instanceof Error ? error.message : String(error));
			}
		},
		[draft, ensureSession, refresh, running, watchTurn],
	);

	const answer = useCallback(
		async (value: string | number, confidence?: number) => {
			const id = sessionId;
			if (id === null) return;
			setFailure(null);
			setVerdict(null);
			try {
				const outcome = await api<{ probeState: string; reason: string; stepState: string; turnId: string | null; verdict: string }>(
					`/sessions/${id}/check/answer`,
					{ body: JSON.stringify({ answer: value, ...(confidence === undefined ? {} : { confidence }) }), method: "POST" },
				);
				setVerdict({ reason: outcome.reason, verdict: outcome.verdict });
				await refresh(id).catch(() => undefined);
				if (outcome.turnId !== null) watchTurn(id);
			} catch (error) {
				setFailure(error instanceof Error ? error.message : String(error));
			}
		},
		[refresh, sessionId, watchTurn],
	);

	let state: ScreenState | null = null;
	let message = "";
	if (failure !== null) {
		state = "ERROR";
		message = failure;
	} else if (running) {
		state = "LOADING";
		message = liveText === "" ? "Учитель думает…" : liveText;
	} else if (entries.length === 0) {
		state = "EMPTY";
		message =
			kind === "practice"
				? "Практика. Учитель даст задачу по первому элементу очереди — напиши что-нибудь, чтобы он начал."
				: "О чём этот урок? Напишите тему или вопрос — учитель начнёт с зондирования.";
	}

	return (
		<section className="chat" aria-label="Урок">
			{state !== null && <StateView state={state} message={message} {...(state === "ERROR" ? { onRetry: retry } : {})} />}
			{notice !== null && state !== "ERROR" && <p className="chat__notice" role="status">{notice}</p>}
			{verdict !== null && (
				<p className={`chat__verdict chat__verdict--${verdict.verdict}`} role="status">
					{VERDICT_LABEL[verdict.verdict] ?? verdict.verdict}
					{verdict.reason !== "" ? ` — ${verdict.reason}` : ""}
				</p>
			)}
			{entries.length > 0 && (
				<ol className="chat__list">
					{groupView(entries.map(viewItem)).flatMap((item, at): ReactNode => {
						if (item.kind === "services") return <ServiceGroup items={item.items} key={`s${at}`} />;
						if (item.kind === "speech") return <Speech item={item} key={item.ordinal} />;
						return null;
					})}
				</ol>
			)}
			{check !== null && state !== "ERROR" && (
				<CheckForm check={check} disabled={running} onSubmit={answer} />
			)}
			{sessionId !== null && (
				<details className="side">
					<summary>Спросить отдельно</summary>
					{side.length === 0 && <p className="side__empty">Вопросов пока не было. Ответ приходит коротко и не трогает урок.</p>}
					{side.map((thread) => (
						<ul className="side__list" key={thread.id}>
							{thread.messages.map((message) => (
								<li className={`side__item side__item--${message.role}`} key={message.ordinal}>
									{message.text}
								</li>
							))}
						</ul>
					))}
					{sideFailure !== null && (
						<p className="side__error" role="alert">
							{sideFailure}
						</p>
					)}
					<form className="side__form" onSubmit={(event) => void askSide(event)}>
						<input
							aria-label="Вопрос вне урока"
							disabled={sideBusy}
							placeholder="Например: что такое секущая"
							value={sideQuestion}
							onChange={(event) => setSideQuestion(event.target.value)}
						/>
						<button type="submit" disabled={sideBusy || sideQuestion.trim() === ""}>
							{sideBusy ? "Отвечает…" : "Спросить"}
						</button>
					</form>
				</details>
			)}
			<form className="chat__form" onSubmit={(event) => void submit(event)}>
				<input
					className="chat__input"
					aria-label="Сообщение учителю"
					value={draft}
					disabled={running}
					placeholder="Например: объясни, что такое производная"
					onChange={(event) => setDraft(event.target.value)}
				/>
				{running && (
					<button className="chat__cancel" type="button" onClick={() => void cancel()}>
						Отменить ход
					</button>
				)}
				<button className="chat__send" type="submit" disabled={running || draft.trim() === ""}>
					{running ? "Идёт ход…" : "Отправить"}
				</button>
			</form>
		</section>
	);
}
