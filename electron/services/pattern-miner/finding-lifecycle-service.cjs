"use strict";

// ---------------------------------------------------------------------------
// The finding lifecycle's STATEFUL half (WP-3.4, completed by WP-3.6): every
// database write that moves a `findings` row through accept/ignore/suggest/
// expire/pause, plus acceptFinding()'s own extra step of creating the smart
// function that acceptance produces, plus WP-3.6's remaining management
// operations (delete, move between environments, edit the label). Mirrors the
// split this codebase already established
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
// across both call sites. WP-3.6's `paused` goes through the very same seam
// (see ensureSuggested's own paused branch), which is why a paused finding's
// accept/ignore needs no separate "unpause it first" step at any call site.
//
// -- WP-3.6: where the isolation decision is made, and by whom ---------------
// moveFinding() reads BOTH environments' `isolation_mode` out of the database
// itself and hands them to electron/data/isolation.cjs#isFindingMoveAllowed.
// It deliberately does NOT accept the modes as arguments: a mode passed down
// from a caller is a mode a renderer could get wrong (or forge), and an
// isolation boundary that can be talked out of holding is not a boundary.
// This is the same reason electron/data/scoped.cjs reads
// `environments.isolation_mode` directly rather than trusting a caller, and
// it is the ONLY read this module makes outside the findings tables.
// ---------------------------------------------------------------------------

const patternMinerStore = require("./store.cjs");
const smartFunctionsStore = require("../smart-functions/store.cjs");
const { isFindingMoveAllowed } = require("../../data/isolation.cjs");
const {
	canTransition,
	canMoveFinding,
	computeSuppressedUntilIso,
	isResurfaceDue,
	isFindingExpired,
} = require("./finding-lifecycle.cjs");
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
	// WP-3.6's `paused`, promoted UNCONDITIONALLY -- unlike the `ignored`
	// branch above there is no back-off to wait out, because a pause is not a
	// rejection: the user explicitly asked to hold this finding, so the moment
	// they explicitly ask for it back there is nothing left to check.
	//
	// `suggestedAt` is deliberately RE-stamped rather than preserved. It is
	// isFindingExpired()'s reference point (finding-lifecycle.cjs), and a
	// finding is exempt from expiry for the whole time it is paused -- so
	// carrying the pre-pause timestamp forward would mean a finding paused for
	// longer than the expiry window expires the instant it comes back, which is
	// the exact opposite of what pausing was asked to do. The clock restarts.
	if (finding.status === "paused" && canTransition("paused", "suggested")) {
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
//
// -- WP-3.6: "accept" and "convert" are one write path, two answers ----------
// The vision lists accept and convert as separate operations, and they are --
// but the difference is one flag, not one more code path, because both mean
// "this pattern becomes a real smart function" and duplicating that would give
// this codebase two ways to create the same rule that could drift apart.
// `options.enabled` is the whole difference:
//   - accept  (enabled: true, the default) -- the rule starts live and fires
//     from the next matching trigger onward. The one-click answer.
//   - convert (enabled: false, see convertFinding below) -- the rule is
//     created DISABLED, so the user can open it in the Smart Function editor,
//     read exactly what Atlas inferred, adjust it, and turn it on themselves.
// Both land the finding in the same terminal `accepted` state and both record
// the same `acceptedRuleId`, so nothing downstream has to know which one the
// user picked.
function acceptFinding(db, findingId, options = {}) {
	const now = resolveNow(options);
	// Explicit `!== false` rather than `?? true`: only a deliberate `false`
	// (convertFinding's own call below) creates a disabled rule; a caller that
	// omits the option, or passes something else entirely, gets the safe,
	// documented default.
	const enabled = options.enabled !== false;
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
			// WP-3.6: if the user renamed this finding (migration 014's `label`,
			// the one hand-editable field on the row), the rule it produces
			// inherits that name rather than reverting to the auto-generated
			// description -- renaming a thing and then watching the rename get
			// thrown away on accept is not a rename. A finding never edited has a
			// null label and falls straight back to finding-translator.cjs's own.
			label: suggested.label || translation.label,
			environmentId: suggested.environmentId,
			enabled,
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

// WP-3.6's "convert": accept, but the resulting smart function starts
// DISABLED so the user can read and adjust it before it ever fires. See
// acceptFinding's own header for why this is one flag rather than a second
// write path. The returned `rule` is what the caller uses to open the Smart
// Function editor on the thing it just created.
function convertFinding(db, findingId, options = {}) {
	return acceptFinding(db, findingId, { ...options, enabled: false });
}

// WP-3.6's "pause": stop suggesting this, but don't reject it and don't lose
// it. Distinct from ignore in all three ways that matter:
//   - it does NOT increment `ignoreCount`, so it never lengthens the back-off
//     the user would face if they later decide to actually ignore it (pausing
//     something is not evidence against it, and WP-3.7's feedback loop reads
//     that same count);
//   - it has no timer at all -- `isFindingExpired` is false for the whole
//     time it is paused (finding-lifecycle.cjs), so a paused finding waits
//     exactly as long as the user leaves it, and never quietly expires;
//   - it is reversible by exactly one explicit call (unpauseFinding), never
//     by a sweep.
// `suppressedUntil` is cleared: a back-off window only means anything for a
// finding that is going to resurface on its own, and a paused one is
// definitionally not. `ignoreCount` is left intact -- that is the durable
// record clearing the window must not erase. `decidedAt` is also left alone,
// because pausing is the deliberate act of NOT deciding yet.
function pauseFinding(db, findingId) {
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	if (finding.status === "paused") {
		return { ok: true, finding, alreadyPaused: true };
	}
	if (!canTransition(finding.status, "paused")) {
		return {
			ok: false,
			error: `A "${finding.status}" finding can't be paused.`,
			reason: "invalid_transition",
		};
	}
	const updated = patternMinerStore.updateFindingLifecycle(db, finding.id, {
		status: "paused",
		suppressedUntil: null,
	});
	return { ok: true, finding: updated };
}

// The mirror image: back to "suggested" through the same ensureSuggested seam
// accept/ignore/markSuggested all share, so an unpaused finding is in exactly
// the state a freshly suggested one is -- no half-way "unpaused but not yet
// suggestable" state exists for anything downstream to have to handle.
function unpauseFinding(db, findingId, options = {}) {
	const now = resolveNow(options);
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	if (finding.status !== "paused") {
		return {
			ok: false,
			error: `Finding is "${finding.status}", not paused.`,
			reason: "invalid_transition",
		};
	}
	const updated = ensureSuggested(db, finding, now);
	if (!updated) {
		// Unreachable while TRANSITIONS keeps the paused -> suggested edge, kept
		// explicit for the same reason acceptFinding's canTransition guard is.
		return { ok: false, error: "Unpausing is not a legal transition.", reason: "invalid_transition" };
	}
	return { ok: true, finding: updated };
}

// WP-3.6's "edit" -- the label and nothing else. See migration 014's header
// for why a finding's statistics are not editable and never will be: they are
// mined facts, and a control surface that let you rewrite them would be a
// surface for falsifying the evidence the rest of this engine exists to
// present honestly. Allowed in every state, terminal ones included: renaming
// an accepted or expired finding changes nothing about what it says happened.
function setFindingLabel(db, findingId, label) {
	const updated = patternMinerStore.updateFindingLabel(db, findingId, label);
	if (!updated) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	return { ok: true, finding: updated };
}

// WP-3.6's "delete" -- the finding AND its evidence, gone (store.cjs#
// deleteFinding, one transaction). Deliberately allowed from ANY state,
// including the terminal ones: "delete" is the user disposing of a row Atlas
// generated about their own behaviour, and there is no lifecycle argument for
// telling someone they may not throw away a suggestion. Accepting first and
// then deleting leaves the smart function that acceptance created untouched --
// the rule is a real, hand-editable object of its own by then, and deleting
// the finding it came from is not a request to delete it.
function deleteFinding(db, findingId) {
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	const deleted = patternMinerStore.deleteFinding(db, findingId);
	return { ok: deleted, deleted, acceptedRuleId: finding.acceptedRuleId ?? null };
}

// WP-3.6's "move between environments" -- the operation with the isolation
// question in it, and the one place that answers it.
//
// -- Why the evidence is purged on EVERY move, not only a risky one ----------
// A finding is a summary; its evidence (`findings_evidence`) is a list of raw
// `events.id`s belonging to the SOURCE environment. Moving the finding without
// the evidence is fine -- the row keeps every statistic it was mined with, and
// store.cjs's own header already establishes that a finding stays fully
// meaningful after a purge. Moving it WITH the evidence would mean environment
// B's findings list can drill down into environment A's raw event rows, which
// is precisely the cross-environment read electron/data/scoped.cjs exists to
// make impossible.
//
// isFindingMoveAllowed already refuses any move involving an enclosed
// environment on either side, so a leak of the kind enclosure specifically
// forbids cannot happen at all. The purge is the answer to the weaker but
// real question the remaining, permitted connected-to-connected moves still
// pose: those are allowed to share *aggregates*, never each other's raw rows.
// Purging unconditionally also means there is exactly one rule to reason
// about -- "a moved finding has no evidence" -- rather than a per-mode matrix
// where whether the drill-down still works depends on settings the user may
// have changed since. finding-evidence.cjs reports the resulting empty state
// as "no_evidence", which the UI words honestly.
//
// The purge and the environment write share ONE transaction, so a crash can
// never leave the finding pointing at its new environment while still holding
// the old one's event ids -- the exact interleaving that would turn a
// crash into a leak.
function moveFinding(db, findingId, environmentId) {
	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found" };
	}
	if (typeof environmentId !== "string" || !environmentId) {
		return { ok: false, error: "No destination environment given.", reason: "invalid_environment" };
	}
	if (environmentId === finding.environmentId) {
		// A no-op move must not purge anything -- the user asked for nothing to
		// change, and silently destroying the drill-down would be a real loss for
		// a mis-click.
		return { ok: true, finding, moved: false, purgedEvidenceCount: 0 };
	}
	if (!canMoveFinding(finding)) {
		return {
			ok: false,
			error: `A "${finding.status}" finding can't be moved to another environment.`,
			reason: "invalid_transition",
		};
	}

	const destination = db.first("SELECT id, isolation_mode FROM environments WHERE id = ?", [environmentId]);
	if (!destination) {
		return { ok: false, error: "That environment doesn't exist.", reason: "invalid_environment" };
	}
	// A missing source row (its environment was deleted out from under this
	// finding) leaves `sourceMode` undefined, which isFindingMoveAllowed rejects
	// as an invalid mode -- failing closed, not open, exactly like every other
	// isolation decision in electron/data/isolation.cjs.
	const source = db.first("SELECT id, isolation_mode FROM environments WHERE id = ?", [finding.environmentId]);
	if (!isFindingMoveAllowed({ sourceMode: source?.isolation_mode, destinationMode: destination.isolation_mode })) {
		return {
			ok: false,
			error: "An enclosed environment's findings stay where they are, in both directions.",
			reason: "isolation_blocked",
		};
	}

	let purgedEvidenceCount = 0;
	let updated = null;
	db.transaction(() => {
		purgedEvidenceCount = patternMinerStore.purgeFindingEvidence(db, findingId);
		updated = patternMinerStore.moveFindingEnvironment(db, findingId, environmentId);
	});
	return { ok: true, finding: updated, moved: true, purgedEvidenceCount };
}

module.exports = {
	migratedFromKeyFor,
	ensureSuggested,
	markSuggested,
	acceptFinding,
	convertFinding,
	ignoreFinding,
	pauseFinding,
	unpauseFinding,
	setFindingLabel,
	deleteFinding,
	moveFinding,
	resurfaceDueFindings,
	sweepExpiredFindings,
};
