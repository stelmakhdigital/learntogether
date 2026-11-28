import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { StateView } from "./states.ts";
import type { ScreenState } from "./states.ts";

// The live lesson: one session, its transcript, the running turn and the check
// awaiting an answer. The server API is same-origin through the dev proxy
// ("/api" → the server port). A live turn streams AgentEvents over SSE; the
// transcript stays the source of truth, so after every finished turn the panel
// refetches entries (D-044). An answer goes to its own route, never through the
// message box: the verdict of a check belongs to the check (D-056).

interface Entry {
	ordinal: number;
	role: "learner" | "teacher" | "system";
	kind: string;
	text: string;
}

interface OpenCheck {
	id: string;
	kind: string;
	question: string;
	options: { label: string; text?: string }[];
	askConfidence: boolean;
}

type Verdict = { reason: string; verdict: string };

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

const ROLE_LABEL: Record<Entry["role"], string> = {
	learner: "Вы",
	teacher: "Учитель",
	system: "Система",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	if (!response.ok) throw new Error(body?.error ?? `сервер ответил ${response.status}`);
	return body as T;
}

function TranscriptEntry({ entry }: { entry: Entry }): ReactNode {
	const long = entry.text.length > LONG_TEXT;
	const body = long
		? <details className="chat__long"><summary>{entry.text.slice(0, LONG_TEXT)}…</summary><p>{entry.text.slice(LONG_TEXT)}</p></details>
		: <p>{entry.text}</p>;
	return (
		<li className={`chat__entry chat__entry--${entry.role}`}>
			<span className="chat__role">{ROLE_LABEL[entry.role]}</span>
			{body}
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

export function Chat(): ReactNode {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [sessionId, setSessionId] = useState<string | null>(null);
	// null = online; a text = what the server refused or why it is unreachable.
	const [failure, setFailure] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [liveText, setLiveText] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [check, setCheck] = useState<OpenCheck | null>(null);
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
		api<{ ok: boolean }>("/healthz")
			.then((health) => setFailure(health.ok ? null : "сервер ответил не то"))
			.catch(() => setFailure("Сервер приложения не отвечает. Запустите его и нажмите «Повторить»."));
		return () => streamRef.current?.close();
	}, []);

	const retry = useCallback(() => {
		setFailure(null);
		api<{ ok: boolean }>("/healthz")
			.then((health) => setFailure(health.ok ? null : "сервер ответил не то"))
			.catch(() => setFailure("Сервер приложения не отвечает. Запустите его и нажмите «Повторить»."));
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

	const ensureSession = useCallback(async (): Promise<string> => {
		if (sessionId !== null) return sessionId;
		const created = await api<{ id: string }>("/sessions", {
			body: JSON.stringify({ kind: "teach" }),
			method: "POST",
		});
		setSessionId(created.id);
		return created.id;
	}, [sessionId]);

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
		message = "О чём этот урок? Напишите тему или вопрос — учитель начнёт с зондирования.";
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
					{entries.map((entry) => (
						<TranscriptEntry key={entry.ordinal} entry={entry} />
					))}
				</ol>
			)}
			{check !== null && state !== "ERROR" && (
				<CheckForm check={check} disabled={running} onSubmit={answer} />
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
				<button className="chat__send" type="submit" disabled={running || draft.trim() === ""}>
					{running ? "Идёт ход…" : "Отправить"}
				</button>
			</form>
		</section>
	);
}
