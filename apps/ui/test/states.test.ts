import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SCREEN_STATES, StateView } from "../src/states.ts";
import type { ScreenState } from "../src/states.ts";
import { SCREENS, missingStates } from "../src/screens.ts";
import type { ScreenId } from "../src/screens.ts";

// Written out literally: the contract is the six states themselves, not whatever
// the module happens to export today.
const REQUIRED: readonly ScreenState[] = ["EMPTY", "LOADING", "PARTIAL", "ERROR", "OFFLINE", "LONG-CONTENT"];

function render(props: Parameters<typeof StateView>[0]): string {
	return renderToStaticMarkup(StateView(props));
}

test("the state list matches the documented contract", () => {
	assert.deepEqual([...SCREEN_STATES], [...REQUIRED]);
});

test("every screen in the registry declares all six states", () => {
	// The list is pinned on purpose: a new screen has to be looked at, not merely
	// rendered, and adding it here is that look.
	assert.deepEqual(Object.keys(SCREENS).sort(), ["graph", "library", "review", "session", "settings"]);
	for (const id of Object.keys(SCREENS) as ScreenId[]) {
		const screen = SCREENS[id];
		assert.ok(screen.title.length > 0, `${id}: screen has no title`);
		assert.deepEqual(missingStates(screen), [], `${id}: missing states`);
		assert.deepEqual([...screen.states].sort(), [...REQUIRED].sort(), `${id}: state list`);
	}
});

test("every state renders markup tagged with that state", () => {
	for (const state of REQUIRED) {
		const html = render({
			state,
			message: "Проверочное сообщение",
			onRetry: () => {},
			partialCount: 20,
			total: 120,
		});
		assert.ok(html.length > 0, `${state}: empty markup`);
		assert.ok(html.includes(`data-state="${state}"`), `${state}: ${html}`);
	}
});

test("LOADING announces itself as a busy status", () => {
	const html = render({ state: "LOADING", message: "Готовим шаг" });
	assert.match(html, /aria-busy="true"/);
	assert.match(html, /role="status"/);
});

test("ERROR offers a retry only when a retry exists", () => {
	const withRetry = render({ state: "ERROR", message: "Шаг не прошёл", onRetry: () => {} });
	assert.match(withRetry, /<button[^>]*>Повторить<\/button>/);
	const withoutRetry = render({ state: "ERROR", message: "Шаг не прошёл" });
	assert.ok(!withoutRetry.includes("<button"), withoutRetry);
});

test("PARTIAL says how much of the list is shown and offers a retry", () => {
	const html = render({
		state: "PARTIAL",
		message: "Часть ленты не загружена",
		onRetry: () => {},
		partialCount: 20,
		total: 120,
	});
	assert.ok(html.includes("из"), html);
	assert.match(html, /показано 20 из 120/);
	assert.match(html, /<button/);
});

test("PARTIAL without counts is an error, not a silent half-render", () => {
	assert.throws(
		() => render({ state: "PARTIAL", message: "Часть ленты не загружена" }),
		/partialCount and total/,
	);
});

test("OFFLINE names the unavailable server and offers a retry", () => {
	const html = render({ state: "OFFLINE", message: "Данные не получены", onRetry: () => {} });
	assert.match(html, /сервер/i);
	assert.match(html, /<button/);
});

test("LONG-CONTENT unfolds instead of being cut off", () => {
	const html = render({ state: "LONG-CONTENT", message: "Длинный вопрос" });
	assert.match(html, /<details/);
	assert.match(html, /<summary>/);
});

test("EMPTY renders the message as an invitation", () => {
	const html = render({ state: "EMPTY", message: "Начните сессию" });
	assert.ok(html.includes("Начните сессию"), html);
});

test("an unknown state throws with its name instead of rendering nothing", () => {
	const broken = StateView as unknown as (props: { state: string; message: string }) => string;
	assert.throws(() => broken({ state: "AWAITING", message: "?" }), /AWAITING/);
});
