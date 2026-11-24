// Levels 1 and 2 of the repair rules (docs/tool-contracts.md, "Правила валидации
// и репарации"). Level 0 (glue deltas, JSON.parse, known keys) lives in
// toolCalls.ts; level 3 (repeat the call with the validator text) belongs to the
// agent loop, which owns the retry counter.
//
// Honesty threshold: no fix here may change the meaning the learner sees. A
// level-1 coercion is applied only when it is reversible and unambiguous; a
// level-2 rule is never repaired silently, it is reported as an error.

/** Primitives the canonical subset allows (tool-contracts, "Canonical-схема"). */
export type CanonicalType = "string" | "number" | "integer" | "boolean" | "array" | "object";

/** `null` only ever appears in the two-element optional form `[T, "null"]`. */
export type CanonicalTypeRef = CanonicalType | "null";

/** One property of a canonical schema. Optional is expressed as `[T, "null"]`,
 *  never by leaving the key out of `required`. */
export interface CanonicalProperty {
	type: CanonicalTypeRef | readonly CanonicalTypeRef[];
	enum?: readonly unknown[];
	items?: CanonicalProperty;
	properties?: Record<string, CanonicalProperty>;
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	description?: string;
}

export interface CanonicalSchema {
	type?: "object";
	properties: Record<string, CanonicalProperty>;
	additionalProperties?: false;
	required?: readonly string[];
}

/** One applied fix, recorded for the transcript (`repairs[]`). `from`/`to` are
 *  the JSON rendering of the values, so a string stays visibly a string. */
export interface Repair {
	level: 1 | 2;
	field: string;
	from: string;
	to: string;
}

export type RepairOutcome =
	| { value: Record<string, unknown>; repairs: Repair[] }
	| { error: string };

/** Identity of the learner's answer (tool-contracts, "Не репарируется никогда").
 *  Editing these would rewrite the history of what the learner actually said. */
const PROTECTED_FIELDS = new Set(["question", "options", "answer", "why", "statement", "solution"]);

function isProtectedField(field: string): boolean {
	return PROTECTED_FIELDS.has(field) || field.endsWith("_id");
}

interface Coercion {
	/** When true the key is removed instead of rewritten. */
	drop: boolean;
	value: unknown;
	to: string;
}

function show(value: unknown): string {
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
}

function declaredTypes(prop: CanonicalProperty): CanonicalType[] {
	const refs = Array.isArray(prop.type) ? prop.type : [prop.type];
	return refs.filter((ref): ref is CanonicalType => ref !== "null");
}

function parseOrNull(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** A string holding a JSON array, or a one-element array whose single element is
 *  such a string (the server wrapped the list one level too deep). */
function parseJsonArray(raw: unknown): unknown[] | null {
	if (typeof raw === "string") {
		const parsed = parseOrNull(raw.trim());
		return Array.isArray(parsed) ? parsed : null;
	}
	if (Array.isArray(raw) && raw.length === 1) {
		const first = raw[0];
		if (typeof first === "string") {
			const parsed = parseOrNull(first.trim());
			return Array.isArray(parsed) ? parsed : null;
		}
	}
	return null;
}

/** The one reversible fix for this value, or null when the value stays as is. */
function coerce(raw: unknown, prop: CanonicalProperty): Coercion | null {
	// null is how the canonical subset spells "the model left this out".
	if (raw === null) return { drop: true, value: undefined, to: "absent" };

	const types = declaredTypes(prop);

	// enum goes first: the case fix subsumes the edge-trim of the same string,
	// and only a single case-insensitive match counts as unambiguous.
	if (prop.enum !== undefined && typeof raw === "string" && !prop.enum.includes(raw)) {
		const wanted = raw.trim().toLowerCase();
		const matches = prop.enum.filter((option) => typeof option === "string" && option.toLowerCase() === wanted);
		if (matches.length === 1) {
			const value = matches[0];
			return { drop: false, value, to: show(value) };
		}
		// No match or several: choosing one would be guessing the model's intent.
	}

	if (types.includes("array") && prop.items !== undefined) {
		const parsed = parseJsonArray(raw);
		if (parsed !== null) return { drop: false, value: parsed, to: show(parsed) };
	}

	if (types.includes("number") || types.includes("integer")) {
		if (typeof raw === "string") {
			const text = raw.trim();
			const num = text === "" ? Number.NaN : Number(text);
			// Reversible means a number prints this string back exactly: "1.50" and
			// "1e3" are dropped, "12" is not.
			const reversible = Number.isFinite(num) && String(num) === text;
			const fitsInteger = !types.includes("integer") || Number.isInteger(num);
			if (reversible && fitsInteger) return { drop: false, value: num, to: show(num) };
		}
	}

	if (types.includes("boolean") && typeof raw === "string") {
		const text = raw.trim().toLowerCase();
		if (text === "true" || text === "false") {
			const value = text === "true";
			return { drop: false, value, to: show(value) };
		}
	}

	if (types.includes("string") && typeof raw === "string") {
		const text = raw.trim();
		if (text !== raw) return { drop: false, value: text, to: show(text) };
	}

	return null;
}

/** Option wording lives either in `label` or, for a plain list, in the item. */
function optionLabels(options: unknown): unknown[] {
	if (!Array.isArray(options)) return [];
	return options.map((option) =>
		option !== null && typeof option === "object" && !Array.isArray(option) && "label" in option
			? (option as { label: unknown }).label
			: option,
	);
}

function labelKey(label: unknown): string {
	// Only a string label has wording to compare; anything else compares by JSON
	// so that a number 1 and a string "1" do not collide.
	return typeof label === "string" ? `s:${label.trim()}` : `j:${show(label)}`;
}

function duplicateLabel(options: unknown): string | null {
	const seen = new Set<string>();
	for (const label of optionLabels(options)) {
		const key = labelKey(label);
		if (seen.has(key)) return typeof label === "string" ? show(label.trim()) : show(label);
		seen.add(key);
	}
	return null;
}

function references(item: unknown, optionCount: number, labels: unknown[]): boolean {
	if (typeof item === "number" && Number.isInteger(item) && item >= 0 && item < optionCount) return true;
	if (typeof item !== "string") return false;
	const text = item.trim();
	if (text === "") return false;
	if (labels.some((label) => typeof label === "string" && label.trim() === text)) return true;
	const index = Number(text);
	return Number.isInteger(index) && index >= 0 && index < optionCount;
}

/** Level 2. Returns the validator text (naming the field) or null when the
 *  arguments hold together. Rules we cannot evaluate because the value is not
 *  shaped as the schema says are left to the structural validator upstream. */
function checkSemantics(schema: CanonicalSchema, value: Record<string, unknown>): string | null {
	const props = schema.properties;
	const options = value.options;
	const answer = value.answer;

	if (props.options !== undefined && Array.isArray(options)) {
		const duplicate = duplicateLabel(options);
		if (duplicate !== null) return `options contain a duplicate label: ${duplicate}`;
	}

	if (props.options !== undefined && props.answer !== undefined && answer !== undefined && Array.isArray(options)) {
		const answers = Array.isArray(answer) ? answer : [answer];
		const labels = optionLabels(options);
		if (!answers.every((item) => references(item, options.length, labels))) {
			return `answer does not reference an existing option: ${show(answer)}`;
		}
	}

	// Only record_step has both fields; check_understanding's `kind` has no
	// premises to talk about.
	if (props.kind !== undefined && props.premises !== undefined) {
		const premises = value.premises === undefined ? [] : value.premises;
		if (Array.isArray(premises)) {
			if (value.kind === "derivation" && premises.length === 0) {
				return 'premises must not be empty when kind is "derivation"';
			}
			if (value.kind === "foundation" && premises.length > 0) {
				return 'premises must be empty when kind is "foundation"';
			}
		}
	}

	return null;
}

/** Coerce what is unambiguously a type slip, refuse what would change the
 *  learner's answer, and never change anything without a `repairs[]` entry. */
export function repairArgs(
	schema: CanonicalSchema,
	args: Record<string, unknown>,
): RepairOutcome {
	const value: Record<string, unknown> = { ...args };
	const repairs: Repair[] = [];

	for (const [field, raw] of Object.entries(args)) {
		const prop = schema.properties[field];
		// An unknown key is level 0's business (known keys); we neither touch it
		// nor guess which type it was meant to have.
		if (prop === undefined) continue;
		const coercion = coerce(raw, prop);
		if (coercion === null) continue;
		if (coercion.drop) {
			// `null` is how the canonical subset spells "the model left this out".
			// Dropping the key rewrites no content, so it stays allowed even in a
			// protected field (`"answer": null` on a free-recall check is routine).
			delete value[field];
			repairs.push({ level: 1, field, from: show(raw), to: "absent" });
			continue;
		}
		// Checked before anything is applied: a protected field is never rewritten,
		// not even by a trim — the call goes back to the model instead.
		if (isProtectedField(field)) return { error: `protected field ${field}` };
		value[field] = coercion.value;
		repairs.push({ level: 1, field, from: show(raw), to: coercion.to });
	}

	const error = checkSemantics(schema, value);
	if (error !== null) return { error };
	return { value, repairs };
}
