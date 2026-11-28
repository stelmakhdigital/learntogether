// One place to talk to the server: same-origin through the dev proxy ("/api" →
// the server port). A refusal carries the server's own words: the screen shows
// them unchanged, because they name what the learner can do next.

// The desktop shell and the PWA hand the access token in the URL fragment: the
// fragment is not sent to the server, so the token stays out of its logs while a
// reload of the window still finds it. In the dev server no token is set at all.
function tokenFromFragment(): string | null {
	const [, token] = /[?&#]token=([^&#]+)/.exec(window.location.hash) ?? [];
	return token === undefined ? null : decodeURIComponent(token);
}

const accessToken = typeof window === "undefined" ? null : tokenFromFragment();

/** Where the API lives. In dev the Vite server forwards "/api" to the application
 *  server and strips the prefix, so the routes themselves stay at the root. Once
 *  the same server serves the built interface, it is the same origin already. */
const base = import.meta.env.DEV ? "/api" : "";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(accessToken === null ? {} : { authorization: `Bearer ${accessToken}` }),
			...(init?.headers ?? {}),
		},
	});
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	if (!response.ok) throw new Error(body?.error ?? `сервер ответил ${response.status}`);
	return body as T;
}

/** Health probe shared by the screens: a dead server must say so as OFFLINE, not
 *  as an empty list that looks like an empty lesson. */
export async function probeServer(): Promise<string | null> {
	try {
		const health = await api<{ ok: boolean }>("/healthz");
		return health.ok ? null : "сервер ответил не то";
	} catch {
		return "Сервер приложения не отвечает. Запустите его и нажмите «Повторить».";
	}
}

export const OFFLINE_MESSAGE = "Сервер приложения не отвечает. Запустите его и нажмите «Повторить».";
