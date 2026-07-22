"use strict";

// ---------------------------------------------------------------------------
// Suggestion candidate selection (WP-3.5) -- the PURE half of "which finding,
// if any, should the Notch show right now". No db, no Electron -- a function
// of (every known finding, the active environment, now, the finding-lifecycle
// config) to a single finding or null. Composes electron/services/pattern-
// miner/finding-lifecycle.cjs's own isResurfaceDue/isFindingExpired and
// electron/services/pattern-miner/finding-translator.cjs's own
// translateFindingToRuleInput verbatim -- this module invents no new
// eligibility rule of its own beyond "which of the already-defined legal
// states is 'about to be shown'" and "pick one, deterministically".
//
// -- Why a finding must already be translatable to be surfaced --------------
// "One-click accept" (this WP's own acceptance criterion) only works if
// accepting the finding the user is looking at can actually succeed.
// finding-lifecycle-service.cjs#acceptFinding already refuses (with
// `reason: "unsupported_pattern"`) a finding translateFindingToRuleInput()
// returns null for -- rather than ever showing a suggestion whose own accept
// button is silently doomed to fail, this module filters those out before
// they are ever chosen.
//
// -- Why expiry is checked here too ------------------------------------------
// Nothing in this app calls finding-lifecycle-service.cjs#sweepExpiredFindings
// automatically (see that module's own header -- it is explicit-invocation
// only, exactly like the miner's own runNow()). A "new" finding can therefore
// sit un-swept past its own expiry window for a while in practice; this
// module re-checks isFindingExpired() directly rather than trusting a sweep
// that may not have run yet, so a stale finding is never surfaced just
// because nothing had gotten around to marking it "expired" yet.
//
// -- Why the pick is deterministic, not "highest confidence" ----------------
// Among several eligible findings, the OLDEST (by `createdAt`, ties broken by
// `id`) is chosen -- simplest possible rule, and one that guarantees a
// finding can never be starved indefinitely by newer ones repeatedly jumping
// the queue. Ranking findings by "how good a suggestion is this" is
// deliberately left to a later WP (the feedback loop, WP-3.7) rather than
// invented here.
// ---------------------------------------------------------------------------

const { isResurfaceDue, isFindingExpired } = require("../pattern-miner/finding-lifecycle.cjs");
const { translateFindingToRuleInput } = require("../pattern-miner/finding-translator.cjs");

// Whether `finding` is in a state where showing it in the Notch right now is
// legal: either it has never been shown ("new"), or it was shown once,
// ignored, and its back-off has since elapsed ("ignored" + isResurfaceDue).
// Anything else ("suggested" -- already showing; "accepted"/"expired" --
// terminal) is never surfaceable again.
function isSurfaceable(finding, now, lifecycleConfig) {
	if (!finding) {
		return false;
	}
	if (isFindingExpired(finding, now, lifecycleConfig)) {
		return false;
	}
	if (finding.status === "new") {
		return true;
	}
	if (finding.status === "ignored") {
		return isResurfaceDue(finding, now);
	}
	return false;
}

// `findings`: the plain array electron/services/pattern-miner/store.cjs's
// listAllFindings() returns (every environment, every status). Scoped to
// `environmentId` HERE (not by the caller pre-filtering) so this function's
// own tests can exercise the scoping rule directly. Returns `null` when
// nothing in that environment is currently eligible.
function selectFindingToSurface(findings, environmentId, now, lifecycleConfig) {
	if (!environmentId) {
		return null;
	}

	const candidates = (Array.isArray(findings) ? findings : [])
		.filter((finding) => finding && finding.environmentId === environmentId)
		.filter((finding) => isSurfaceable(finding, now, lifecycleConfig))
		.filter((finding) => translateFindingToRuleInput(finding) !== null);

	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((a, b) => {
		const at = Date.parse(a.createdAt) || 0;
		const bt = Date.parse(b.createdAt) || 0;
		if (at !== bt) {
			return at - bt;
		}
		return String(a.id).localeCompare(String(b.id));
	});

	return candidates[0];
}

module.exports = { isSurfaceable, selectFindingToSurface };
