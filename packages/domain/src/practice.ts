// How a practice problem has to be worded (docs/teaching-method.md section 6): a
// statement that names the topic measures recognition, not recall, and one node is
// never served twice in the same form. The checks are mechanical — the text has to
// hold them, not our trust in the wording.

/** Words of 5+ letters: short forms carry no topic and only add false hits. */
const MIN_TERM_LENGTH = 5;
/** Stem comparison: Russian changes the ending, so «производная» and
 *  «производной» are one name. */
const STEM_PREFIX = 5;

function foldWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-zа-яё0-9-]+/u)
		.map((word) => word.trim())
		.filter((word) => word !== "");
}

/** The node's main name: the longest content word of its wording. */
export function headTerm(wording: string): string | null {
	const words = foldWords(wording).filter((word) => word.length >= MIN_TERM_LENGTH);
	if (words.length === 0) return null;
	return words.reduce((longest, word) => (word.length > longest.length ? word : longest), words[0]!);
}

/** Did the topic name leak into the statement? Returns the leaking word, else null. */
export function termLeaked(statement: string, claimWording: string): string | null {
	const term = headTerm(claimWording);
	if (term === null) return null;
	const stem = term.slice(0, Math.min(STEM_PREFIX, term.length));
	return foldWords(statement).find((word) => word.length >= stem.length && word.slice(0, stem.length) === stem) ?? null;
}

/** Same problem or new wording: matching after spaces and case are folded is the
 *  same card, not variability. */
export function sameProblemText(a: string, b: string): boolean {
	return foldWords(a).join(" ") === foldWords(b).join(" ");
}
