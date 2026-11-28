// The geometry of the graph view, kept away from the canvas so it can be tested
// without a screen: where a node that was never placed gets drawn, which nodes a
// viewport actually has to draw, and which node a click hit.
//
// No force simulation: a layout that moves by itself under a learner who is reading
// is a layout that cannot be remembered, and positions saved by hand must survive a
// re-open exactly where they were put (D-079).

export interface MapNode {
	hidden?: boolean;
	id: string;
	text: string;
	x?: number;
	y?: number;
}

export interface MapEdge {
	from: string;
	to: string;
}

export interface Viewport {
	height: number;
	scale: number;
	width: number;
	/** World coordinates of the top-left corner of the canvas. */
	x: number;
	y: number;
}

/** Deterministic pseudo-random from a string: the same node always gets the same
 *  nudge, so an unplaced graph looks the same on the second launch. */
function jitter(seed: string): number {
	let hash = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) % 1000) / 1000;
}

const STEP = 90;
const TURNS = Math.PI * (3 - Math.sqrt(5));

/** Places the nodes that have no saved position. Order matters: nodes are walked in
 *  the order the server sent them (newest first), so a young graph grows outwards
 *  from what was learned first. */
export function placeNodes(nodes: MapNode[], edges: MapEdge[]): Map<string, { x: number; y: number }> {
	const placed = new Map<string, { x: number; y: number }>();
	for (const node of nodes) {
		if (node.x !== undefined && node.y !== undefined) placed.set(node.id, { x: node.x, y: node.y });
	}
	// Neighbours that already have a position pull a new node next to them: a chain
	// reads as a shape, not as two ends of the room.
	const neighbours = new Map<string, string[]>();
	for (const edge of edges) {
		neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
		neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
	}

	let index = 0;
	for (const node of nodes) {
		if (placed.has(node.id)) continue;
		const near = (neighbours.get(node.id) ?? []).map((id) => placed.get(id)).find((position) => position !== undefined);
		if (near !== undefined) {
			const angle = jitter(node.id) * Math.PI * 2;
			placed.set(node.id, { x: near.x + Math.cos(angle) * STEP, y: near.y + Math.sin(angle) * STEP });
			continue;
		}
		const radius = STEP * Math.sqrt(index + 1);
		const angle = index * TURNS;
		placed.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
		index += 1;
	}
	return placed;
}

/** What the canvas must actually draw. A graph of twenty thousand nodes is read
 *  through a window, and drawing what is off it is the difference between a pan that
 *  keeps up and one that does not. */
export function visibleNodes(placed: Map<string, { x: number; y: number }>, viewport: Viewport, radius: number): string[] {
	const left = viewport.x - radius;
	const top = viewport.y - radius;
	const right = viewport.x + viewport.width / viewport.scale + radius;
	const bottom = viewport.y + viewport.height / viewport.scale + radius;
	const visible: string[] = [];
	for (const [id, position] of placed) {
		if (position.x >= left && position.x <= right && position.y >= top && position.y <= bottom) visible.push(id);
	}
	return visible;
}

/** The node under a point in world coordinates, nearest first. Returns nothing when
 *  the click landed on empty space — that is a pan, not a mistake. */
export function nodeAt(placed: Map<string, { x: number; y: number }>, point: { x: number; y: number }, radius: number): string | undefined {
	let best: { distance: number; id: string } | undefined;
	for (const [id, position] of placed) {
		const dx = position.x - point.x;
		const dy = position.y - point.y;
		const distance = Math.hypot(dx, dy);
		if (distance <= radius && (best === undefined || distance < best.distance)) best = { distance, id };
	}
	return best?.id;
}

/** Screen point → world point, given a viewport. */
export function toWorld(viewport: Viewport, point: { x: number; y: number }): { x: number; y: number } {
	return { x: viewport.x + point.x / viewport.scale, y: viewport.y + point.y / viewport.scale };
}

/** Zoom around the cursor: the world point under the pointer stays under it. */
export function zoomAround(viewport: Viewport, point: { x: number; y: number }, factor: number): Viewport {
	const scale = Math.min(4, Math.max(0.15, viewport.scale * factor));
	const anchor = toWorld(viewport, point);
	return { ...viewport, scale, x: anchor.x - point.x / scale, y: anchor.y - point.y / scale };
}
