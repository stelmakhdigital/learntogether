import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, probeServer } from "./api.ts";
import { itemMark } from "./lists.ts";
import type { ScreenState } from "./states.ts";
import { StateView } from "./states.ts";

// What is ripe for practice, in the order the server serves it: an open doubt
// first, then what came due, then what has never been practiced. The screen does
// not offer a self-rating button: a rating is our verdict on a solved problem, and
// a learner grading themselves would poison the schedule (D-035, D-069).

interface QueueItem {
	claimId: string;
	claimText: string;
	dueAt: string | null;
	early: boolean;
	hasDoubt: boolean;
	itemId: string;
	method: "recall" | "reasoning" | "transfer";
}

const METHOD_LABEL: Record<QueueItem["method"], string> = {
	recall: "припоминание",
	reasoning: "рассуждение",
	transfer: "перенос",
};

const PAGE = 20;

export function Review({ onStart }: { onStart: (sessionId: string) => void }): ReactNode {
	const [items, setItems] = useState<QueueItem[] | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [offline, setOffline] = useState(false);
	const [loading, setLoading] = useState(true);
	const [starting, setStarting] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setFailure(null);
		try {
			const queue = await api<{ items: QueueItem[] }>(`/queue?limit=${PAGE}`);
			setItems(queue.items);
			setOffline(false);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (/не отвечает|Failed to fetch|ECONNREFUSED/i.test(reason)) setOffline(true);
			else setFailure(reason);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void probeServer().then((reason) => {
			if (reason !== null) {
				setOffline(true);
				setLoading(false);
				return;
			}
			void load();
		});
	}, [load]);

	const retry = useCallback(() => {
		void probeServer().then((reason) => {
			setOffline(reason !== null);
			if (reason === null) void load();
		});
	}, [load]);

	const start = useCallback(async () => {
		setStarting(true);
		setFailure(null);
		try {
			const created = await api<{ id: string }>("/sessions", {
				body: JSON.stringify({ kind: "practice" }),
				method: "POST",
			});
			onStart(created.id);
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			setStarting(false);
		}
	}, [onStart]);

	let state: ScreenState | null = null;
	let message = "";
	if (offline) {
		state = "OFFLINE";
		message = "Сервер приложения не отвечает. Запустите его и нажмите «Повторить».";
	} else if (failure !== null) {
		state = "ERROR";
		message = failure;
	} else if (loading) {
		state = "LOADING";
		message = "Считаю, что созрело для повторения…";
	} else if (items !== null && items.length === 0) {
		state = "EMPTY";
		message = "Повторять пока нечего: ни одного узла с открытым сомнением или наступившим сроком.";
	}

	return (
		<section className="review" aria-label="Повторения">
			{state !== null && <StateView message={message} onRetry={retry} state={state} />}
			{items !== null && items.length >= PAGE && (
				<StateView
					message={`Показаны ${PAGE} ближайших элемента, очередь длиннее.`}
					partialCount={PAGE}
					state="PARTIAL"
					total={items.length + 1}
				/>
			)}
			{items !== null && items.length > 0 && (
				<>
					<ol className="review__list">
						{items.map((item) => (
							<li className="review__item" key={item.itemId}>
								<span className="review__wording">{item.claimText}</span>
								<span className="app__hint">
									{METHOD_LABEL[item.method]} · {itemMark(item)}
								</span>
							</li>
						))}
					</ol>
					<p className="app__hint">
						Задачу формулирует учитель по первому элементу очереди; условие не называет тему узла,
						иначе меряется узнавание, а не припоминание.
					</p>
					<button className="chat__send" type="button" disabled={starting} onClick={() => void start()}>
						{starting ? "Завожу сессию…" : "Начать практику"}
					</button>
				</>
			)}
		</section>
	);
}
