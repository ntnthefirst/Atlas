"use strict";

// ---------------------------------------------------------------------------
// Pure ranking (WP-2.2): blends match quality with frecency. No I/O, no
// Electron, no db handle -- every input arrives already computed (the query
// text and a plain frecency-stats lookup), which is what makes this
// deterministic and unit-testable with fixed inputs. index.cjs (the registry)
// is the only production caller: it gathers raw results from every provider,
// loads frecency stats with ONE indexed query (see
// electron/services/event-log.cjs#countEventsBySubject), and hands both to
// rankResults() below. Nothing here reaches into a database itself.
//
// Two scores are computed per result and blended additively:
//   - matchScore   (0-100) -- plain text match quality against the query,
//     computed the SAME way for every provider's results, so ranking is
//     genuinely unified across kinds (a task result and a file result are
//     scored on one scale, never two incomparable provider-invented ones).
//   - frecencyScore (0-100) -- frequency of past `launcher.execute` events
//     for this exact result id, decayed by how long ago the most recent one
//     was. A result with no execution history scores exactly 0 here, so it
//     never outranks anything on frecency alone.
//
// finalScore = matchScore + frecencyScore * frecencyWeight, so a result with
// a much better text match still wins outright (frecency can only ever add
// up to `frecencyWeight * 100` points), while two otherwise-tied results are
// resolved decisively by which one the user actually keeps picking.
// ---------------------------------------------------------------------------

// Executions old enough sit at half their frequency weight every this many
// days -- long enough that a result used constantly last week still edges
// out one never chosen, short enough that a result nobody has touched in
// months stops getting a free ride.
const DEFAULT_FRECENCY_HALF_LIFE_DAYS = 7;

// How much a maxed-out frecency score (100) can add on top of matchScore.
// Additive, not a weighted average, so a result with NO history is scored
// exactly by match quality alone -- frecency only ever adds, never subtracts.
const DEFAULT_FRECENCY_WEIGHT = 0.5;

// Execution count at which the frequency component alone saturates at 100
// (before recency decay is applied) -- five executions is already "a result
// this user clearly reaches for", and uncapped growth would let a single
// hyperactive result dominate every query forever.
const FREQUENCY_SATURATION_COUNT = 5;

function normalizeQuery(query) {
	return typeof query === "string" ? query.trim().toLowerCase() : "";
}

// Match quality, 0-100, from plain title/subtitle text against the query.
// Deliberately provider-agnostic: every provider's results are scored by
// this SAME function (title/subtitle only), so results from different
// providers are directly comparable instead of each provider inventing its
// own incomparable scale.
function computeMatchScore(query, result) {
	const needle = normalizeQuery(query);
	if (!needle) {
		// No active query (the launcher's default/browse list) -- every result
		// is an equally valid suggestion text-wise, so frecency alone decides
		// order among them.
		return 50;
	}

	const title = typeof result?.title === "string" ? result.title.toLowerCase() : "";
	const subtitle = typeof result?.subtitle === "string" ? result.subtitle.toLowerCase() : "";

	if (title === needle) return 100;
	if (title.startsWith(needle)) return 80;
	if (title.includes(needle)) return 60;
	if (subtitle.includes(needle)) return 40;
	return 0;
}

// Frequency + recency of past executions, from only the aggregate a single
// indexed query already computed (`{ count, lastTs }`) -- never a per-event
// decay loop over raw rows. Returns 0 for `stats` that is missing/empty,
// exactly as if the result had never been executed.
function computeFrecencyScore(stats, options = {}) {
	if (!stats || !Number.isFinite(stats.count) || stats.count <= 0) {
		return 0;
	}

	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const halfLifeDays =
		Number.isFinite(options.halfLifeDays) && options.halfLifeDays > 0
			? options.halfLifeDays
			: DEFAULT_FRECENCY_HALF_LIFE_DAYS;

	const lastTsMs = typeof stats.lastTs === "string" ? Date.parse(stats.lastTs) : Number(stats.lastTs);
	const ageDays = Number.isFinite(lastTsMs) ? Math.max(0, (now - lastTsMs) / 86_400_000) : 0;
	const recencyWeight = Math.pow(0.5, ageDays / halfLifeDays);

	const frequencyComponent = Math.min(100, (stats.count / FREQUENCY_SATURATION_COUNT) * 100);
	return frequencyComponent * recencyWeight;
}

function lookupStats(frecencyByResultId, resultId) {
	if (!frecencyByResultId) {
		return null;
	}
	if (frecencyByResultId instanceof Map) {
		return frecencyByResultId.get(resultId) ?? null;
	}
	return frecencyByResultId[resultId] ?? null;
}

// The one entry point the registry calls: scores and sorts a merged result
// list. `frecencyByResultId` is a Map (or plain object) of resultId -> {
// count, lastTs }; a result with no entry is treated as never executed.
//
// Ties (identical finalScore -- most commonly two results that both scored 0
// on both axes, or two with no query and no history at all) are broken
// alphabetically by title, so output is fully deterministic and never
// silently depends on provider iteration order or a sort's stability alone.
function rankResults(results, options = {}) {
	const query = options.query ?? "";
	const frecencyByResultId = options.frecencyByResultId ?? null;
	const frecencyWeight = Number.isFinite(options.frecencyWeight) ? options.frecencyWeight : DEFAULT_FRECENCY_WEIGHT;
	const now = options.now;
	const halfLifeDays = options.halfLifeDays;

	const scored = (Array.isArray(results) ? results : []).map((result) => {
		const matchScore = computeMatchScore(query, result);
		const stats = lookupStats(frecencyByResultId, result.id);
		const frecencyScore = computeFrecencyScore(stats, { now, halfLifeDays });
		const score = matchScore + frecencyScore * frecencyWeight;
		return { ...result, score, matchScore, frecencyScore };
	});

	scored.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return String(a.title).localeCompare(String(b.title));
	});

	return scored;
}

module.exports = {
	computeMatchScore,
	computeFrecencyScore,
	rankResults,
	DEFAULT_FRECENCY_HALF_LIFE_DAYS,
	DEFAULT_FRECENCY_WEIGHT,
	FREQUENCY_SATURATION_COUNT,
};
