import { createElement } from "react";
import type { ReactNode } from "react";

// Every screen must render all six states (D-013); the registry in screens.ts is
// checked against this list by test/states.test.ts.
export const SCREEN_STATES = ["EMPTY", "LOADING", "PARTIAL", "ERROR", "OFFLINE", "LONG-CONTENT"] as const;

export type ScreenState = (typeof SCREEN_STATES)[number];

export interface StateProps {
	state: ScreenState;
	message: string;
	onRetry?: () => void;
	partialCount?: number;
	total?: number;
}

const RETRY_LABEL = "Повторить";

function retryButton(props: StateProps): ReactNode {
	if (!props.onRetry) return null;
	return createElement("button", { type: "button", onClick: props.onRetry }, RETRY_LABEL);
}

function text(props: StateProps, key: string): ReactNode {
	return createElement("p", { key }, props.message);
}

/** Renders exactly one of the mandatory screen states, never an empty node. */
export function StateView(props: StateProps): ReactNode {
	switch (props.state) {
		case "EMPTY":
			return createElement(
				"div",
				{ "data-state": props.state, className: "state-view state-view--empty" },
				text(props, "message"),
			);
		case "LOADING":
			return createElement(
				"div",
				{
					"data-state": props.state,
					className: "state-view state-view--loading",
					role: "status",
					"aria-busy": true,
				},
				createElement("span", { key: "spinner", className: "state-view__spinner", "aria-hidden": true }),
				text(props, "message"),
			);
		case "PARTIAL": {
			if (props.partialCount === undefined || props.total === undefined) {
				throw new Error("PARTIAL state requires partialCount and total");
			}
			return createElement(
				"div",
				{ "data-state": props.state, className: "state-view state-view--partial" },
				text(props, "message"),
				createElement(
					"p",
					{ key: "counts" },
					`показано ${props.partialCount} из ${props.total}`,
				),
				retryButton(props),
			);
		}
		case "ERROR":
			return createElement(
				"div",
				{ "data-state": props.state, className: "state-view state-view--error", role: "alert" },
				text(props, "message"),
				retryButton(props),
			);
		case "OFFLINE":
			return createElement(
				"div",
				{ "data-state": props.state, className: "state-view state-view--offline", role: "alert" },
				createElement("p", { key: "server" }, "Сервер недоступен — связь с локальным сервером потеряна."),
				text(props, "message"),
				retryButton(props),
			);
		case "LONG-CONTENT":
			// Content unfolds instead of breaking the layout (D-013).
			return createElement(
				"div",
				{ "data-state": props.state, className: "state-view state-view--long" },
				createElement(
					"details",
					null,
					createElement("summary", null, "Развернуть полностью"),
					text(props, "message"),
				),
			);
		default: {
			const unknown: never = props.state;
			throw new Error(`unknown screen state: ${String(unknown)}`);
		}
	}
}
