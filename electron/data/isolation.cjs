// ---------------------------------------------------------------------------
// The isolation policy (WP-0.8) — what the two environment modes permit, and
// the one decision function that says whether a specific cross-environment
// read is allowed. This module owns the *policy*; electron/data/scoped.cjs
// owns the *plumbing* (the actual queries), and calls into this module
// rather than re-deciding the question itself. Keeping the two separate is
// what makes the policy something a test can pin down exactly, instead of a
// judgment call re-made ad hoc at every call site.
//
// PRODUCT-VISION.md ("Environment Intelligence") and D3/D9/D10 in
// IMPLEMENTATION-PLAN.md are the source of truth this module encodes:
//
//   Connected — the environment has its own context, but can learn from
//   general user behaviour: derived, non-sensitive signals aggregated across
//   every *other* connected environment. Never raw content from another
//   environment (never its task titles, note bodies, file paths, or event
//   subjects) — only statistics computed from them.
//
//   Enclosed — total isolation, in both directions. An enclosed
//   environment's data never contributes to any other environment's
//   aggregates, and an enclosed environment never receives any signal
//   derived from anywhere else either. It sees nothing global, and nothing
//   global sees it.
//
// There are exactly two modes. Do not add a third, and do not make the
// allowlist below configurable at runtime — per the WP's own gotcha note,
// ambiguity in an isolation model is indistinguishable from a bug, and users
// cannot verify a promise that was never stated precisely. Widening what's
// on the allowlist is a deliberate, reviewable code change (and the test for
// it will fail until you update it on purpose); it is never a runtime
// setting.
// ---------------------------------------------------------------------------

"use strict";

const ISOLATION_MODES = Object.freeze({
	CONNECTED: "connected",
	ENCLOSED: "enclosed",
});

// Mirrors the CHECK constraint added in migration 004 — kept as an explicit
// list (not just "the values of ISOLATION_MODES") so the set of valid modes
// is one place a reader can see without also reading the enum's intent.
const VALID_ISOLATION_MODES = Object.freeze([ISOLATION_MODES.CONNECTED, ISOLATION_MODES.ENCLOSED]);

// D3: every environment that existed before this migration must land here
// with no behaviour change. `connected` is defined, below, to permit exactly
// what the app already does today (its own data, plus the one pre-existing
// cross-environment aggregate — dashboard:overview's per-environment time
// breakdown) — so defaulting every existing row to it is a genuine no-op.
const DEFAULT_ISOLATION_MODE = ISOLATION_MODES.CONNECTED;

function isValidIsolationMode(mode) {
	return VALID_ISOLATION_MODES.includes(mode);
}

// The named, derived signals a CONNECTED environment may read across an
// environment boundary. This is the actual allowlist — a real constant a
// test asserts the exact contents of, not a comment describing an intention.
//
// Every entry here is:
//   - an aggregate/derived statistic computed FROM other environments' rows,
//     never a copy of the rows themselves;
//   - already something the product computes today (this package does not
//     invent new cross-environment features, it puts a gate in front of the
//     one that already exists);
//   - safe to hand to any connected environment because it carries no task
//     title, note body, file path, event subject, or anything else a user
//     would recognize as "their content" — only a number attached to an
//     environment's own name or an app's own name.
//
// ENVIRONMENT_TIME_TOTALS — the "time spent today" breakdown across
// environments that already powers the dashboard's per-environment bar
// (electron/db.cjs#getDashboardOverview). It is exactly the kind of
// aggregate behavioural signal the vision doc's "Connected Mode" example
// describes (frecency/behaviour-pattern style, not content), scoped down
// further by electron/data/scoped.cjs so no enclosed environment's total is
// ever included in it, in either direction.
//
// Nothing else is on this list. In particular: no task, note, session, or
// event ROW ever crosses an environment boundary through this mechanism —
// only the two aggregate fields above.
const CROSS_ENVIRONMENT_SIGNALS = Object.freeze({
	ENVIRONMENT_TIME_TOTALS: "environment_time_totals",
});

const CROSS_ENVIRONMENT_ALLOWLIST = Object.freeze([CROSS_ENVIRONMENT_SIGNALS.ENVIRONMENT_TIME_TOTALS]);

function isAllowlistedSignal(signal) {
	return CROSS_ENVIRONMENT_ALLOWLIST.includes(signal);
}

// The single decision point: may a read of `signal`, computed across
// environments, be handed to an environment in `requesterMode`, when one of
// the environments it's derived from is in `targetMode`?
//
// Fails closed on anything it doesn't recognize — an unknown mode or an
// unlisted signal is treated as "not permitted", not "permitted by default".
// That is deliberate: a bug that produces an unrecognized mode string, or a
// call site that forgets to name its signal, must never fail open into a
// leak.
function isCrossEnvironmentReadAllowed({ requesterMode, targetMode, signal } = {}) {
	if (!isValidIsolationMode(requesterMode) || !isValidIsolationMode(targetMode)) {
		return false;
	}
	if (!isAllowlistedSignal(signal)) {
		return false;
	}
	// The vision's promise runs both ways: an enclosed environment neither
	// contributes to nor benefits from shared signals. It sees nothing global.
	if (requesterMode === ISOLATION_MODES.ENCLOSED) {
		return false;
	}
	// An enclosed environment's data never contributes to another
	// environment's aggregate, no matter who is asking.
	if (targetMode === ISOLATION_MODES.ENCLOSED) {
		return false;
	}
	return true;
}

module.exports = {
	ISOLATION_MODES,
	VALID_ISOLATION_MODES,
	DEFAULT_ISOLATION_MODE,
	isValidIsolationMode,
	CROSS_ENVIRONMENT_SIGNALS,
	CROSS_ENVIRONMENT_ALLOWLIST,
	isAllowlistedSignal,
	isCrossEnvironmentReadAllowed,
};
