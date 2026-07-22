"use strict";

// ---------------------------------------------------------------------------
// Finding lifecycle thresholds (WP-3.4) -- the two knobs the product vision's
// "back off with increasing intervals" and "findings expire if never acted
// on" acceptance criteria are actually tuned by. Pure -- no Electron, no
// filesystem access -- mirroring electron/config/pattern-miner-prefs.cjs's own
// split exactly: THIS module owns the shape/defaults/normalization, exercised
// under plain vitest; a later caller (electron/services/pattern-miner/
// finding-lifecycle-service.cjs) is the only place that actually loads/saves
// it from disk.
//
// -- Shape -------------------------------------------------------------------
// {
//   baseBackoffHours:    the FIRST ignore's suppression window, in hours --
//                        see finding-lifecycle.cjs#computeBackoffMs, which
//                        multiplies this by backoffMultiplier^(ignoreCount-1)
//                        for every ignore after the first.
//   backoffMultiplier:   how much longer each SUCCESSIVE ignore's suppression
//                        window gets than the one before it. 1.0 would mean
//                        "never increases" (a flat back-off), which defeats
//                        the plan's own "increasing intervals" requirement,
//                        so this is clamped to be genuinely > 1.
//   maxBackoffDays:      a hard ceiling on the suppression window, in days,
//                        regardless of how many times a finding has been
//                        ignored -- without this, a handful of ignores on a
//                        long-lived finding would compute a back-off of years,
//                        which is functionally the same as deleting it, and
//                        that decision belongs to WP-3.6's explicit "delete",
//                        never to an ever-compounding formula.
//   expiryDays:          how long a finding may sit un-acted-on (in "new" or
//                        "suggested", counting from whichever it most
//                        recently entered) before finding-lifecycle.cjs's
//                        isFindingExpired() considers it stale and
//                        finding-lifecycle-service.cjs#sweepExpiredFindings
//                        moves it to "expired".
// }
//
// Every threshold here is a genuine product decision (exactly like pattern-
// miner-prefs.cjs's own thresholds), so the same discipline applies:
// malformed/missing input never throws, it falls back to a documented
// default.
// ---------------------------------------------------------------------------

const { clampNumber, clampFloat } = require("./prefs-utils.cjs");

const FINDING_LIFECYCLE_PREFS_FILE = "finding-lifecycle-prefs.json";

const DEFAULT_BASE_BACKOFF_HOURS = 24;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_DAYS = 30;
const DEFAULT_EXPIRY_DAYS = 14;

const MIN_BASE_BACKOFF_HOURS = 1;
const MAX_BASE_BACKOFF_HOURS = 24 * 7;
const MIN_BACKOFF_MULTIPLIER = 1.01; // must be > 1: see header on "genuinely increasing"
const MAX_BACKOFF_MULTIPLIER = 10;
const MIN_MAX_BACKOFF_DAYS = 1;
const MAX_MAX_BACKOFF_DAYS = 180;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 365;

function defaultFindingLifecyclePreferences() {
	return {
		baseBackoffHours: DEFAULT_BASE_BACKOFF_HOURS,
		backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
		maxBackoffDays: DEFAULT_MAX_BACKOFF_DAYS,
		expiryDays: DEFAULT_EXPIRY_DAYS,
	};
}

// Never throws, never returns a value outside its documented bounds -- exactly
// like normalizePatternMinerPreferences(): a malformed/missing field is
// dropped back to its default rather than crashing a lifecycle operation over
// a corrupted prefs file.
function normalizeFindingLifecyclePreferences(raw) {
	const base = defaultFindingLifecyclePreferences();
	if (!raw || typeof raw !== "object") {
		return base;
	}
	return {
		baseBackoffHours: clampNumber(raw.baseBackoffHours, base.baseBackoffHours, MIN_BASE_BACKOFF_HOURS, MAX_BASE_BACKOFF_HOURS),
		backoffMultiplier: clampFloat(
			raw.backoffMultiplier,
			base.backoffMultiplier,
			MIN_BACKOFF_MULTIPLIER,
			MAX_BACKOFF_MULTIPLIER,
		),
		maxBackoffDays: clampNumber(raw.maxBackoffDays, base.maxBackoffDays, MIN_MAX_BACKOFF_DAYS, MAX_MAX_BACKOFF_DAYS),
		expiryDays: clampNumber(raw.expiryDays, base.expiryDays, MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS),
	};
}

module.exports = {
	FINDING_LIFECYCLE_PREFS_FILE,
	DEFAULT_BASE_BACKOFF_HOURS,
	DEFAULT_BACKOFF_MULTIPLIER,
	DEFAULT_MAX_BACKOFF_DAYS,
	DEFAULT_EXPIRY_DAYS,
	defaultFindingLifecyclePreferences,
	normalizeFindingLifecyclePreferences,
};
