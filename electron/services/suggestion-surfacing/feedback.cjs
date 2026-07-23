"use strict";

// ---------------------------------------------------------------------------
// The feedback loop's PURE half (WP-3.7): "the system gets less annoying over
// time, not more". Turns the outcome events WP-3.5 and WP-3.6 already record
// (`suggestion.shown` / `suggestion.accepted` / `suggestion.dismissed`, each
// carrying nothing but a pattern type and an environment id) into a per-
// category verdict: keep offering this, or stop.
//
// No db, no clock of its own, no Electron -- the same split
// electron/services/suggestion-surfacing/rate-limit.cjs and selection.cjs
// already follow, and for the same reason: a rule about what happens after
// three rejections spread over weeks has to be exercisable in a millisecond.
//
// -- A category is (environment, pattern type), and never anything wider ----
// The plan asks for tracking "per pattern type and per environment", and the
// pair is also the only key that is safe. A verdict computed across
// environments would be an aggregate of one environment's behaviour applied
// to another -- exactly the cross-environment signal flow
// electron/data/isolation.cjs exists to prevent, and it would silently
// include enclosed environments, which contribute to no aggregate anywhere.
// So: dismissing a category ten times in "Personal" changes nothing about
// what "Work" is offered. summarizeFeedback() filters to one environment and
// refuses to run unscoped; a test pins that down.
//
// -- Consecutive rejections, not a lifetime tally ---------------------------
// The counter that matters is how many times the user has dismissed a
// category SINCE THE LAST TIME THEY ACCEPTED ONE. A lifetime ratio would mean
// a category accepted once, long ago, could never be suppressed no matter how
// many times it was since rejected; a raw lifetime count would mean a
// category the user actively uses gets suppressed anyway once enough
// dismissals accumulate over the years. "Consecutive" is the reading that
// matches what the user is actually saying: an accept is them saying this is
// useful, and everything before it stops being evidence against.
//
// -- Suppression does not expire on its own ---------------------------------
// Once suppressed, a category stays suppressed until the user either resets
// it (WP-3.7's own "inspectable and resettable" criterion, implemented as a
// per-category timestamp watermark in electron/config/suggestion-feedback.cjs
// -- never by deleting the events themselves, which are the user's own
// activity record) or accepts a suggestion in it again. A timer that quietly
// un-suppressed a category would mean "I have told you three times to stop"
// eventually stops meaning anything, which is the annoyance this WP exists to
// remove.
// ---------------------------------------------------------------------------

const SHOWN = "suggestion.shown";
const ACCEPTED = "suggestion.accepted";
const DISMISSED = "suggestion.dismissed";

const FEEDBACK_EVENT_TYPES = Object.freeze([SHOWN, ACCEPTED, DISMISSED]);

const DEFAULT_SUPPRESS_AFTER_DISMISSALS = 3;

/** The one place the (environment, pattern type) key is spelled. */
function categoryKey(environmentId, patternType) {
	return `${environmentId}::${patternType}`;
}

function resolveThreshold(config) {
	const parsed = Number(config?.suppressAfterDismissals);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_SUPPRESS_AFTER_DISMISSALS;
}

function eventTimestampMs(event) {
	const parsed = Date.parse(event?.ts);
	return Number.isFinite(parsed) ? parsed : null;
}

// `resets[key]` is an ISO timestamp: everything at or before it is treated as
// never having happened, which is what "reset this category" means without
// destroying a single row of the user's activity log.
function resetMsFor(resets, key) {
	const parsed = Date.parse(resets?.[key]);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every category the given environment has any feedback for, with the counts
 * behind each verdict -- this IS the "inspectable" half of the acceptance
 * criteria, so nothing here is a bare boolean the user would have to take on
 * trust.
 *
 * `events` is the raw list from electron/services/event-log.cjs (already
 * scoped to one environment by the caller's query; re-filtered here anyway,
 * because a function that decides an isolation-relevant question should not
 * depend on the caller having got the query right).
 */
function summarizeFeedback(events, environmentId, options = {}) {
	if (!environmentId) {
		// Deliberately empty rather than "every environment" -- mirrors
		// countEventsBySubject's own refusal to aggregate unscoped.
		return [];
	}
	const threshold = resolveThreshold(options.config);
	const resets = options.resets ?? {};

	const byCategory = new Map();

	const relevant = (Array.isArray(events) ? events : [])
		.filter((event) => event && event.environmentId === environmentId)
		.filter((event) => FEEDBACK_EVENT_TYPES.includes(event.type))
		.filter((event) => typeof event.payload?.patternType === "string" && event.payload.patternType)
		.map((event) => ({ ...event, tsMs: eventTimestampMs(event) }))
		.filter((event) => event.tsMs !== null)
		// The event log already returns ascending order, but the whole
		// "consecutive since the last accept" rule depends on it, so it is
		// established here rather than assumed.
		.sort((a, b) => a.tsMs - b.tsMs);

	for (const event of relevant) {
		const patternType = event.payload.patternType;
		const key = categoryKey(environmentId, patternType);
		const resetMs = resetMsFor(resets, key);
		if (resetMs !== null && event.tsMs <= resetMs) {
			continue;
		}

		let entry = byCategory.get(key);
		if (!entry) {
			entry = {
				environmentId,
				patternType,
				shown: 0,
				accepted: 0,
				dismissed: 0,
				consecutiveDismissals: 0,
				lastAcceptedAt: null,
				lastDismissedAt: null,
				resetAt: resetMs === null ? null : new Date(resetMs).toISOString(),
			};
			byCategory.set(key, entry);
		}

		if (event.type === SHOWN) {
			entry.shown += 1;
		} else if (event.type === ACCEPTED) {
			entry.accepted += 1;
			entry.lastAcceptedAt = event.ts;
			// The reset that matters most: accepting one says the category is
			// useful, so every dismissal before it stops counting against it.
			entry.consecutiveDismissals = 0;
		} else {
			entry.dismissed += 1;
			entry.lastDismissedAt = event.ts;
			entry.consecutiveDismissals += 1;
		}
	}

	return [...byCategory.values()]
		.map((entry) => ({
			...entry,
			threshold,
			suppressed: entry.consecutiveDismissals >= threshold,
		}))
		.sort((a, b) => a.patternType.localeCompare(b.patternType));
}

/**
 * The set of pattern types currently suppressed in one environment -- what
 * suggestion-manager.cjs filters candidates against. A Set rather than a list
 * because the caller only ever asks "is this one in it".
 */
function suppressedPatternTypes(events, environmentId, options = {}) {
	return new Set(
		summarizeFeedback(events, environmentId, options)
			.filter((entry) => entry.suppressed)
			.map((entry) => entry.patternType),
	);
}

module.exports = {
	FEEDBACK_EVENT_TYPES,
	DEFAULT_SUPPRESS_AFTER_DISMISSALS,
	categoryKey,
	summarizeFeedback,
	suppressedPatternTypes,
};
