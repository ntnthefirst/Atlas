"use strict";

// ---------------------------------------------------------------------------
// The pattern miner's PURE half (WP-3.3): a function from (event array,
// thresholds) to findings, no I/O -- mirrors the split this codebase already
// established for electron/services/context-detection.cjs, launcher-
// providers/ranking.cjs, and file-index/file-ranking.cjs. This module never
// requires node-sqlite3-wasm, node:worker_threads, or anything Electron;
// electron/services/pattern-miner/mine-worker.cjs (the worker-thread half) is
// the only thing that calls into it from inside a real Worker, and every test
// in algorithm.test.js calls straight into these exports with plain literal
// fixtures -- no worker, no database, no Electron runtime required.
//
// -- The ONE pattern class: sequential co-occurrence ------------------------
// "B follows A within N minutes, at least K times, with confidence above T"
// (the plan's own phrasing). Candidate "A"/"B" values are keyed by
// `(event.type, event.subject)`, not type alone -- PRODUCT-VISION.md's own
// worked example ("you usually open localhost after starting THIS server")
// is a claim about a specific subject, not merely "app.focus events tend to
// follow other app.focus events" -- so `subject` is part of a pattern's
// identity, exactly like it is on the events table itself.
//
// A occurrences and B occurrences are the exact same event stream searched
// twice in opposite roles: for a given (A, B) pair, EVERY occurrence of A is
// a "trial" (did B follow within the window, yes or no), and `confidence` is
// the fraction of trials that were a "yes". This is a MANY-TO-ONE pairing
// deliberately: a single A occurrence counts as at most one trial regardless
// of how many B events happen to fall in its window, because the claim being
// tested ("B tends to follow A") is about how often A is followed AT ALL, not
// about how many B's pile up afterward.
//
// -- Self-pairs are never considered (A === B) -------------------------------
// "task.create followed (eventually) by another task.create" is true for
// almost any frequently-repeated action and carries no automation-relevant
// signal ("you did X, then later did X again" is not a workflow suggestion);
// excluding A === B keeps the candidate space smaller and keeps every
// finding this module CAN produce meaningfully actionable. This is a fixed
// design decision, not a configurable threshold.
//
// -- Why "confidence above T" alone is not the false-positive guard ----------
// If A and B are both simply FREQUENT, a naive confidence/support threshold
// finds "B follows A within N minutes" constantly, purely because a busy
// N-minute window after ANY point in time is likely to contain a B event
// regardless of A. The guard here is a NULL MODEL: treat B, on its own, as an
// independent Poisson process firing at its own overall observed rate
// (`count(B) / totalObservedMinutes` events/minute). Under that model, the
// probability that at least one B falls in a window of `windowMinutes`
// starting at an arbitrary point in time is
//
//     p0 = 1 - exp(-rateB * windowMinutes)                       (*)
//
// (the standard "at least one Poisson arrival in an interval" formula).
// `lift = confidence / p0` is then "how much more often does B actually
// follow A than chance alone, given how frequent B already is, would
// predict" -- a lift near 1.0 means "no better than chance", which is
// rejected regardless of how high the raw confidence number looks.
//
// Lift alone is still not enough: with a small number of trials, a lift far
// above 1.0 can appear by pure sampling noise (the classic multiple-testing
// trap -- test enough (A, B) pairs against random data and SOME will show a
// large lift purely by chance). `pValue` is the second, independent guard:
// the probability, under the SAME null model (B ~ Binomial(n, p0), n =
// trials, p0 from (*)), of seeing `occurrences` successes or MORE purely by
// chance. `mineSequentialPatterns` computes a Bonferroni-corrected
// significance threshold (`significanceLevel / numberOfPairsActuallyTested`)
// so that testing many candidate pairs in one run does not, by itself, raise
// the chance of a false positive -- see this file's own tests (particularly
// the random-event-stream ones) for why this matters in practice, not just
// in theory.
//
// A pair must clear ALL FOUR gates -- occurrences >= K, confidence >= T,
// lift >= minLift, pValue <= correctedAlpha -- to become a finding. Any one
// of them failing is enough to reject it.
//
// -- Trials are censored at the observed data's end, not counted as "no" ----
// An A occurrence whose window would extend past the LAST event timestamp in
// the whole bucket (not just the last B) is excluded from `trials` entirely
// -- there was not enough observed time left to know whether B would have
// followed, so treating it as a negative would bias confidence downward for
// no good reason (see `evaluatePair`'s `windowEnd > observedEndMs` check).
// ---------------------------------------------------------------------------

const KEY_SEP = ""; // ASCII Unit Separator -- vanishingly unlikely to appear in a real event type/subject

function keyOf(type, subject) {
	return `${type}${KEY_SEP}${typeof subject === "string" && subject ? subject : ""}`;
}

function parseKey(key) {
	const idx = key.indexOf(KEY_SEP);
	if (idx === -1) {
		return { type: key, subject: null };
	}
	const type = key.slice(0, idx);
	const subjectPart = key.slice(idx + 1);
	return { type, subject: subjectPart.length > 0 ? subjectPart : null };
}

function compareEventsByTsThenId(a, b) {
	if (a.ts !== b.ts) {
		return a.ts < b.ts ? -1 : 1;
	}
	const aId = Number.isFinite(a.id) ? a.id : 0;
	const bId = Number.isFinite(b.id) ? b.id : 0;
	return aId - bId;
}

function clamp01(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

// ln(C(n, k)), via the standard incremental product-of-ratios form (choosing
// the smaller of k/(n-k) to sum over) -- avoids computing n! or k! directly,
// which would overflow for any n past a few hundred.
function logChoose(n, k) {
	if (k < 0 || k > n) {
		return -Infinity;
	}
	if (k === 0 || k === n) {
		return 0;
	}
	const kk = Math.min(k, n - k);
	let logC = 0;
	for (let i = 1; i <= kk; i += 1) {
		logC += Math.log(n - kk + i) - Math.log(i);
	}
	return logC;
}

// Abramowitz & Stegun 7.1.26 -- a standard, well-bounded (max error ~1.5e-7)
// rational approximation to the error function, used below for the normal-
// approximation tail (large-n path) with no external dependency.
function erf(x) {
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const t = 1 / (1 + p * ax);
	const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
	const y = 1 - poly * Math.exp(-ax * ax);
	return sign * y;
}

function normalSurvival(z) {
	// P(Z >= z) for a standard normal Z.
	return clamp01(0.5 * (1 - erf(z / Math.SQRT2)));
}

// Above this many trials, computing the exact binomial tail term-by-term
// (O(n - k) log/exp calls) stops being worth its own cost -- the normal
// approximation (with a continuity correction) is accurate to several
// significant figures once n is in the thousands, and O(1) regardless of n.
// This is a performance bound, not a correctness cliff: both branches answer
// the exact same question (P(X >= k) for X ~ Binomial(n, p)).
const EXACT_BINOMIAL_MAX_N = 2000;

// P(X >= k) for X ~ Binomial(n, p). Exact (log-space, numerically stable) for
// n <= EXACT_BINOMIAL_MAX_N; a continuity-corrected normal approximation
// above that. Never throws; degenerate p (<=0 or >=1) is handled explicitly
// rather than falling into log(0)/log(negative).
function binomialSurvival(n, k, p) {
	if (k <= 0) {
		return 1;
	}
	if (k > n) {
		return 0;
	}
	if (p <= 0) {
		return 0;
	}
	if (p >= 1) {
		return 1;
	}

	if (n > EXACT_BINOMIAL_MAX_N) {
		const mean = n * p;
		const sd = Math.sqrt(n * p * (1 - p));
		if (sd <= 0) {
			return k <= mean ? 1 : 0;
		}
		const z = (k - 0.5 - mean) / sd; // -0.5: continuity correction for P(X >= k)
		return normalSurvival(z);
	}

	const logP = Math.log(p);
	const logQ = Math.log(1 - p);

	// logTerm(j) = ln(C(n, j)) + j*ln(p) + (n-j)*ln(1-p) -- the log-pmf at j.
	// Computed once at j = k, then updated incrementally for j = k+1..n via
	// logTerm(j+1) = logTerm(j) + ln(n-j) - ln(j+1) + ln(p) - ln(1-p), which is
	// exact and avoids recomputing logChoose from scratch for every term.
	let logTerm = logChoose(n, k) + k * logP + (n - k) * logQ;
	const logTerms = [logTerm];
	let maxLog = logTerm;
	for (let j = k; j < n; j += 1) {
		logTerm = logTerm + Math.log(n - j) - Math.log(j + 1) + logP - logQ;
		logTerms.push(logTerm);
		if (logTerm > maxLog) {
			maxLog = logTerm;
		}
	}

	// Every individual pmf term is a real probability (<= 1), so maxLog <= 0
	// and exp(maxLog) can never overflow -- log-sum-exp purely for the
	// precision of summing many small numbers, not to avoid a range error.
	let sum = 0;
	for (const lt of logTerms) {
		sum += Math.exp(lt - maxLog);
	}
	return clamp01(Math.exp(maxLog) * sum);
}

// Thresholds share exactly one schema/default/clamping definition --
// electron/config/pattern-miner-prefs.cjs, the same file the miner's
// disk-persisted preferences (and, later, a Settings UI) read and write.
// Reusing it here (rather than a second, hand-maintained copy of the
// defaults) is what makes it impossible for this module's idea of "the
// default window is 30 minutes" to drift from what a user actually sees/
// edits -- that config module is pure (no Electron, no filesystem access
// beyond what its OWN caller does), so requiring it from here does not
// compromise this module's no-I/O contract.
const { defaultPatternMinerPreferences, normalizePatternMinerPreferences } = require("../../config/pattern-miner-prefs.cjs");

const DEFAULTS = defaultPatternMinerPreferences();

function normalizeThresholds(thresholds) {
	return normalizePatternMinerPreferences(thresholds);
}

// Evaluates exactly one ordered (A, B) candidate pair. `aTs`/`bTs` are sorted
// ascending epoch-ms arrays; `aIds`/`bIds` are the corresponding event ids
// (same index alignment) -- kept as parallel arrays rather than arrays of
// objects, purely to keep the hot two-pointer loop below allocation-free.
// `observedEndMs` is the LAST timestamp across the ENTIRE bucket (every key,
// not just A or B) -- see this file's header on censoring.
function evaluatePair({ aTs, aIds, bTs, bIds, windowMs, observedEndMs, opts, correctedAlpha }) {
	let n = 0;
	let k = 0;
	const evidence = [];
	let j = 0; // two-pointer into bTs -- never rewinds, since aTs is ascending

	for (let i = 0; i < aTs.length; i += 1) {
		const aTime = aTs[i];
		const windowEnd = aTime + windowMs;
		if (windowEnd > observedEndMs) {
			// Censored -- see header. Excluded from n, not counted as a miss.
			continue;
		}
		n += 1;

		while (j < bTs.length && bTs[j] <= aTime) {
			j += 1;
		}
		if (j < bTs.length && bTs[j] <= windowEnd) {
			k += 1;
			evidence.push({ triggerEventId: aIds[i], followEventId: bIds[j] });
		}
	}

	if (n === 0 || k < opts.minOccurrences) {
		return null;
	}

	const confidence = k / n;
	if (confidence < opts.minConfidence) {
		return null;
	}

	// `observedEndMs` is already a relative duration (lastMs - firstMs, see
	// mineSequentialPatterns), so it doubles as "total observed span in ms"
	// with no further rebasing needed.
	const observedSpanMinutes = observedEndMs > 0 ? observedEndMs / 60000 : 0;
	const rateB = observedSpanMinutes > 0 ? bTs.length / observedSpanMinutes : 0;
	const meanExpected = rateB * (windowMs / 60000);
	const p0 = clamp01(1 - Math.exp(-meanExpected));
	if (p0 <= 0) {
		return null;
	}

	const lift = confidence / p0;
	if (lift < opts.minLift) {
		return null;
	}

	const pValue = binomialSurvival(n, k, p0);
	if (pValue > correctedAlpha) {
		return null;
	}

	return { n, k, confidence, p0, lift, pValue, evidence };
}

// The one entry point: mines EXACTLY ONE bucket's events (already isolated to
// a single environment by the caller -- see mine-worker.cjs's header) for
// sequential co-occurrence findings. `events` is `Array<{ id, ts, type,
// subject, environmentId }>` (ts an ISO-8601 string, same shape
// electron/services/event-log.cjs's parseEventRow produces). Never mutates
// its input.
function mineSequentialPatterns(events, thresholds) {
	const opts = normalizeThresholds(thresholds);

	if (!Array.isArray(events) || events.length < opts.minBucketEvents) {
		return [];
	}

	const valid = events.filter(
		(e) => e && typeof e.type === "string" && e.type && typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)),
	);
	if (valid.length < opts.minBucketEvents) {
		return [];
	}

	const sorted = [...valid].sort(compareEventsByTsThenId);
	const firstMs = Date.parse(sorted[0].ts);
	const lastMs = Date.parse(sorted[sorted.length - 1].ts);
	const totalSpanMinutes = (lastMs - firstMs) / 60000;
	if (!(totalSpanMinutes > 0)) {
		// Degenerate: every event landed on the exact same instant -- no
		// meaningful rate can be computed for the null model.
		return [];
	}

	const byKey = new Map();
	for (const event of sorted) {
		const key = keyOf(event.type, event.subject);
		let entry = byKey.get(key);
		if (!entry) {
			entry = { tsMs: [], ids: [] };
			byKey.set(key, entry);
		}
		entry.tsMs.push(Date.parse(event.ts));
		entry.ids.push(Number.isFinite(event.id) ? event.id : null);
	}

	// A key must appear at least minOccurrences times to have ANY chance of
	// satisfying "at least K times" as either side of a pair (occurrences of a
	// pair can never exceed either side's own total count) -- a necessary,
	// cheap pre-filter, never a sufficient one.
	let candidates = [...byKey.entries()].filter(([, v]) => v.tsMs.length >= opts.minOccurrences);
	candidates.sort((a, b) => b[1].tsMs.length - a[1].tsMs.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	if (candidates.length > opts.maxCandidateKeys) {
		candidates = candidates.slice(0, opts.maxCandidateKeys);
	}

	if (candidates.length < 2) {
		return [];
	}

	const windowMs = opts.windowMinutes * 60000;
	// Every ordered pair with keyA !== keyB will actually be evaluated below --
	// this is the exact denominator the Bonferroni correction needs (see this
	// file's header), computed BEFORE the loop so every pair in this run is
	// judged against the SAME corrected threshold, not one that shrinks as the
	// loop progresses.
	const numPairsTested = candidates.length * (candidates.length - 1);
	const correctedAlpha = opts.significanceLevel / numPairsTested;

	// Timestamps are rebased to "ms since firstMs" ONCE per candidate here
	// (not per pair below) -- both for performance (candidates.length pairs
	// share each side's rebased array many times over) and so evaluatePair's
	// own null-model rate computation can treat `observedEndMs` as the whole
	// bucket's span with no further arithmetic.
	const observedEndMs = lastMs - firstMs;
	const rebased = candidates.map(([key, v]) => [key, { tsMs: v.tsMs.map((ms) => ms - firstMs), ids: v.ids }]);

	const findings = [];
	for (const [keyA, a] of rebased) {
		for (const [keyB, b] of rebased) {
			if (keyA === keyB) {
				continue;
			}
			const result = evaluatePair({
				aTs: a.tsMs,
				aIds: a.ids,
				bTs: b.tsMs,
				bIds: b.ids,
				windowMs,
				observedEndMs,
				opts,
				correctedAlpha,
			});
			if (!result) {
				continue;
			}
			const aKey = parseKey(keyA);
			const bKey = parseKey(keyB);
			findings.push({
				patternType: "sequential_co_occurrence",
				trigger: aKey,
				follow: bKey,
				windowMinutes: opts.windowMinutes,
				occurrences: result.k,
				trials: result.n,
				confidence: result.confidence,
				baselineProbability: result.p0,
				lift: result.lift,
				pValue: result.pValue,
				evidence: result.evidence,
			});
		}
	}

	return findings;
}

// Mines every bucket INDEPENDENTLY -- `buckets` is `Array<{ environmentId:
// string|null, events: EventRecord[] }>`. This is the ONE function that
// decides how many buckets get mined together, and it never lets one
// bucket's events influence another's candidate counts, rates, or findings:
// each bucket gets its own, fresh call to mineSequentialPatterns, and the
// only thing that crosses from one iteration to the next is which
// `environmentId` a finding gets tagged with afterward. This is the
// structural guarantee behind "enclosed environments are mined in complete
// isolation" -- not a filter applied after the fact, but the shape of the
// loop itself: there is no code path here that could combine two buckets'
// timestamps into one candidate's counts, because each bucket's Map (built
// fresh inside mineSequentialPatterns) never survives past that one call.
function mineBuckets(buckets, thresholds) {
	const results = [];
	for (const bucket of Array.isArray(buckets) ? buckets : []) {
		if (!bucket || typeof bucket !== "object") {
			continue;
		}
		const environmentId = bucket.environmentId ?? null;
		const findings = mineSequentialPatterns(bucket.events, thresholds);
		for (const finding of findings) {
			results.push({ ...finding, environmentId });
		}
	}
	return results;
}

module.exports = {
	keyOf,
	parseKey,
	logChoose,
	erf,
	normalSurvival,
	binomialSurvival,
	normalizeThresholds,
	evaluatePair,
	mineSequentialPatterns,
	mineBuckets,
	DEFAULTS,
	EXACT_BINOMIAL_MAX_N,
};
