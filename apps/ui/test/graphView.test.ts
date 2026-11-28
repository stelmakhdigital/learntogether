// The geometry of the map, tested without a canvas. These are the numbers the
// acceptance of the graph screen is written in: what is drawn is what fits the window,
// and an unplaced graph looks the same on the second launch.

import test from "node:test";
import assert from "node:assert/strict";
import { nodeAt, placeNodes, toWorld, visibleNodes, zoomAround } from "../src/graphView.ts";
import type { MapEdge, MapNode } from "../src/graphView.ts";

const view = { height: 600, scale: 1, width: 800, x: 0, y: 0 };

test("узел без сохранённой позиции встанет рядом с соседом, а не в случайный угол", () => {
	const nodes: MapNode[] = [
		{ id: "a", text: "а", x: 100, y: 50 },
		{ id: "b", text: "б" },
		{ id: "c", text: "в" },
	];
	const edges: MapEdge[] = [{ from: "a", to: "b" }];
	const placed = placeNodes(nodes, edges);
	const b = placed.get("b")!;
	assert.ok(Math.hypot(b.x - 100, b.y - 50) <= 90 + 1e-9, "сосед тянет нового узла к себе");
	// An isolated node still gets somewhere to live, and the same place twice.
	const again = placeNodes(nodes, edges);
	assert.deepEqual(placed.get("c"), again.get("c"));
});

test("сохранённая позиция не перезаписывается размещением", () => {
	const placed = placeNodes([{ id: "a", text: "а", x: -7, y: 13 }], []);
	assert.deepEqual(placed.get("a"), { x: -7, y: 13 });
});

test("в окно попадает то, что в окне, и только это", () => {
	const placed = placeNodes(
		Array.from({ length: 20_000 }, (_unused, at) => ({ id: String(at), text: `узел ${at}` })),
		[],
	);
	const started = performance.now();
	const visible = visibleNodes(placed, view, 18);
	const took = performance.now() - started;
	assert.ok(visible.length > 0, "что-то в окне есть");
	assert.ok(visible.length < 20_000 / 10, `рисовать надо часть, а не всё: ${visible.length}`);
	// Ten thousand nodes must still pan at the rate of the pointer.
	assert.ok(took < 100, `обход окна за ${took.toFixed(1)} мс — слишком медленно для перетаскивания`);
});

test("клик берёт ближайший узел, пустое место остаётся пустым местом", () => {
	const placed = new Map<string, { x: number; y: number }>([
		["near", { x: 10, y: 10 }],
		["far", { x: 14, y: 10 }],
	]);
	assert.equal(nodeAt(placed, { x: 11, y: 10 }, 9), "near");
	assert.equal(nodeAt(placed, { x: 400, y: 400 }, 9), undefined);
});

test("приближение держит точку под курсором на месте", () => {
	const before = { ...view, scale: 1 };
	const point = { x: 300, y: 200 };
	const after = zoomAround(before, point, 2);
	assert.ok(after.scale > before.scale);
	const worldBefore = toWorld(before, point);
	const worldAfter = toWorld(after, point);
	assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 1e-9);
	assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 1e-9);
});
