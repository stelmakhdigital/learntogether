import { useState } from "react";
import type { ReactNode } from "react";
import { SCREEN_STATES } from "./states.ts";
import type { ScreenState } from "./states.ts";
import { StateView } from "./states.ts";
import { SCREENS } from "./screens.ts";
import type { ScreenId } from "./screens.ts";
import { Chat } from "./Chat.tsx";

const MESSAGES: Record<ScreenState, string> = {
	"EMPTY": "Здесь появится первый вопрос. Начните сессию, чтобы задать тему.",
	"LOADING": "Готовим следующий шаг…",
	"PARTIAL": "Часть ленты ещё не загружена.",
	"ERROR": "Шаг не прошёл: модель вернула нечитаемый ответ.",
	"OFFLINE": "Не удаётся получить данные.",
	"LONG-CONTENT": "Вопрос длиннее экрана — текст разворачивается ниже, макет не ломается.",
};

export function App(): ReactNode {
	const [screenId, setScreenId] = useState<ScreenId>("session");
	const [state, setState] = useState<ScreenState>("EMPTY");
	const [attempts, setAttempts] = useState(0);
	const screen = SCREENS[screenId];

	return (
		<main className="app">
			<header className="app__header">
				<h1 className="app__title">{screen.title}</h1>
				<nav className="app__nav" aria-label="Экраны">
					{(Object.keys(SCREENS) as ScreenId[]).map((id) => (
						<button
							key={id}
							type="button"
							className="app__tab"
							aria-current={id === screenId ? "page" : undefined}
							onClick={() => setScreenId(id)}
						>
							{SCREENS[id].title}
						</button>
					))}
				</nav>
			</header>

			{screenId === "session" ? (
				<Chat />
			) : (
				<section className="app__demo" aria-label="Демонстрация состояний">
					<h2 className="app__subtitle">Состояние экрана</h2>
					<div className="app__picker">
						{SCREEN_STATES.map((value) => (
							<button
								key={value}
								type="button"
								className="app__tab"
								aria-pressed={value === state}
								onClick={() => setState(value)}
							>
								{value}
							</button>
						))}
					</div>
					<StateView
						state={state}
						message={MESSAGES[state]}
						onRetry={() => setAttempts((n) => n + 1)}
						partialCount={Math.min(20, 20 + attempts)}
						total={120}
					/>
					<p className="app__hint">Повторов: {attempts}</p>
				</section>
			)}
		</main>
	);
}
