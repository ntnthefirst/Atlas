"use strict";

// ---------------------------------------------------------------------------
// Pattern miner thresholds (WP-3.3) -- every knob that decides whether a
// candidate "B follows A" pair becomes a finding. Pure -- no Electron, no
// filesystem access -- mirroring electron/config/file-index-prefs.cjs's own
// split: THIS module owns the shape/defaults/normalization, and is exercised
// under plain vitest; electron/services/pattern-miner/miner.cjs is the only
// place that actually loads/saves it from disk (Electron- and fs-only).
//
// -- Shape -------------------------------------------------------------------
// {
//   windowMinutes:      how soon after A must B occur to count as "following"
//                        it at all (electron/services/event-log.cjs's own
//                        listEventsFollowing() default is 30 -- reused here
//                        as this module's default too, not a coincidence).
//   minOccurrences:      "at least K times" -- the plan's own phrasing. A
//                        floor on the RAW count of A-occurrences B actually
//                        followed, independent of confidence/lift -- a pair
//                        that only ever happened twice is never a pattern,
//                        no matter how "confident" or "surprising" those two
//                        occurrences look statistically.
//   minConfidence:       P(B follows A within windowMinutes | A happened),
//                        i.e. occurrences / trials. The plan's own "with
//                        confidence above T".
//   minLift:             see electron/services/pattern-miner/mine-worker.cjs's
//                        header for the full statistical argument -- in
//                        short, confidence ALONE cannot tell "B follows A
//                        because they're related" from "B follows A because
//                        B is simply frequent". minLift is the ratio of the
//                        observed confidence to what a null model (B as an
//                        independent Poisson process at its own overall
//                        rate) would predict by chance; a lift of 1.0 means
//                        "exactly what chance alone predicts", so minLift
//                        must be well above 1 for a pair to mean anything.
//   significanceLevel:   the p-value ceiling (Bonferroni-corrected across
//                        every pair actually tested in one mining run --
//                        see mine-worker.cjs) a pair's observed count must
//                        clear against the SAME null model above, so a
//                        lucky short streak in a small sample can't pass
//                        just because its lift ratio happens to look big.
//   maxCandidateKeys:    a hard cap on how many distinct (event type,
//                        subject) keys are even considered as a candidate
//                        A or B per environment per run -- see
//                        mine-worker.cjs's header for why this is a
//                        deliberate, generous performance bound, not a
//                        product-facing "top N" feature.
//   minBucketEvents:     below this many events in one environment's bucket,
//                        there isn't enough data to compute a meaningful
//                        rate/significance test at all -- skip the bucket
//                        entirely rather than manufacture a "finding" from a
//                        handful of events.
// }
//
// Every threshold here is genuinely a product decision this WP was asked to
// leave tunable ("Make thresholds configurable in dev builds -- you will
// spend real time tuning them"), so normalizeFileIndexPreferences's own
// discipline is mirrored exactly: malformed/missing input never throws, it
// falls back to a documented default.
// ---------------------------------------------------------------------------

const { clampNumber, clampFloat } = require("./prefs-utils.cjs");

const PATTERN_MINER_PREFS_FILE = "pattern-miner-prefs.json";

// Matches electron/services/event-log.cjs's listEventsFollowing() default --
// see the header above.
const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_MIN_OCCURRENCES = 5;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_LIFT = 3.0;
const DEFAULT_SIGNIFICANCE_LEVEL = 0.01;
const DEFAULT_MAX_CANDIDATE_KEYS = 40;
const DEFAULT_MIN_BUCKET_EVENTS = 30;

const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 24 * 60;
const MIN_MIN_OCCURRENCES = 2;
const MAX_MIN_OCCURRENCES = 1000;
const MIN_MIN_CONFIDENCE = 0.05;
const MAX_MIN_CONFIDENCE = 1;
const MIN_MIN_LIFT = 1;
const MAX_MIN_LIFT = 100;
const MIN_SIGNIFICANCE_LEVEL = 0.0001;
const MAX_SIGNIFICANCE_LEVEL = 0.2;
const MIN_MAX_CANDIDATE_KEYS = 5;
const MAX_MAX_CANDIDATE_KEYS = 200;
const MIN_MIN_BUCKET_EVENTS = 2;
const MAX_MIN_BUCKET_EVENTS = 100_000;

function defaultPatternMinerPreferences() {
	return {
		windowMinutes: DEFAULT_WINDOW_MINUTES,
		minOccurrences: DEFAULT_MIN_OCCURRENCES,
		minConfidence: DEFAULT_MIN_CONFIDENCE,
		minLift: DEFAULT_MIN_LIFT,
		significanceLevel: DEFAULT_SIGNIFICANCE_LEVEL,
		maxCandidateKeys: DEFAULT_MAX_CANDIDATE_KEYS,
		minBucketEvents: DEFAULT_MIN_BUCKET_EVENTS,
	};
}

// Never throws, never returns a value outside its documented bounds -- exactly
// like normalizeFileIndexPreferences(): a malformed/missing field is dropped
// back to its default rather than crashing a mining run over a corrupted
// prefs file.
function normalizePatternMinerPreferences(raw) {
	const base = defaultPatternMinerPreferences();
	if (!raw || typeof raw !== "object") {
		return base;
	}
	return {
		windowMinutes: clampNumber(raw.windowMinutes, base.windowMinutes, MIN_WINDOW_MINUTES, MAX_WINDOW_MINUTES),
		minOccurrences: clampNumber(
			raw.minOccurrences,
			base.minOccurrences,
			MIN_MIN_OCCURRENCES,
			MAX_MIN_OCCURRENCES,
		),
		minConfidence: clampFloat(raw.minConfidence, base.minConfidence, MIN_MIN_CONFIDENCE, MAX_MIN_CONFIDENCE),
		minLift: clampFloat(raw.minLift, base.minLift, MIN_MIN_LIFT, MAX_MIN_LIFT),
		significanceLevel: clampFloat(
			raw.significanceLevel,
			base.significanceLevel,
			MIN_SIGNIFICANCE_LEVEL,
			MAX_SIGNIFICANCE_LEVEL,
		),
		maxCandidateKeys: clampNumber(
			raw.maxCandidateKeys,
			base.maxCandidateKeys,
			MIN_MAX_CANDIDATE_KEYS,
			MAX_MAX_CANDIDATE_KEYS,
		),
		minBucketEvents: clampNumber(
			raw.minBucketEvents,
			base.minBucketEvents,
			MIN_MIN_BUCKET_EVENTS,
			MAX_MIN_BUCKET_EVENTS,
		),
	};
}

module.exports = {
	PATTERN_MINER_PREFS_FILE,
	DEFAULT_WINDOW_MINUTES,
	DEFAULT_MIN_OCCURRENCES,
	DEFAULT_MIN_CONFIDENCE,
	DEFAULT_MIN_LIFT,
	DEFAULT_SIGNIFICANCE_LEVEL,
	DEFAULT_MAX_CANDIDATE_KEYS,
	DEFAULT_MIN_BUCKET_EVENTS,
	defaultPatternMinerPreferences,
	normalizePatternMinerPreferences,
};
