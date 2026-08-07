/**
 * OneAway fork addition — deterministic proper-noun correction over transcript
 * words, ported from ~/Projects/scribe/lessons/corrections.py.
 *
 * Whisper (Workers AI or local) mishears the team's domain vocabulary — it
 * writes "email bison", "mail dozo", "aim fox". We fix this *over the stored
 * output*, never by biasing the model, so:
 *   - it is exact + free (a lookup, not inference), and
 *   - adding a pair later fixes every PAST transcript on the next reindex.
 *
 * Two layers, cheapest first (mirrors corrections.py):
 *   1. Pair replacement — a heard multi-word form ("email bison") collapses to
 *      the canonical single token ("EmailBison"). Runs over the WORD array so
 *      timings survive: the run's words merge into one word spanning them.
 *   2. Fuzzy near-miss — casing/small drift on distinctive coined single tokens
 *      only (never common-word brands like "Slack"/"Loom"), threshold 0.86.
 */

export interface CorrectableWord {
	text: string;
	start: number;
	end: number;
}

interface Term {
	/** Canonical form to emit. */
	term: string;
	/** Heard forms to replace exactly (single- or multi-token). */
	variants: string[];
	/** Enable conservative fuzzy near-miss on the canonical single token. Only
	 * safe for distinctive coined words that are NOT common English. */
	fuzzy?: boolean;
	/** Force canonical casing on a bare lowercase occurrence of the term itself
	 * (e.g. "emailbison" -> "EmailBison"). Only for tokens that are NEVER a
	 * common English word — otherwise "cut some slack" -> "Slack" and every
	 * "instantly" gets capitalized. Off by default. */
	caseFix?: boolean;
}

/** OneAway domain vocabulary. Extend freely — new pairs retro-fix old tapes. */
export const TRANSCRIPT_TERMS: Term[] = [
	// Distinctive coined brands — safe to fuzzy-match AND canonical-case.
	{
		term: "OneAway",
		variants: ["one away", "1 away", "oneaway", "one-away"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "EmailBison",
		variants: ["email bison", "e-mail bison", "mail bison", "emailbison"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "Maildoso",
		variants: ["mail dozo", "maildozo", "mail doso", "may dozo", "mail dosa"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "AimFox",
		variants: ["aim fox", "aim fax", "aimfax", "aim-fox"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "Smartlead",
		variants: ["smart lead", "smart-lead"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "Cloudflare",
		variants: ["cloud flare", "cloud-flare"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "HubSpot",
		variants: ["hub spot", "hub-spot"],
		fuzzy: true,
		caseFix: true,
	},
	{
		term: "LinkedIn",
		variants: ["linked in", "linked-in"],
		fuzzy: true,
		caseFix: true,
	},
	// Common English words that are also brands — replace explicit mishearings
	// only; never fuzzy or canonical-case (would capitalize the ordinary word).
	{ term: "Instantly", variants: ["instant lee"] },
	{ term: "Clerk", variants: [] },
	{ term: "Neon", variants: [] },
	{ term: "Railway", variants: [] },
	{ term: "Loom", variants: [] },
	{ term: "Apollo", variants: [] },
	{ term: "Slack", variants: [] },
	{ term: "Tape", variants: [] },
];

const FUZZY_THRESHOLD = 0.86;
const MIN_FUZZY_LEN = 4;

/** Lowercase + strip surrounding punctuation for comparison only. */
function normalize(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.trim()
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** difflib-style similarity in [0,1] via normalized Levenshtein distance. */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const m = a.length;
	const n = b.length;
	if (m === 0 || n === 0) return 0;
	const prev = new Array<number>(n + 1);
	const curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			// Non-null assertions: every index here is within the pre-sized
			// `n + 1` rows, so these can never be undefined at runtime. Required
			// only because tsconfig sets `noUncheckedIndexedAccess`.
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
	}
	return 1 - prev[n]! / Math.max(m, n);
}

/** Preserve any trailing punctuation from the original token on the replacement. */
function trailingPunct(text: string): string {
	const m = text.match(/[^\p{L}\p{N}]+$/u);
	return m ? m[0] : "";
}

/**
 * Apply proper-noun correction to a transcript word array (start/end in ms).
 * Returns a new array; input is not mutated. Multi-token variants collapse their
 * run into a single word spanning the run's time range.
 */
export function correctTranscriptWords<T extends CorrectableWord>(
	words: readonly T[],
): T[] {
	if (words.length === 0) return [];

	// --- Layer 1a: multi-token pair replacement over the word array ---
	// Build [tokens[], term] for multi-word variants, longest first so a longer
	// phrase wins over a shorter one nested inside it.
	const phrasePairs: { tokens: string[]; term: string }[] = [];
	for (const t of TRANSCRIPT_TERMS) {
		for (const v of t.variants) {
			const tokens = normalize(v).split(/\s+/).filter(Boolean);
			if (tokens.length >= 2) phrasePairs.push({ tokens, term: t.term });
		}
	}
	phrasePairs.sort((a, b) => b.tokens.length - a.tokens.length);

	const out: T[] = [];
	for (let i = 0; i < words.length; ) {
		let matched = false;
		for (const { tokens, term } of phrasePairs) {
			if (i + tokens.length > words.length) continue;
			let ok = true;
			for (let k = 0; k < tokens.length; k++) {
				// Guarded by the `i + tokens.length > words.length` check above.
				if (normalize(words[i + k]!.text) !== tokens[k]) {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			const first = words[i]!;
			const last = words[i + tokens.length - 1]!;
			out.push({
				...first,
				text: term + trailingPunct(last.text),
				start: first.start,
				end: last.end,
			});
			i += tokens.length;
			matched = true;
			break;
		}
		if (!matched) {
			// Bounded by the `i < words.length` loop condition.
			out.push(words[i]!);
			i += 1;
		}
	}

	// --- Layer 1b: single-token exact variant + Layer 2: fuzzy near-miss ---
	const singleVariantMap = new Map<string, string>(); // normalized variant -> term
	const fuzzyTerms: string[] = [];
	for (const t of TRANSCRIPT_TERMS) {
		if (t.caseFix) singleVariantMap.set(normalize(t.term), t.term);
		for (const v of t.variants) {
			const n = normalize(v);
			if (!n.includes(" ")) singleVariantMap.set(n, t.term);
		}
		if (t.fuzzy && !t.term.includes(" ") && t.term.length >= MIN_FUZZY_LEN) {
			fuzzyTerms.push(t.term);
		}
	}

	return out.map((w) => {
		const n = normalize(w.text);
		if (!n) return w;
		const exact = singleVariantMap.get(n);
		if (exact && exact !== w.text) {
			return { ...w, text: exact + trailingPunct(w.text) };
		}
		if (exact) return w;
		// fuzzy: only when the token is long enough to be distinctive
		if (n.length >= MIN_FUZZY_LEN) {
			let best: string | null = null;
			let bestScore = 0;
			for (const term of fuzzyTerms) {
				const s = similarity(n, normalize(term));
				if (s > bestScore) {
					bestScore = s;
					best = term;
				}
			}
			if (best && best.toLowerCase() !== n && bestScore >= FUZZY_THRESHOLD) {
				return { ...w, text: best + trailingPunct(w.text) };
			}
		}
		return w;
	});
}
