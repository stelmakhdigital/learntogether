// Argument reading shared by the tool executors. The canonical schema spells an
// optional field as ["string","null"], so an absent value arrives either as
// undefined or as null, and a real model sends both forms.

export function requireString(args: Record<string, unknown>, field: string): string {
	const value = args[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field}: нужна непустая строка`);
	}
	return value;
}

export function optionalString(args: Record<string, unknown>, field: string): string | undefined {
	const value = args[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field}: нужна непустая строка или null`);
	}
	return value;
}

export function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${field}: нужен массив непустых строк`);
	}
	return value as string[];
}
