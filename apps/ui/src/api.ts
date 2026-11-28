// One place to talk to the server: same-origin through the dev proxy ("/api" →
// the server port). A refusal carries the server's own words: the screen shows
// them unchanged, because they name what the learner can do next.

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
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
