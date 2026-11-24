import { SCREEN_STATES } from "./states.ts";
import type { ScreenState } from "./states.ts";

export type ScreenId = "session" | "library" | "review" | "settings";

export interface Screen {
	title: string;
	states: ScreenState[];
}

// A screen without all six states is not accepted (D-013); the test walks this
// registry and fails on any missing state.
export const SCREENS: Record<ScreenId, Screen> = {
	session: { title: "Сессия", states: [...SCREEN_STATES] },
	library: { title: "Библиотека", states: [...SCREEN_STATES] },
	review: { title: "Повторения", states: [...SCREEN_STATES] },
	settings: { title: "Настройки", states: [...SCREEN_STATES] },
};

export function missingStates(screen: Screen): ScreenState[] {
	return SCREEN_STATES.filter((state) => !screen.states.includes(state));
}
