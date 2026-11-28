// The acceptance walk of этап 3: one lesson from the learner's first sentence to a
// second step, driven through the HTTP routes against a scripted model, with no
// manual writes. What has to hold after the walk is the method itself: a probe and
// a goal before any step, a held node out of the plan, every step with its check,
// no acceptance without a correct verdict, and a repair that does not touch what
// the learner already holds.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "@learntogether/agent";
import { createFakeTransport, type Request } from "@learntogether/models";
import { migrate, openDb } from "@learntogether/data";
import { createApp } from "../src/app.ts";
import { fitRequest, unmetCheck } from "../src/context.ts";
import { DEFAULT_PORT, type Config } from "../src/config.ts";
import { createAnswerService } from "../src/teach/answer.ts";
import { TEACHER_PROMPT } from "../src/teach/prompt.ts";
import { createTeachTools } from "../src/teach/tools.ts";
import { TurnRunner } from "../src/turn.ts";

const migrationsDir = fileURLToPath(new URL("../../data/migrations", import.meta.url));

const config: Config = {
	accessToken: null,
	allowInsecure: false,
	exportDir: "/tmp/lth-flow-export",
	host: "127.0.0.1",
	language: "ru",
	port: DEFAULT_PORT,
	source: null,
	model: null,
};

const budget = () => ({ input: 8000, output: 600 });

/** Stands in for the server's exact counter; the walk is about the sequence, and
 *  the fold decision is not what this test measures. */
const counter = { count: async (request: Request) => JSON.stringify(request).length >> 3 };

/** A held statement plus a plan whose first node repeats it: the walk has to show
 *  the node pruned rather than taught. */
const HELD = "Сложение можно выполнять по частям";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ args, id, name });

/** The scripted teacher: measuring, goal, plan, one step with its check, and after
 *  the answer a second step. Steps are addressed by ordinal on purpose — that is
 *  what a real model sends (live checks 2026-11-28). */
const script = [
	{ calls: [call("p1", "probe_record", { items: [{ confidence: 4, statement: HELD, state: "held" }] })] },
	{
		calls: [
			call("g1", "goal_state", {
				raw: "хочу понять производную",
				ready_when: "ученик сам связывает производную со скоростью",
				statements: ["объяснить производную как скорость изменения"],
			}),
		],
	},
	{
		calls: [
			call("pl1", "plan_set", {
				nodes: [
					{ label: HELD, node_id: "h1", why_needed: "опора для приращения" },
					{ depends_on: ["h1"], label: "Приращение функции", node_id: "n1", why_needed: "из чего состоит отношение" },
				],
			}),
		],
	},
	{
		calls: [
			call("s1", "record_step", {
				kind: "foundation",
				motivation: "без него отношение приращений неоткуда взять",
				premises: [],
				statement: "Приращение — это разница значений функции.",
			}),
		],
	},
	{ calls: [call("s2", "present_step", { step_id: "1", text: "смотри: приращение — разница значений" })] },
	{
		calls: [
			call("s3", "check_understanding", {
				answer: ["б"],
				ask_confidence: true,
				kind: "single_choice",
				options: [
					{ label: "а", text: "значение функции" },
					{ label: "б", text: "разница значений" },
				],
				question: "Что такое приращение?",
				step_id: "1",
			}),
		],
	},
	{ text: "Выбери вариант." },
	// The teacher's reaction to a correct answer: the next step, same discipline.
	{
		calls: [
			call("s4", "record_step", {
				kind: "derivation",
				premises: ["Приращение — это разница значений функции."],
				statement: "Отношение приращений даёт среднюю скорость.",
			}),
		],
	},
	{ calls: [call("s5", "present_step", { step_id: "2", text: "отношение приращений — средняя скорость" })] },
	{
		calls: [
			call("s6", "check_understanding", {
				answer: ["средняя скорость"],
				ask_confidence: true,
				kind: "free_recall",
				question: "Что даёт отношение приращений?",
				step_id: "2",
			}),
		],
	},
	{ text: "Ответь своими словами." },
];

async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
	const body = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
	return body as T;
}

test("a whole lesson walks through the phases and leaves the invariants intact", async (t) => {
	const db = openDb(":memory:");
	migrate(db, migrationsDir);
	const transport = createFakeTransport({ turns: script });
	const runner = new TurnRunner(db, {
		buildRequest: async (sessionId): Promise<Request> => {
			const registry = new ToolRegistry(createTeachTools(db, sessionId));
			return fitRequest({
				counter,
				db,
				request: {
					budget: budget(),
					messages: [],
					reasoningLevel: "none",
					system: "",
					tools: registry.definitions(),
				},
				sessionId,
				system: TEACHER_PROMPT,
				transport,
			});
		},
		registry: (database, sessionId) => new ToolRegistry(createTeachTools(database, sessionId)),
		transport,
		unmetCheck: (sessionId) => unmetCheck(db, sessionId),
	});
	const answer = createAnswerService({ budget, db, transport });
	const app = createApp({ answer, config, db, log: () => {}, turn: runner });
	t.after(() => app.close());
	await app.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.address();
	if (address === null || typeof address === "string") throw new Error("сервер не слушает порт");
	const base = `http://127.0.0.1:${address.port}`;
	let sessionId = "";
	const wait = async () => {
		const turn = runner.get(sessionId);
		assert.ok(turn, "ход не начался");
		await turn.done;
	};

	const created = await json<{ id: string }>(`${base}/sessions`, { body: JSON.stringify({ kind: "teach" }), method: "POST" });
	sessionId = created.id;

	await json(`${base}/sessions/${sessionId}/turn`, { body: JSON.stringify({ text: "хочу понять производную" }), method: "POST" });
	await wait();

	const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
	// The phases landed as facts, not as words in a transcript.
	assert.deepEqual(
		rows<{ statement: string; state: string }>("SELECT statement, state FROM probe_item"),
		[{ statement: HELD, state: "held" }],
	);
	const goal = db.prepare("SELECT raw, ready_when, statements_json FROM goal").get() as {
		raw: string;
		ready_when: string;
		statements_json: string;
	};
	assert.equal(goal.raw, "хочу понять производную");
	assert.match(goal.ready_when, /связывает производную/);
	const plan = rows<{ label: string; state: string }>("SELECT label, state FROM plan_node ORDER BY ordinal");
	assert.deepEqual(plan, [
		{ label: HELD, state: "pruned_held" },
		{ label: "Приращение функции", state: "todo" },
	]);
	const session = db.prepare("SELECT state FROM session").get() as { state: string };
	assert.equal(session.state, "teaching", "первый шаг переводит урок в обучение");

	// The check of step 1 is open, and only one check waits at a time.
	const open = await json<{ check: { askConfidence: boolean; kind: string } | null }>(
		`${base}/sessions/${sessionId}/check`,
	);
	assert.equal(open.check?.kind, "single_choice");
	assert.equal(open.check?.askConfidence, true);
	assert.equal(rows<{ n: number }>("SELECT COUNT(*) AS n FROM step_check WHERE answered_at IS NULL")[0]!.n, 1);

	const graded = await json<{ stepState: string; verdict: string }>(`${base}/sessions/${sessionId}/check/answer`, {
		body: JSON.stringify({ answer: 1, confidence: 4 }),
		method: "POST",
	});
	assert.equal(graded.verdict, "correct");
	assert.equal(graded.stepState, "accepted");
	await wait();

	// Accepted step plus the second step, each with its own check: the walk did not
	// stop after one step and did not leave a step unasked about.
	const steps = rows<{ ordinal: number; state: string; checks: number }>(
		`SELECT s.ordinal AS ordinal, s.state AS state, (SELECT COUNT(*) FROM step_check c WHERE c.step_id = s.id) AS checks
		 FROM step s ORDER BY s.ordinal`,
	);
	assert.deepEqual(steps, [
		{ checks: 1, ordinal: 1, state: "accepted" },
		{ checks: 1, ordinal: 2, state: "presented" },
	]);
	// The wording the learner was praised for is still the wording that was taught.
	const taught = db.prepare("SELECT statement FROM step WHERE ordinal = 1").get() as { statement: string };
	assert.equal(taught.statement, "Приращение — это разница значений функции.");
	// The learner's own words are in the conversation, not only in the check row.
	const said = db
		.prepare("SELECT text FROM transcript_entry WHERE role = 'learner' ORDER BY ordinal")
		.all() as { text: string }[];
	assert.match(said.at(-1)!.text, /б — разница значений/);
	// No check without a step, no step without a check: what the invariants claim.
	const orphans = rows<{ n: number }>("SELECT COUNT(*) AS n FROM step_check WHERE step_id NOT IN (SELECT id FROM step)");
	assert.equal(orphans[0]!.n, 0);
	const ungraded = rows<{ n: number }>(
		`SELECT COUNT(*) AS n FROM step s
		 WHERE s.state = 'accepted'
		   AND NOT EXISTS (SELECT 1 FROM step_check c WHERE c.step_id = s.id AND c.verdict = 'correct')`,
	);
	assert.equal(ungraded[0]!.n, 0);
	db.close();
});
