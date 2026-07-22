"use strict";

const { computeFrecencyScore, DEFAULT_FRECENCY_HALF_LIFE_DAYS } = require("../launcher-providers/ranking.cjs");

// ---------------------------------------------------------------------------
// Pure ranking for the file index (WP-2.7). Blends five signals into one
// additive score, exactly like electron/services/launcher-providers/
// ranking.cjs blends matchScore + frecencyScore for the launcher's
// cross-provider list -- no I/O, no db handle, no Electron: every input
// arrives already computed (a plain row, the query text, and a plain
// path -> {count, lastTs} lookup for frecency), which is what makes this
// deterministic and unit-testable with fixed inputs. store.cjs's
// searchFiles() is the only production caller: it runs the SQL (env scoping,
// ext:/in: filters, the FTS5 MATCH + bm25 pre-sort) to produce a bounded
// CANDIDATE pool, gathers frecency stats with one indexed query, and hands
// both to rankFileResults() below. Nothing here reaches into a database.
//
// -- Reuse, not reinvention ---------------------------------------------
// The frecency signal is `computeFrecencyScore` imported DIRECTLY from
// ranking.cjs -- same frequency-saturation-at-5 and 7-day half-life-decay
// formula the launcher already uses and already has fixed-input tests for.
// "How often has the user opened this exact file from the launcher, and how
// recently" is not a file-specific concept; there is nothing to specialize
// here, so this module adds no second implementation of it. Everything else
// below (name matching, mtime recency, path depth, bm25 normalization,
// environment association) has no launcher-wide equivalent to reuse, so
// those are new, file-specific pure functions.
//
// -- The blend -------------------------------------------------------------
// matchScore (0-100, fuzzy name match against the query) is the PRIMARY,
// dominant signal -- every other signal is additive on top of it, each
// capped by its own weight so that no single secondary signal can flip a
// large matchScore gap (mirrors ranking.cjs's own "frecency can only ever
// add, never let a poor match outrank a great one" discipline; see this
// file's tests for the fixed-input proof). bm25 (FTS5's own relevance score
// for the `name` column) is folded in as ANOTHER additive signal, not the
// final answer on its own -- it captures term-frequency/IDF nuance our own
// rule-based tiers don't, but a rule-based exact/prefix match should still
// usually beat a merely bm25-favoured row.
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = Object.freeze({
	bm25Weight: 0.15, // max +15 -- bm25 is one input, never decisive alone
	frecencyWeight: 0.3, // max +30 -- reuses ranking.cjs's own scale/semantics
	recencyWeight: 0.15, // max +15 -- a freshly modified file edges out a stale one
	depthWeight: 0.05, // max +5 -- weakest signal, a pure tie-breaker in practice
	environmentWeight: 0.1, // max +10 -- boosts, never gates (see this file's header)
});

// Files decay much slower than launcher-execute frecency (7-day half-life,
// see ranking.cjs): a document you last touched three weeks ago is still
// very plausibly "the file", whereas a launcher action you haven't run in
// three weeks has genuinely gone cold. 30 days keeps recency meaningful for
// weeks without letting it dominate a fresh, well-matched result.
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

function normalizeQuery(query) {
	return typeof query === "string" ? query.trim().toLowerCase() : "";
}

function tokenize(text) {
	if (typeof text !== "string") {
		return [];
	}
	return text.match(/[\w.-]+/gu) ?? [];
}

// A word boundary is anywhere a name transitions out of a separator
// (`-`, `_`, `.`, space) into a new run of characters -- e.g. "march" is a
// word-boundary match inside "invoice-march.pdf" even though it isn't a
// plain prefix of the whole name. Deliberately simple (no camelCase-hump
// detection): the file index only ever indexes `name`, and Windows
// filenames lean on separators far more than camelCase.
function isWordBoundaryMatch(haystack, needle) {
	if (!needle) {
		return false;
	}
	let searchFrom = 0;
	for (;;) {
		const at = haystack.indexOf(needle, searchFrom);
		if (at === -1) {
			return false;
		}
		if (at === 0 || /[-_.\s]/.test(haystack[at - 1])) {
			return true;
		}
		searchFrom = at + 1;
	}
}

// Every character of `needle` appears in `haystack` in order, not
// necessarily contiguously -- handles a typo'd/abbreviated query ("invmar")
// against a real name ("invoice-march.pdf"). Returns 0 if `needle` is not a
// subsequence of `haystack` at all; otherwise a score in [1, 45], always
// below the plain-substring tier (68) so a genuine substring match can never
// be beaten by a looser fuzzy one. The score rewards a TIGHT span (few
// skipped characters between the first and last match) and long consecutive
// runs (rewarding a query that mostly reads as one contiguous chunk).
function subsequenceScore(needle, haystack) {
	if (!needle) {
		return 0;
	}
	let searchFrom = 0;
	let firstMatch = -1;
	let lastMatch = -1;
	let consecutive = 0;
	let bestConsecutive = 0;

	for (let i = 0; i < needle.length; i += 1) {
		const found = haystack.indexOf(needle[i], searchFrom);
		if (found === -1) {
			return 0; // not a subsequence at all
		}
		if (firstMatch === -1) {
			firstMatch = found;
		}
		consecutive = found === searchFrom ? consecutive + 1 : 1;
		bestConsecutive = Math.max(bestConsecutive, consecutive);
		lastMatch = found;
		searchFrom = found + 1;
	}

	const span = lastMatch - firstMatch + 1;
	const tightness = needle.length / span; // 1.0 = perfectly contiguous
	const consecutiveRatio = bestConsecutive / needle.length; // rewards runs
	const raw = (tightness * 0.6 + consecutiveRatio * 0.4) * 45;
	return Math.max(1, Math.round(raw));
}

// Fuzzy name match, 0-100. Deliberately tiered (exact > prefix > word-
// boundary > substring > multi-token > fuzzy-subsequence > no match) so the
// score is easy to reason about and pin down with fixed-input tests, rather
// than a single opaque distance metric.
function computeNameMatchScore(query, name) {
	const needle = normalizeQuery(query);
	if (!needle) {
		// No active free-text query (a filters-only search, e.g. "ext:pdf"
		// alone) -- every candidate is an equally valid text match, so the
		// other signals (recency/frecency/depth/environment) decide order.
		return 50;
	}

	const haystack = typeof name === "string" ? name.toLowerCase() : "";
	if (!haystack) {
		return 0;
	}

	if (haystack === needle) return 100;
	if (haystack.startsWith(needle)) return 90;
	if (isWordBoundaryMatch(haystack, needle)) return 82;
	if (haystack.includes(needle)) return 68;

	// Multi-word query ("march invoice"): every token must appear somewhere
	// in the name, in any order -- handles a query typed in a different
	// order than the tokens appear in the actual filename.
	const tokens = tokenize(needle);
	if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) {
		return 55;
	}

	return subsequenceScore(needle, haystack);
}

// Recency, 0-100: the same half-life-decay shape as ranking.cjs's own
// frecency (`Math.pow(0.5, ageDays / halfLifeDays)`), applied to "how long
// ago was this file last modified" instead of "how long ago was this result
// last executed". A file with no usable mtime scores exactly 0, same
// convention as computeFrecencyScore's "no history" case.
function computeRecencyScore(mtimeMs, options = {}) {
	if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
		return 0;
	}
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const halfLifeDays =
		Number.isFinite(options.halfLifeDays) && options.halfLifeDays > 0
			? options.halfLifeDays
			: DEFAULT_RECENCY_HALF_LIFE_DAYS;
	const ageDays = Math.max(0, (now - mtimeMs) / 86_400_000);
	return 100 * Math.pow(0.5, ageDays / halfLifeDays);
}

// Path depth, 0-100: shallower paths score higher. A weak, deliberately
// low-weighted signal -- "closer to a root" is a mild proxy for "more likely
// to be a deliberately-placed, frequently-used file" rather than something
// buried in a deep build/cache tree, but it should never meaningfully
// outrank an actual name match.
function computeDepthScore(filePath) {
	if (typeof filePath !== "string" || !filePath) {
		return 50;
	}
	const depth = filePath.split(/[\\/]+/u).filter(Boolean).length;
	// A typical "C:\Users\me\Documents\file.txt" is depth 5; the first few
	// levels are free (every indexed file lives under SOME user directory),
	// each level past that costs a flat 8 points, floored at 0.
	return Math.max(0, 100 - Math.max(0, depth - 4) * 8);
}

// Environment association, 0-100: a row already visible to this search (the
// SQL WHERE clause in store.cjs's searchFiles() is what enforces THAT, see
// its own header) gets a boost if it's specifically owned by the CURRENTLY
// active environment, over an equally-visible global (environment_id IS
// NULL) row. This is ordering only -- it can never surface a row that
// wouldn't already be visible, and a row belonging to a genuinely different
// environment never reaches this function at all.
function computeEnvironmentScore(rowEnvironmentId, requestingEnvironmentId) {
	if (requestingEnvironmentId && rowEnvironmentId === requestingEnvironmentId) {
		return 100;
	}
	return 50; // global, unassociated, or no active environment to prefer
}

// How many BM25 RANK POSITIONS (not raw score units, see below) it takes for
// the bm25 contribution to halve. 3 means the very best FTS match scores
// 100, the next-best (by bm25) ~79, then ~63, ~50, ... -- a smooth, gentle
// falloff so bm25 meaningfully favours the top few matches without letting a
// candidate buried deep in the pool collect much credit from it at all.
const BM25_RANK_HALF_LIFE = 3;

// bm25 relevance, 0-100. Deliberately based on each row's RANK POSITION
// among the candidates that have a bm25 value (0 = best match, 1 = next
// best, ...), not FTS5's raw bm25 magnitude -- that magnitude is
// implementation- and corpus-dependent with no fixed point that means
// "perfect match" (empirically measured against this exact
// node-sqlite3-wasm build: real bm25 values for short filenames come back
// as small as ~1e-6, and the GAP between a great match and a mediocre one
// can be smaller than the gap between two near-identical ones -- a
// min-max-normalized-per-batch approach stretches whatever tiny gap exists
// in a SMALL candidate batch to the full 0-100 range regardless of how
// meaningful that gap actually is, which let a barely-there bm25 difference
// swamp a much more meaningful recency signal in exactly this scenario
// during development). Ranking by RELATIVE ORDER rather than absolute
// magnitude sidesteps that scale entirely, and is exactly what `ORDER BY
// rank` already leans on elsewhere in this codebase. Deriving the rank
// internally (sorting by `bm25Rank` ascending -- FTS5's own convention, more
// negative is better) rather than trusting the incoming array's order also
// makes this function robust regardless of whether the caller happened to
// pre-sort it. Rows with no bm25 value at all (a filters-only search with no
// FTS MATCH clause) score a neutral 50; ties in bm25Rank share the same rank
// position.
function computeBm25Scores(rows) {
	const candidateIndices = [];
	for (let i = 0; i < rows.length; i += 1) {
		if (Number.isFinite(rows[i].bm25Rank)) {
			candidateIndices.push(i);
		}
	}
	if (candidateIndices.length === 0) {
		return rows.map(() => 50);
	}

	const sortedIndices = [...candidateIndices].sort((a, b) => rows[a].bm25Rank - rows[b].bm25Rank);
	const rankByIndex = new Map();
	let rank = 0;
	for (let i = 0; i < sortedIndices.length; i += 1) {
		if (i > 0 && rows[sortedIndices[i]].bm25Rank !== rows[sortedIndices[i - 1]].bm25Rank) {
			rank = i;
		}
		rankByIndex.set(sortedIndices[i], rank);
	}

	return rows.map((row, index) => {
		if (!Number.isFinite(row.bm25Rank)) {
			return 50;
		}
		return 100 * Math.pow(0.5, rankByIndex.get(index) / BM25_RANK_HALF_LIFE);
	});
}

function compareStrings(a, b) {
	return String(a ?? "").localeCompare(String(b ?? ""));
}

// The one entry point store.cjs's searchFiles() calls: scores and sorts a
// candidate row list. `rows` are plain objects shaped like the SELECT
// store.cjs issues -- at minimum `{ path, name, mtime, environment_id }`,
// optionally `bm25Rank` (only present when the candidate query went through
// files_fts's MATCH). `frecencyByPath` is a Map (or plain object) of
// path -> { count, lastTs }; a path with no entry is treated as never
// executed, exactly like ranking.cjs's own frecencyByResultId.
//
// Ties (identical finalScore) are broken by matchScore (prefer the row that
// won on text match alone), then name, then path -- so output is fully
// deterministic and never silently depends on SQL row order or a sort's
// stability alone.
function rankFileResults(rows, options = {}) {
	const query = options.query ?? "";
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const environmentId = options.environmentId ?? null;
	const frecencyByPath = options.frecencyByPath ?? null;
	const recencyHalfLifeDays = options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
	const frecencyHalfLifeDays = options.frecencyHalfLifeDays ?? DEFAULT_FRECENCY_HALF_LIFE_DAYS;
	const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };

	const list = Array.isArray(rows) ? rows : [];
	const bm25Scores = computeBm25Scores(list);

	const scored = list.map((row, index) => {
		const matchScore = computeNameMatchScore(query, row.name);
		const bm25Score = bm25Scores[index];
		const recencyScore = computeRecencyScore(row.mtime, { now, halfLifeDays: recencyHalfLifeDays });
		const stats =
			frecencyByPath instanceof Map ? frecencyByPath.get(row.path) : frecencyByPath?.[row.path] ?? null;
		const frecencyScore = computeFrecencyScore(stats, { now, halfLifeDays: frecencyHalfLifeDays });
		const depthScore = computeDepthScore(row.path);
		const environmentScore = computeEnvironmentScore(row.environment_id, environmentId);

		const score =
			matchScore +
			bm25Score * weights.bm25Weight +
			frecencyScore * weights.frecencyWeight +
			recencyScore * weights.recencyWeight +
			depthScore * weights.depthWeight +
			environmentScore * weights.environmentWeight;

		return {
			...row,
			score,
			matchScore,
			bm25Score,
			recencyScore,
			frecencyScore,
			depthScore,
			environmentScore,
		};
	});

	scored.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (b.matchScore !== a.matchScore) {
			return b.matchScore - a.matchScore;
		}
		const nameCompare = compareStrings(a.name, b.name);
		if (nameCompare !== 0) {
			return nameCompare;
		}
		return compareStrings(a.path, b.path);
	});

	return scored;
}

module.exports = {
	computeNameMatchScore,
	computeRecencyScore,
	computeDepthScore,
	computeEnvironmentScore,
	computeBm25Scores,
	rankFileResults,
	DEFAULT_WEIGHTS,
	DEFAULT_RECENCY_HALF_LIFE_DAYS,
	BM25_RANK_HALF_LIFE,
};
