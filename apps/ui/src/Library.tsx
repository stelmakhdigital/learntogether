import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, probeServer } from "./api.ts";
import { hiddenCount, listCaption } from "./lists.ts";
import type { ScreenState } from "./states.ts";
import { StateView } from "./states.ts";

// The graph as a browsable library: what the learner installed as nodes, what a
// node rests on, what rests on it, and which doubts are still open on it. Search
// is lexical (FTS5, bm25) — semantic search waits for an embedding model, and the
// screen does not promise what the server cannot measure (D-065).

interface Claim {
	createdAt: string;
	id: string;
	text: string;
	area: string | null;
	tags: string[];
}

interface Chain {
	id: string;
	conclusionId: string;
	premiseIds: string[];
}

interface Reading {
	aliases: string[];
	chains: Chain[];
	claim: Claim;
	openDoubts: { id: string; note: string | null; source: string }[];
	provenance: { id: number; sessionId: string | null; sourceId: string | null; stepId: string | null }[];
	usedIn: Chain[];
}

interface GraphPage {
	claims: Claim[];
	hits: { id: string; rank: number; text: string }[];
	query: string;
	total: number;
}

const PAGE = 50;
const LONG_TEXT = 220;

const METHOD_LABEL: Record<string, string> = {
	check_failed: "проваленная проверка",
	contradicted: "противоречие",
	calibration: "самооценка не совпала",
	missed_transfer: "не перенёс",
};

function ChainLine({ chain, role }: { chain: Chain; role: "conclusion" | "premise" }): ReactNode {
	return (
		<li className="graph__chain">
			{role === "conclusion"
				? `вывод этого узла держится на ${chain.premiseIds.length} посылке(ах)`
				: `используется как посылка в ${chain.premiseIds.length} цепочке(ах)`}
		</li>
	);
}

function NodeDetail({ reading, onOpen }: { reading: Reading; onOpen: (id: string) => void }): ReactNode {
	const wording =
		reading.claim.text.length > LONG_TEXT
			? <details className="graph__long"><summary>{reading.claim.text.slice(0, LONG_TEXT)}…</summary><p>{reading.claim.text.slice(LONG_TEXT)}</p></details>
			: <p className="graph__wording">{reading.claim.text}</p>;

	return (
		<article className="graph__node" aria-label="Узел графа">
			{wording}
			{reading.aliases.length > 0 && (
				<p className="graph__meta">другие формулировки: {reading.aliases.join("; ")}</p>
			)}
			{(reading.claim.area !== null || reading.claim.tags.length > 0) && (
				<p className="graph__meta">
					{reading.claim.area ?? "область не задана"}
					{reading.claim.tags.length > 0 ? ` · ${reading.claim.tags.join(", ")}` : ""}
				</p>
			)}
			<ul className="graph__chains">
				{reading.chains.map((chain) => (
					<ChainLine chain={chain} key={chain.id} role="conclusion" />
				))}
				{reading.usedIn.map((chain) => (
					<ChainLine chain={chain} key={`used-${chain.id}`} role="premise" />
				))}
				{reading.chains.length === 0 && reading.usedIn.length === 0 && (
					<li className="graph__meta">цепочек нет: узел ни на что не опирается и ничего не держит</li>
				)}
			</ul>
			{reading.openDoubts.length > 0 && (
				<ul className="graph__doubts">
					{reading.openDoubts.map((doubt) => (
						<li key={doubt.id}>
							сомнение открыто: {METHOD_LABEL[doubt.source] ?? doubt.source}
							{doubt.note !== null ? ` — ${doubt.note}` : ""}
						</li>
					))}
				</ul>
			)}
			{reading.provenance.map((item) => (
				<p className="graph__meta" key={item.id}>
					установлен
					{item.stepId !== null ? " шагом урока" : ""}
					{item.sourceId !== null ? " из импортированного файла" : ""}
					{item.sessionId !== null ? (
						<>
							{" "}
							<button className="app__tab" type="button" onClick={() => onOpen(item.sessionId as string)}>
								открыть урок
							</button>
						</>
					) : null}
				</p>
			))}
		</article>
	);
}

export function Library({ onOpenSession }: { onOpenSession: (id: string) => void }): ReactNode {
	const [page, setPage] = useState<GraphPage | null>(null);
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [offset, setOffset] = useState(0);
	const [reading, setReading] = useState<Reading | null>(null);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | null>(null);
	const [offline, setOffline] = useState(false);

	const load = useCallback(
		async (search: string, from: number) => {
			setLoading(true);
			setFailure(null);
			try {
				const next = await api<GraphPage>(`/graph?limit=${PAGE}&offset=${from}${search === "" ? "" : `&q=${encodeURIComponent(search)}`}`);
				setPage(next);
				setOffset(from);
				setOffline(false);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				if (/не отвечает|Failed to fetch|ECONNREFUSED/i.test(reason)) {
					setOffline(true);
					setFailure(null);
				} else {
					setFailure(reason);
				}
			} finally {
				setLoading(false);
			}
		},
		[],
	);

	const openNode = useCallback(async (id: string) => {
		try {
			setReading(await api<Reading>(`/graph/${id}`));
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		void probeServer().then((reason) => {
			if (reason !== null) {
				setOffline(true);
				setLoading(false);
				return;
			}
			void load("", 0);
		});
	}, [load]);

	const retry = useCallback(() => {
		void probeServer().then((reason) => {
			setOffline(reason !== null);
			if (reason === null) void load(query, offset);
		});
	}, [load, offset, query]);

	const submit = useCallback(
		(event: FormEvent) => {
			event.preventDefault();
			const search = draft.trim();
			setQuery(search);
			setReading(null);
			void load(search, 0);
		},
		[draft, load],
	);

	const rows: { id: string; text: string }[] =
		page === null ? [] : page.query === "" ? page.claims : page.hits;
	const hidden = page === null ? 0 : hiddenCount({ query: page.query, hits: page.hits.length, shown: rows.length, total: page.total });

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
		message = "Читаю граф…";
	} else if (rows.length === 0) {
		state = "EMPTY";
		message =
			query === ""
				? "В графе пока нет узлов: они появляются, когда учитель принимает шаг урока."
				: `По запросу «${query}» совпадений нет. Лексический поиск ищет по словам формулировки, а не по смыслу.`;
	}

	return (
		<section className="graph" aria-label="Библиотека знаний">
			<form className="graph__search" onSubmit={(event) => void submit(event)}>
				<input
					className="chat__input"
					aria-label="Поиск по формулировкам узлов"
					placeholder="Например: секущая"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<button className="chat__send" type="submit">
					{query === "" ? "Искать" : "Сбросить"}
				</button>
			</form>
			<p className="app__hint" role="status">
				{page === null ? "граф читается…" : listCaption({ query: page.query, hits: page.hits.length, total: page.total })}
				{hidden > 0 ? `, показано ${rows.length}` : ""}
			</p>
			{state !== null && <StateView message={message} onRetry={retry} state={state} />}
			{state === null && hidden > 0 && (
				<StateView
					message={`Показаны не все узлы: ещё ${hidden}. Уточните запрос или откройте следующую страницу.`}
					partialCount={rows.length}
					state="PARTIAL"
					total={rows.length + hidden}
				/>
			)}
			{rows.length > 0 && (
				<ul className="graph__list">
					{rows.map((row) => (
						<li key={row.id}>
							<button className="graph__row" type="button" onClick={() => void openNode(row.id)}>
								{row.text.length > LONG_TEXT ? `${row.text.slice(0, LONG_TEXT)}…` : row.text}
							</button>
						</li>
					))}
				</ul>
			)}
			{reading !== null && <NodeDetail onOpen={onOpenSession} reading={reading} />}
			{page !== null && page.query === "" && page.total > rows.length && (
				<button className="app__tab" type="button" onClick={() => void load(query, offset + PAGE)}>
					Показать ещё
				</button>
			)}
		</section>
	);
}
