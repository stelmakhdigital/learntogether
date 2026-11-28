import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import { api, probeServer } from "./api.ts";
import { NodeDetail } from "./Library.tsx";
import type { Reading } from "./Library.tsx";
import { nodeAt, placeNodes, toWorld, visibleNodes, zoomAround } from "./graphView.ts";
import type { MapEdge, MapNode, Viewport } from "./graphView.ts";
import type { ScreenState } from "./states.ts";
import { StateView } from "./states.ts";

// The graph as a map: what a node rests on and what rests on it, where the learner put
// it, and where it stays until they move it again. Positions are the learner's, not the
// layout's (D-079): nothing is re-arranged behind their hand, and nothing in the
// teacher's context reads coordinates.
//
// Only what fits the window is drawn, so a graph of twenty thousand nodes pans at the
// rate of the pointer rather than the rate of the database.

interface GraphMap {
	edges: MapEdge[];
	hidden: number;
	nodes: MapNode[];
	settings: Record<string, string>;
	total: number;
}

const NODE_RADIUS = 9;
/** Below this zoom labels are noise: the shape of the graph is what is being read. */
const LABEL_SCALE = 0.55;

export function Graph({ onOpenSession }: { onOpenSession: (id: string) => void }): ReactNode {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [map, setMap] = useState<GraphMap | null>(null);
	const [viewport, setViewport] = useState<Viewport>({ height: 600, scale: 1, width: 800, x: -400, y: -300 });
	const [reading, setReading] = useState<Reading | null>(null);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | null>(null);
	const [offline, setOffline] = useState(false);
	/** Live positions while a node is dragged; committed to the server on release. */
	const positions = useRef<Map<string, { x: number; y: number }>>(new Map());
	const drag = useRef<{ id: string | null; moved: boolean; start: { x: number; y: number } }>({
		id: null,
		moved: false,
		start: { x: 0, y: 0 },
	});

	const load = useCallback(async () => {
		setLoading(true);
		setFailure(null);
		try {
			const next = await api<GraphMap>("/graph/map");
			setMap(next);
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

	const placed = useMemo(() => {
		if (map === null) return new Map<string, { x: number; y: number }>();
		const fresh = placeNodes(map.nodes, map.edges);
		// A node the learner moved keeps their place, not this pass's.
		for (const [id, position] of positions.current) fresh.set(id, position);
		positions.current = fresh;
		return fresh;
	}, [map]);

	const hiddenIds = useMemo(() => new Set((map?.nodes ?? []).filter((node) => node.hidden === true).map((node) => node.id)), [map]);
	const texts = useMemo(() => new Map((map?.nodes ?? []).map((node) => [node.id, node.text])), [map]);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		if (canvas === null || map === null) return;
		const ratio = window.devicePixelRatio ?? 1;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
			canvas.width = width * ratio;
			canvas.height = height * ratio;
		}
		const context = canvas.getContext("2d");
		if (context === null) return;
		const view = { ...viewport, height, width };
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		context.save();
		context.scale(view.scale, view.scale);
		context.translate(-view.x, -view.y);

		const shown = visibleNodes(placed, view, NODE_RADIUS * 2).filter((id) => !hiddenIds.has(id));
		const shownSet = new Set(shown);

		context.strokeStyle = "rgba(200,200,210,0.25)";
		context.lineWidth = 1 / view.scale;
		for (const edge of map.edges) {
			if (!shownSet.has(edge.from) || !shownSet.has(edge.to)) continue;
			const from = placed.get(edge.from)!;
			const to = placed.get(edge.to)!;
			context.beginPath();
			context.moveTo(from.x, from.y);
			context.lineTo(to.x, to.y);
			context.stroke();
		}

		for (const id of shown) {
			const position = placed.get(id)!;
			const selected = reading?.claim.id === id;
			context.beginPath();
			context.arc(position.x, position.y, NODE_RADIUS, 0, Math.PI * 2);
			context.fillStyle = selected ? "#3f7d5c" : "#2f6b52";
			context.fill();
			if (view.scale >= LABEL_SCALE) {
				const text = texts.get(id) ?? "";
				context.fillStyle = "rgba(232,232,234,0.85)";
				context.font = `${12 / view.scale}px system-ui, sans-serif`;
				context.fillText(text.length > 60 ? `${text.slice(0, 60)}…` : text, position.x + NODE_RADIUS * 1.4, position.y + 4 / view.scale);
			}
		}
		context.restore();
	}, [hiddenIds, map, placed, reading, texts, viewport]);

	useEffect(() => {
		draw();
	}, [draw]);

	const commit = useCallback(async (id: string) => {
		const position = positions.current.get(id);
		if (position === undefined) return;
		try {
			await api("/graph/positions", { body: JSON.stringify({ positions: [{ nodeId: id, x: position.x, y: position.y }] }), method: "POST" });
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		}
	}, []);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (canvas === null) return;
			const point = toWorld({ ...viewport, height: canvas.clientHeight, width: canvas.clientWidth }, { x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY });
			const hit = nodeAt(placed, point, NODE_RADIUS * 1.6);
			drag.current = { id: hit ?? null, moved: false, start: { x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY } };
			canvas.setPointerCapture(event.pointerId);
		},
		[placed, viewport],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (canvas === null || drag.current.id === null) return;
			const view = { ...viewport, height: canvas.clientHeight, width: canvas.clientWidth };
			const point = toWorld(view, { x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY });
			const position = positions.current.get(drag.current.id);
			if (position === undefined) return;
			positions.current.set(drag.current.id, { x: point.x, y: point.y });
			drag.current.moved = true;
			draw();
		},
		[draw, viewport],
	);

	const onPointerUp = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			const id = drag.current.id;
			const moved = drag.current.moved;
			drag.current = { id: null, moved: false, start: { x: 0, y: 0 } };
			if (canvas !== null) canvas.releasePointerCapture(event.pointerId);
			if (id === null) return;
			if (moved) {
				void commit(id);
				return;
			}
			// A click without a drag is a request to read the node.
			void api<Reading>(`/graph/${id}`).then(setReading).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
		},
		[commit],
	);

	const onWheel = useCallback(
		(event: ReactWheelEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (canvas === null) return;
			setViewport((current) =>
				zoomAround(
					{ ...current, height: canvas.clientHeight, width: canvas.clientWidth },
					{ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY },
					event.deltaY < 0 ? 1.15 : 1 / 1.15,
				),
			);
		},
		[],
	);

	const pan = useCallback((dx: number, dy: number) => {
		setViewport((current) => ({ ...current, x: current.x - dx / current.scale, y: current.y - dy / current.scale }));
	}, []);

	const visibleCount = map === null ? 0 : visibleNodes(placed, viewport, NODE_RADIUS * 2).filter((id) => !hiddenIds.has(id)).length;

	let state: ScreenState | null = null;
	let message = "";
	if (offline) {
		state = "OFFLINE";
		message = "Сервер приложения не отвечает. Запустите его и попробуйте снова.";
	} else if (failure !== null) {
		state = "ERROR";
		message = failure;
	} else if (loading) {
		state = "LOADING";
		message = "Читаю граф…";
	} else if (map !== null && map.nodes.length === 0) {
		state = "EMPTY";
		message = "Карты нет: в графе пока нет узлов.";
	} else if (map !== null && map.nodes.length > 0 && visibleCount === 0) {
		state = "LONG-CONTENT";
		message = `Ни одного узла в окне — их ${map.nodes.length}. Вернитесь к началу.`;
	}

	return (
		<section className="map" aria-label="Карта графа">
			<div className="map__toolbar">
				<button className="app__tab" type="button" onClick={() => pan(200, 0)}>
					←
				</button>
				<button className="app__tab" type="button" onClick={() => pan(-200, 0)}>
					→
				</button>
				<button className="app__tab" type="button" onClick={() => pan(0, 200)}>
					↑
				</button>
				<button className="app__tab" type="button" onClick={() => pan(0, -200)}>
					↓
				</button>
				<button className="app__tab" type="button" onClick={() => setViewport((current) => ({ ...current, scale: Math.min(4, current.scale * 1.25) }))}>
					приблизить
				</button>
				<button className="app__tab" type="button" onClick={() => setViewport((current) => ({ ...current, scale: Math.max(0.15, current.scale / 1.25) }))}>
					отдалить
				</button>
				<button
					className="app__tab"
					type="button"
					onClick={() => setViewport({ height: 600, scale: 1, width: 800, x: -400, y: -300 })}
				>
					в начало
				</button>
				<span className="map__count" role="status">
					{map === null ? "граф читается…" : `в окне ${visibleCount} из ${map.nodes.length}${map.hidden > 0 ? `, скрыто ${map.hidden}` : ""}`}
				</span>
			</div>
			{state !== null && <StateView message={message} state={state} {...(state === "ERROR" ? { onRetry: () => void load() } : {})} />}
			<canvas
				aria-label="Карта графа: узлы и цепочки"
				className="map__canvas"
				onPointerDown={(event) => void onPointerDown(event)}
				onPointerMove={(event) => void onPointerMove(event)}
				onPointerUp={(event) => void onPointerUp(event)}
				onWheel={(event) => void onWheel(event)}
				ref={canvasRef}
				tabIndex={0}
			/>
			{reading !== null && <NodeDetail onOpen={onOpenSession} reading={reading} />}
		</section>
	);
}
