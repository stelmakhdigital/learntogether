// What one transcript entry looks like to the learner. A separate module because
// `node --test` cannot read JSX, and these are exactly the words a person reads:
// internal traffic must not pass for the teacher's speech, and it must not show the
// learner the arguments a tool was called with — the answer of the tool is already
// our own sentence in Russian.

export interface Entry {
	kind: string;
	ordinal: number;
	role: "learner" | "teacher" | "system";
	text: string;
}

export type ViewItem =
	| { actor: "Вы" | "Учитель"; kind: "speech"; ordinal: number; text: string }
	| { actor: "Урок"; detail: string | null; kind: "service"; ordinal: number; text: string };


/** The name of the tool in front of the line: `probe_record: замер записан` comes
 *  from the repository already shaped this way. */
function splitCall(text: string): { name: string; rest: string } {
	const at = text.indexOf(": ");
	return at === -1 ? { name: text.trim(), rest: "" } : { name: text.slice(0, at).trim(), rest: text.slice(at + 2).trim() };
}

export function viewItem(entry: Entry): ViewItem {
	if (entry.role === "learner") return { actor: "Вы", kind: "speech", ordinal: entry.ordinal, text: entry.text };
	if (entry.role === "teacher") return { actor: "Учитель", kind: "speech", ordinal: entry.ordinal, text: entry.text };
	if (entry.kind === "tool_call") {
		// The call itself is a mechanical fact: what was asked for, without the JSON
		// of the arguments. Its answer arrives as its own line and is the useful part.
		const space = entry.text.indexOf(" ");
		const name = space === -1 ? entry.text.trim() : entry.text.slice(0, space).trim();
		return { actor: "Урок", detail: null, kind: "service", ordinal: entry.ordinal, text: `вызов: ${name}` };
	}
	if (entry.kind === "tool_result") {
		const { name, rest } = splitCall(entry.text);
		return { actor: "Урок", detail: rest === "" ? null : rest, kind: "service", ordinal: entry.ordinal, text: `ответ: ${name}` };
	}
	return { actor: "Урок", detail: null, kind: "service", ordinal: entry.ordinal, text: entry.text };
}

/** Consecutive service lines are one block: a lesson that ran six tools should not
 *  push six lines of «Урок» between the teacher and the learner. */
export function groupView(items: ViewItem[]): (ViewItem | { items: ViewItem[]; kind: "services" })[] {
	const grouped: (ViewItem | { items: ViewItem[]; kind: "services" })[] = [];
	for (const item of items) {
		const last = grouped.at(-1);
		if (item.kind === "service" && last !== undefined && last.kind === "services") {
			last.items.push(item);
			continue;
		}
		if (item.kind === "service") grouped.push({ items: [item], kind: "services" });
		else grouped.push(item);
	}
	return grouped;
}
