"use strict";

// ---------------------------------------------------------------------------
// The finding lifecycle's STATEFUL half (WP-3.4): every database write that
// moves a `findings` row through accept/ignore/suggest/expire, plus
// acceptFinding()'s own extra step of creating the smart function that
// acceptance produces. Mirrors the split this codebase already established
// for electron/services/context-detection.cjs (pure) / context-service.cjs
// (stateful): all of the actual DECISIONS (is this move even legal, how long
// should this back-off be, has this finding gone stale) live in the pure
// ./finding-lifecycle.cjs; this module is deliberately thin around it,
// reusing electron/services/pattern-miner/store.cjs's existing findings/
// evidence CRUD and electron/services/smart-functions/store.cjs's existing
// rule CRUD rather than inventing either a second findings accessor or a
// second, parallel way to create a rule.
//
// -- Nothing here runs on its own ---------------------------------------------
// Every export is a plain function taking `db` (and, where relevant, a clock
// override) -- there is no factory, no timer, no subscription. Exactly like
// electron/services/pattern-miner/miner.cjs's own runNow() and electron/
// services/smart-functions/engine.cjs's own runManually(), the two bulk
// sweeps below (resurfaceDueFindings/sweepExpiredFindings) only ever run when
// something explicitly calls them (an IPC call today; WP-3.5/3.6's UI,
// tomorrow) -- never on a boot-time interval, so `npm run smoke`/
// `smoke:windows` can never have this module silently accept, ignore, or
// expire anything.
//
// -- Every decision passes through "suggested" first -------------------------
// `ensureSuggested` is the one seam both acceptFinding() and ignoreFinding()
// share: it promotes a "new" finding into "suggested" (stamping
// `suggestedAt`, which is also isFindingExpired()'s reference point -- see
// finding-lifecycle.cjs), and resurfaces an "ignored" finding whose back-off
// has elapsed the same way, but refuses (returns null) for anything else --
// most importantly, for "accepted" or "expired" (both terminal) and for an
// "ignored" finding still inside its suppression window. Both accept and
// ignore call this FIRST and bail out with an `invalid_transition` result if
// it returns null, so "the user must actually have been shown this finding
// before deciding on it" is enforced in exactly one place, not duplicated
// across both call sites.
// ---------------------------------------------------------------------------

const patternMinerStore = require("./store.cjs");
const smartFunctionsStore = require("../smart-functions/store.cjs");
const { canTransition, computeSuppressedUntilIso, isResurfaceDue, isFindingExpired } = require("./finding-lifecycle.cjs");
const { translateFindingToRuleInput } = require("./finding-translator.cjs");
const { normalizeFindingLifecyclePreferences } = require("../../config/finding-lifecycle-prefs.cjs");

const nowIso = (ms) => new Date(ms).toISOString();

// `smart_functions.migrated_from` (migration 011, UNIQUE) is already this
// codebase's idempotency-key convention for "a rule that was produced FROM
// something else, not hand-authored" -- electron/services/smart-functions/
// migrate-scenes.cjs uses `"<layout id>:<placement id>"` for a migrated scene;
// this is the exact same mechanism, keyed by finding id instead.
function migratedFromKeyFor(findingId) {
	return `finding:${findingId}`;
}

function resolveNow(options) {
	return Number.isFinite(options?.now) ? options.now : Date.now();
}

// Shared by acceptFinding/ignoreFinding/markSuggested -- see this file's
// header. Returns the (possibly updated) finding once it is legally in
// "suggested", or `null` when promoting it there is not currently legal.
function ensureSuggested(db, finding, nowMs) {
	if (finding.status === "suggested") {
		return finding;
	}
	if (finding.status === "new" && canTransition("new", "suggested")) {
		return patternMinerStore.updateFindingLifecycle(db, finding.id, {
			status: "suggested",
			suggestedAt: nowIso(nowMs),
		});
	}
	if (finding.status === "ignored" && canTransition("ignored", "suggested") && isResurfaceDue(finding, nowMs)) {
		return patternMinerStore.updateFindingLifecycle(db, finding.id, {
			status: "suggested",
			suggestedAt: nowIso(nowMs),
			suppressedUntil: null,
		});
	}
	return null;
}

// The WP-3.5 UI's "this finding is now actually visible to the user" hook --
// exposed as its own operation (not only an implicit side effect of accept/
// ignore) so a surface that only ever shows a finding, without necessarily
// deciding on it yet, can still record that "suggested" happened and start
// its expiry clock.
function markSuggested(db, findingId, options = {}) {
	const now = resolveNow(options);
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	const updated = ensureSuggested(db, finding, now);
	if (!updated) {
		return {
			ok: false,
			error: `Can't suggest a finding in "${finding.status}" state right now.`,
			reason: "invalid_transition",
		};
	}
	return { ok: true, finding: updated };
}

// Accept: suggested -> accepted, creating a REAL smart function through
// electron/services/smart-functions/store.cjs's own createRule() (never a
// parallel representation -- see finding-translator.cjs), scoped to the
// SAME environment the finding itself belongs to (WP-0.8: a finding is never
// global, so neither is the rule it produces), then purging the finding's
// evidence (electron/services/pattern-miner/store.cjs#purgeFindingEvidence,
// reused verbatim -- this module never deletes from `findings_evidence`
// itself). Rule creation, the finding's status write, and the purge all run
// inside ONE transaction, so a crash between them can never leave "a rule
// exists" and "the finding says accepted" disagreeing, or leave evidence
// purged without a rule actually having been created.
//
// -- Idempotency: two independent defenses -----------------------------------
//   1. The state machine itself: once this finding's status is "accepted",
//      `ensureSuggested` refuses to promote it (accepted has no outgoing
//      edge -- see finding-lifecycle.cjs's TRANSITIONS), so a second call
//      never reaches the createRule step at all.
//   2. Even so, `migratedFrom` (`"finding:<id>"`) is checked against
//      smart_functions' own UNIQUE `migrated_from` column via
//      findByMigratedFrom BEFORE creating anything -- the same lookup
//      migrate-scenes.cjs already relies on for the identical reason. This is
//      pure defense in depth (defense 1 alone already makes a second call
//      here unreachable in practice); it costs one indexed lookup and means
//      this function can never violate that UNIQUE constraint even if
//      defense 1 were ever weakened by a future change.
function acceptFinding(db, findingId, options = {}) {
	const now = resolveNow(options);
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}

	const suggested = ensureSuggested(db, finding, now);
	if (!suggested) {
		return {
			ok: false,
			error: `Finding is "${finding.status}" and can't be accepted right now.`,
			reason: "invalid_transition",
		};
	}
	if (!canTransition("suggested", "accepted")) {
		// Unreachable given this module's own TRANSITIONS table, kept as an
		// explicit guard rather than an assumption -- see evaluate.cjs#decide's
		// own "fail closed on a decision this build doesn't understand" style.
		return { ok: false, error: "Accepting is not a legal transition.", reason: "invalid_transition" };
	}

	const translation = translateFindingToRuleInput(suggested);
	if (!translation) {
		return {
			ok: false,
			error: "This finding's pattern can't be turned into a smart function yet.",
			reason: "unsupported_pattern",
		};
	}

	const migratedFrom = migratedFromKeyFor(suggested.id);
	const existingRule = smartFunctionsStore.findByMigratedFrom(db, migratedFrom);
	if (existingRule) {
		patternMinerStore.updateFindingLifecycle(db, suggested.id, {
			status: "accepted",
			decidedAt: nowIso(now),
			acceptedRuleId: existingRule.id,
		});
		return { ok: true, rule: existingRule, purgedEvidenceCount: 0, alreadyExisted: true };
	}

	let rule = null;
	let purgedEvidenceCount = 0;
	db.transaction(() => {
		rule = smartFunctionsStore.createRule(db, {
			label: translation.label,
			environmentId: suggested.environmentId,
			enabled: true,
			trigger: translation.trigger,
			conditions: [],
			actions: translation.actions,
			source: "user",
			migratedFrom,
		});
		patternMinerStore.updateFindingLifecycle(db, suggested.id, {
			status: "accepted",
			decidedAt: nowIso(now),
			acceptedRuleId: rule.id,
		});
		// THE purge -- see store.cjs's own header for exactly what this does and
		// does not touch (findings_evidence rows only; never `findings` itself,
		// never `events`).
		purgedEvidenceCount = patternMinerStore.purgeFindingEvidence(db, suggested.id);
	});

	return { ok: true, rule, purgedEvidenceCount };
}

// Ignore: suggested -> ignored, stamping an increasing suppression window
// (finding-lifecycle.cjs#computeSuppressedUntilIso) keyed off this finding's
// OWN ignore count so far, so a finding ignored for the third time is
// suppressed longer than one ignored for the first.
function ignoreFinding(db, findingId, options = {}) {
	const now = resolveNow(options);
	const config = normalizeFindingLifecyclePreferences(options.config);
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}

	const suggested = ensureSuggested(db, finding, now);
	if (!suggested) {
		return {
			ok: false,
			error: `Finding is "${finding.status}" and can't be ignored right now.`,
			reason: "invalid_transition",
		};
	}
	if (!canTransition("suggested", "ignored")) {
		return { ok: false, error: "Ignoring is not a legal transition.", reason: "invalid_transition" };
	}

	const ignoreCount = suggested.ignoreCount + 1;
	const suppressedUntil = computeSuppressedUntilIso(ignoreCount, now, config);
	const updated = patternMinerStore.updateFindingLifecycle(db, suggested.id, {
		status: "ignored",
		ignoreCount,
		suppressedUntil,
		decidedAt: nowIso(now),
	});

	return { ok: true, finding: updated, suppressedUntil, ignoreCount };
}

// Bulk sweep #1 -- the resurfacing half of "back off with increasing
// intervals": promotes every currently-"ignored" finding whose suppression
// window has elapsed back to "suggested". The OTHER half (the window actually
// growing each time) is ignoreFinding()'s own job; this is purely "has enough
// time passed", read with the SAME pure isResurfaceDue() ignoreFinding relies
// on indirectly through ensureSuggested.
function resurfaceDueFindings(db, options = {}) {
	const now = resolveNow(options);
	const all = patternMinerStore.listAllFindings(db);
	const resurfacedIds = [];
	db.transaction(() => {
		for (const finding of all) {
			if (finding.status !== "ignored" || !isResurfaceDue(finding, now)) {
				continue;
			}
			const updated = ensureSuggested(db, finding, now);
			if (updated) {
				resurfacedIds.push(updated.id);
			}
		}
	});
	return { resurfacedCount: resurfacedIds.length, findingIds: resurfacedIds };
}

// Bulk sweep #2 -- "findings expire if never acted on": moves every
// non-terminal finding past its expiry window (finding-lifecycle.cjs's
// isFindingExpired(), read against `options.config`) to "expired". Guarded by
// `canTransition` the same as every other write here, so this can never
// expire something already "accepted" (canTransition("accepted", "expired")
// is false) even if a future bug fed it one.
function sweepExpiredFindings(db, options = {}) {
	const now = resolveNow(options);
	const config = normalizeFindingLifecyclePreferences(options.config);
	const all = patternMinerStore.listAllFindings(db);
	const expiredIds = [];
	db.transaction(() => {
		for (const finding of all) {
			if (!canTransition(finding.status, "expired") || !isFindingExpired(finding, now, config)) {
				continue;
			}
			patternMinerStore.updateFindingLifecycle(db, finding.id, { status: "expired", decidedAt: nowIso(now) });
			expiredIds.push(finding.id);
		}
	});
	return { expiredCount: expiredIds.length, findingIds: expiredIds };
}

module.exports = {
	migratedFromKeyFor,
	ensureSuggested,
	markSuggested,
	acceptFinding,
	ignoreFinding,
	resurfaceDueFindings,
	sweepExpiredFindings,
};
