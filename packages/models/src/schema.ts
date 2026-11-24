// Canonical schema: the JSON Schema subset every adapter can express and every
// model can be held to (docs/tool-contracts.md, «Canonical-схема»). Cleaning a
// tool definition happens once at startup and is reported; validation happens on
// every call and never edits anything — only `repairArgs` changes values.

import type { CanonicalProperty, CanonicalSchema } from "./repair.ts";

const UNSUPPORTED = [
	"$ref",
	"$defs",
	"definitions",
	"oneOf",
	"anyOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"format",
	"pattern",
	"uniqueItems",
	"contains",
	"patternProperties",
	"propertyNames",
	"default",
	"examples",
	"title",
	"readOnly",
	"writeOnly",
	"deprecated",
	"const",
	"multipleOf",
];

const SCALAR = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

export interface CanonicalTool {
	name: string;
	description: string;
	parameters: CanonicalSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeRefs(value: unknown): CanonicalProperty["type"] | undefined {
	if (typeof value === "string") return SCALAR.has(value) ? (value as CanonicalProperty["type"]) : undefined;
	if (Array.isArray(value)) {
		const kept = value.filter((item) => typeof item === "string" && SCALAR.has(item));
		if (kept.length === 1) return kept[0] as CanonicalProperty["type"];
		if (kept.length > 1) return kept as CanonicalProperty["type"];
	}
	return undefined;
}

/** One property: unsupported keywords dropped, optional spelled `[T, "null"]`. */
function canonicalProperty(
	path: string,
	raw: unknown,
	required: boolean,
	dropped: string[],
): CanonicalProperty {
	if (!isRecord(raw)) throw new Error(`${path}: property schema must be an object`);

	for (const key of UNSUPPORTED) {
		if (key in raw) dropped.push(`${path}.${key}`);
	}

	const type = typeRefs(raw.type);
	if (type === undefined) throw new Error(`${path}: missing or unsupported "type"`);

	const prop: CanonicalProperty = {
		type: required ? type : [ ...(Array.isArray(type) ? type : [type]).filter((t) => t !== "null"), "null" ],
	};

	if (Array.isArray(raw.enum)) prop.enum = raw.enum;

	if (isRecord(raw.properties)) {
		const requiredKeys = new Set(Array.isArray(raw.required) ? raw.required.map(String) : []);
		const properties: Record<string, CanonicalProperty> = {};
		for (const key of Object.keys(raw.properties).sort()) {
			properties[key] = canonicalProperty(
				`${path}.properties.${key}`,
				raw.properties[key],
				requiredKeys.has(key),
				dropped,
			);
		}
		prop.properties = properties;
	}

	if (isRecord(raw.items)) {
		// Array items are always required — there is no "missing element" to spell.
		prop.items = canonicalProperty(`${path}.items`, raw.items, true, dropped);
	}

	for (const bound of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"] as const) {
		const value = raw[bound];
		if (typeof value === "number") prop[bound] = value;
	}

	if (typeof raw.description === "string") prop.description = raw.description;
	return prop;
}

/** Clean a tool definition from any config into the canonical subset. Returns
 *  every keyword that was dropped so startup can show what was lost. */
export function canonicalizeTool(tool: { name: string; description: string; parameters: unknown }): {
	tool: CanonicalTool;
	dropped: string[];
} {
	if (!isRecord(tool.parameters) || !isRecord(tool.parameters.properties)) {
		throw new Error(`tool ${tool.name}: "parameters" must be an object with "properties"`);
	}
	const dropped: string[] = [];
	const properties: Record<string, CanonicalProperty> = {};
	const requiredKeys = new Set(Array.isArray(tool.parameters.required) ? tool.parameters.required.map(String) : []);
	for (const key of Object.keys(tool.parameters.properties).sort()) {
		properties[key] = canonicalProperty(
			`properties.${key}`,
			tool.parameters.properties[key],
			requiredKeys.has(key),
			dropped,
		);
	}
	for (const key of UNSUPPORTED) {
		if (key in tool.parameters) dropped.push(key);
	}
	return {
		tool: {
			name: tool.name,
			description: tool.description,
			parameters: { additionalProperties: false, properties, required: [...requiredKeys].sort(), type: "object" },
		},
		dropped,
	};
}

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function typeMatches(value: unknown, declared: string): boolean {
	const actual = typeOf(value);
	if (declared === "number") return actual === "number" || actual === "integer";
	if (declared === "integer") return actual === "integer";
	return actual === declared;
}

function describe(declared: CanonicalProperty["type"]): string {
	const refs = Array.isArray(declared) ? declared : [declared];
	return refs.join(" or ");
}

/** Structural check of the canonical subset. Messages name the field and the
 *  expectation; the text is what gets handed back to the model on a retry. */
export function validateArgs(schema: CanonicalSchema, args: Record<string, unknown>): string[] {
	const problems: string[] = [];
	validateObject("$", schema, args, problems);
	return problems.sort();
}

function validateObject(
	path: string,
	schema: { properties: Record<string, CanonicalProperty>; additionalProperties?: false; required?: readonly string[] },
	value: Record<string, unknown>,
	problems: string[],
): void {
	const required = new Set(schema.required ?? []);

	for (const key of [...Object.keys(value)].sort()) {
		const prop = schema.properties[key];
		if (prop === undefined) {
			if (schema.additionalProperties === false) problems.push(`${path}: unknown field "${key}"`);
			continue;
		}
		validateValue(`${path}.${key}`, prop, value[key], problems);
	}

	for (const key of [...required].sort()) {
		if (value[key] === undefined) problems.push(`${path}.${key}: required field is missing`);
	}
}

function validateValue(path: string, prop: CanonicalProperty, value: unknown, problems: string[]): void {
	const allowed = Array.isArray(prop.type) ? prop.type : [prop.type];

	if (value === null && allowed.includes("null")) return;
	if (value === undefined) {
		if (!allowed.includes("null")) problems.push(`${path}: expected ${describe(prop.type)}, got undefined`);
		return;
	}

	if (!allowed.some((declared) => typeMatches(value, declared))) {
		problems.push(`${path}: expected ${describe(prop.type)}, got ${typeOf(value)}`);
		return;
	}

	if (prop.enum !== undefined && !prop.enum.some((option) => option === value)) {
		problems.push(`${path}: ${JSON.stringify(value)} is not one of ${prop.enum.map((o) => JSON.stringify(o)).join(", ")}`);
	}

	if (typeof value === "string") {
		if (prop.minLength !== undefined && value.length < prop.minLength) {
			problems.push(`${path}: shorter than minLength ${prop.minLength}`);
		}
		if (prop.maxLength !== undefined && value.length > prop.maxLength) {
			problems.push(`${path}: longer than maxLength ${prop.maxLength}`);
		}
	}

	if (typeof value === "number") {
		if (prop.minimum !== undefined && value < prop.minimum) problems.push(`${path}: below minimum ${prop.minimum}`);
		if (prop.maximum !== undefined && value > prop.maximum) problems.push(`${path}: above maximum ${prop.maximum}`);
	}

	if (Array.isArray(value)) {
		if (prop.minItems !== undefined && value.length < prop.minItems) {
			problems.push(`${path}: fewer than minItems ${prop.minItems}`);
		}
		if (prop.maxItems !== undefined && value.length > prop.maxItems) {
			problems.push(`${path}: more than maxItems ${prop.maxItems}`);
		}
		if (prop.items !== undefined) {
			for (let index = 0; index < value.length; index += 1) {
				validateValue(`${path}[${index}]`, prop.items, value[index], problems);
			}
		}
	}

	if (isRecord(value) && prop.properties !== undefined) {
		validateObject(path, { additionalProperties: false, properties: prop.properties }, value, problems);
	}
}
