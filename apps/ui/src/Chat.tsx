import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { StateView } from "./states.ts";
import type { ScreenState } from "./states.ts";

// The live lesson: one session, its transcript and the running turn. The server
// API is same-origin through the dev proxy ("/api" → the server port). A live
// turn streams AgentEvents over SSE; the transcript stays the source of truth,
// so after every finished turn the panel refetches entries (D-044).

interface Entry {
	ordinal: number;
	role: "learner" | "teacher" | "system";
	kind: string;
	text: string;
}

type LiveEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; name: string }
	| { type: "tool_result"; name: string; ok: boolean }
	| { type: "tool_rejected"; name: string; reason: string }
	| { type: "finished"; stop: string; error?: string };

const LONG_TEXT = 700;

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

export function Chat(): ReactNode {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [sessionId, setSessionId] = useState<string | null>(null);
	// null = online; a text = what the server refused or why it is unreachable.
	const [failure, setFailure] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [liveText, setLiveText] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const streamRef = useRef<EventSource | null>(null);

	const loadTranscript = useCallback(async (id: string) => {
		const data = await api<{ entries: Entry[] }>(`/sessions/${id}/entries`);
		setEntries(data.entries);
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

	const onTurnEvent = useCallback(
		(event: LiveEvent, id: string) => {
			if (event.type === "text") setLiveText((previous) => previous + event.text);
			if (event.type === "tool_call") setNotice(`инструмент: ${event.name}`);
			if (event.type === "tool_rejected") setNotice(`отказ инструмента: ${event.name} — ${event.reason}`);
			if (event.type === "finished") {
				streamRef.current?.close();
				streamRef.current = null;
				setRunning(false);
				setLiveText("");
				if (event.error !== undefined) setFailure(event.error);
				void loadTranscript(id).catch((error: unknown) =>
					setFailure(error instanceof Error ? error.message : String(error)),
				);
			}
		},
		[loadTranscript],
	);

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
				let id = sessionId;
				if (id === null) {
					const created = await api<{ id: string }>("/sessions", {
						body: JSON.stringify({ kind: "teach" }),
						method: "POST",
					});
					id = created.id;
					setSessionId(id);
				}
				await api(`/sessions/${id}/turn`, { body: JSON.stringify({ text }), method: "POST" });
				setRunning(true);
				void loadTranscript(id).catch(() => undefined);
				const source = new EventSource(`/api/sessions/${id}/turn/stream`);
				streamRef.current = source;
				source.onmessage = (message) => {
					onTurnEvent(JSON.parse(message.data as string) as LiveEvent, id!);
				};
				source.onerror = () => {
					// The stream closes by design when a turn finishes; a real drop
					// without `finished` shows itself as a stuck LOADING + retry.
					if (streamRef.current === null) return;
					source.close();
					streamRef.current = null;
					setRunning(false);
					setFailure("Связь с ходом потеряна. Отправьте сообщение ещё раз или обновите страницу.");
				};
			} catch (error) {
				setFailure(error instanceof Error ? error.message : String(error));
			}
		},
		[draft, loadTranscript, onTurnEvent, running, sessionId],
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
			{entries.length > 0 && (
				<ol className="chat__list">
					{entries.map((entry) => (
						<TranscriptEntry key={entry.ordinal} entry={entry} />
					))}
				</ol>
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
