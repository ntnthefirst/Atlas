"use strict";

// ---------------------------------------------------------------------------
// The finding lifecycle's PURE half (WP-3.4, extended by WP-3.6): the state
// machine a `findings` row moves through, and the two schedules ("back off
// with increasing intervals" / "expire if never acted on") that decide WHEN
// it moves. No db, no clock of its own, no Electron -- mirrors the split this
// codebase already established for electron/services/context-detection.cjs,
// smart-functions/evaluate.cjs, and pattern-miner/algorithm.cjs: every clock
// reading (`nowMs`) is passed in, so a hysteresis/scheduling rule you would
// otherwise only be able to exercise by waiting hours or days in real time is
// instead a rule you can test with a literal number.
// electron/services/pattern-miner/finding-lifecycle-service.cjs (the stateful
// half) is the only caller that actually touches a database or a rule table.
//
// -- The six states, and exactly which moves between them are legal --------
//
//   new -------> suggested -------> accepted   (terminal: a smart function
//                     |                          now exists; see
//                     |                          finding-lifecycle-service.cjs
//                     |                          #acceptFinding)
//                     +----------> ignored ---> suggested   (resurfaces once
//                     |               ^             its back-off elapses --
//                     |               |             see isResurfaceDue below)
//                     |               +-------> expired
//                     +----------> expired      (terminal)
//    new ---------------------------------------> expired   (terminal: never
//                                                  even suggested before it
//                                                  went stale)
//
//   new/suggested/ignored ------> paused ------> suggested   (WP-3.6: "stop
//                                                  suggesting this, but don't
//                                                  reject it and don't lose
//                                                  it" -- see pauseFinding/
//                                                  unpauseFinding in
//                                                  finding-lifecycle-
//                                                  service.cjs. Indefinite:
//                                                  paused has no outgoing edge
//                                                  to `expired`, and
//                                                  isFindingExpired() below
//                                                  never fires while paused --
//                                                  only an explicit unpause
//                                                  ever moves it on, never a
//                                                  timer.)
//
// `accepted` and `expired` have NO outgoing edges -- both are permanent by
// design. In particular this is what makes "a finding that is already
// accepted must not be re-accepted into a second duplicate smart function"
// (this WP's own acceptance criterion) true at the STATE-MACHINE level, not
// merely as an accident of how the service module happens to be written:
// `canTransition("accepted", "accepted")` is false, full stop, so
// acceptFinding() has no legal path to run its create-a-rule step twice for
// the same finding no matter how it's called.
//
// `ignored` can only ever reach `accepted` by first passing back through
// `suggested` (there is no `ignored -> accepted` edge) -- every decision, on
// either branch of the plan's own "accept/ignore" step, is made from the
// SAME state, so both routes are provably symmetric rather than the accept
// path and the ignore path each growing their own bespoke pre-conditions.
// `paused` reaches a decision the identical way -- it can only become
// `accepted`/`ignored` by first passing back through `suggested` too (there
// is no `paused -> accepted` or `paused -> ignored` edge), which is also
// exactly why a paused finding's accept/ignore just works with no separate
// "unpause first" step: finding-lifecycle-service.cjs's ensureSuggested()
// already promotes `paused` straight to `suggested`, unconditionally (no
// back-off check, unlike the `ignored` branch), the same seam accept/ignore/
// markSuggested/unpauseFinding all share.
//
// `paused` has no edge from `accepted`/`expired` (both terminal, nothing left
// to pause) and no edge to `expired` (see this file's own isFindingExpired()
// below -- pausing is a deliberate hold, the deliberate opposite of "never
// acted on").
// ---------------------------------------------------------------------------

const STATES = Object.freeze(["new", "suggested", "accepted", "ignored", "expired", "paused"]);

const TRANSITIONS = Object.freeze({
	new: Object.freeze(["suggested", "expired", "paused"]),
	suggested: Object.freeze(["accepted", "ignored", "expired", "paused"]),
	ignored: Object.freeze(["suggested", "expired", "paused"]),
	paused: Object.freeze(["suggested"]),
	accepted: Object.freeze([]),
	expired: Object.freeze([]),
});

// The one place "is this move legal" is decided -- every write in
// finding-lifecycle-service.cjs checks this before touching a row, and every
// illegal-transition test in this package's suite asserts against this
// function directly (or indirectly, through a service call that consults it).
function canTransition(from, to) {
	const allowed = TRANSITIONS[from];
	return Array.isArray(allowed) && allowed.includes(to);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// "Ignoring the same thing repeatedly should suppress it for progressively
// longer" (this WP's own brief) -- geometric growth from `baseBackoffHours`,
// multiplied by `backoffMultiplier` for every ignore beyond the first, capped
// at `maxBackoffDays` so a long enough ignore history can never compute a
// suppression window of, effectively, forever (see finding-lifecycle-
// prefs.cjs's own header on why that ceiling exists at all). `ignoreCount` is
// the count AFTER the ignore currently being recorded (i.e. the first ever
// ignore passes 1, not 0), so the first ignore's window is exactly
// `baseBackoffHours` -- not zero, not already-multiplied.
function computeBackoffMs(ignoreCount, config) {
	const count = Number.isFinite(ignoreCount) && ignoreCount > 0 ? Math.floor(ignoreCount) : 1;
	const baseMs = config.baseBackoffHours * HOUR_MS;
	const capMs = config.maxBackoffDays * DAY_MS;
	const raw = baseMs * Math.pow(config.backoffMultiplier, count - 1);
	return Math.min(raw, capMs);
}

// The wall-clock instant an ignore recorded "right now" (`nowMs`) suppresses
// a finding until, as an ISO string (the same format every other timestamp
// column in this schema uses).
function computeSuppressedUntilIso(ignoreCount, nowMs, config) {
	return new Date(nowMs + computeBackoffMs(ignoreCount, config)).toISOString();
}

// Whether an "ignored" finding's back-off window has elapsed and it may
// resurface (transition back to "suggested"). A finding with no
// `suppressedUntil` at all (a defensive case that should never happen once
// ignoreFinding() always sets one, but costs nothing to handle) is treated as
// immediately due, rather than stuck ignored forever over a missing field.
function isResurfaceDue(finding, nowMs) {
	if (!finding || finding.status !== "ignored") {
		return false;
	}
	if (!finding.suppressedUntil) {
		return true;
	}
	const untilMs = Date.parse(finding.suppressedUntil);
	return !Number.isFinite(untilMs) || nowMs >= untilMs;
}

// "Findings expire if never acted on" (this WP's own acceptance criterion) --
// true once more than `config.expiryDays` has elapsed since `finding` most
// recently entered "suggested" (`suggestedAt`), or since it was created if it
// never has been ((`createdAt`) -- a finding stuck in "new" forever, e.g.
// because nothing ever calls markSuggested() on it, must still eventually go
// stale, not survive indefinitely by virtue of never having been looked at).
// Never true for a finding already in a terminal state -- expiring an
// "accepted" finding would be nonsensical (its smart function is the durable
// record now), and an already-"expired" finding has nothing left to do.
// Also never true while "paused" (WP-3.6): pausing is a deliberate, explicit
// hold -- the opposite of "never acted on" -- so it stays exempt for as long
// as it takes, with no timer of its own; only an explicit unpauseFinding()
// call ever moves it on (see finding-lifecycle-service.cjs).
function isFindingExpired(finding, nowMs, config) {
	if (!finding || finding.status === "accepted" || finding.status === "expired" || finding.status === "paused") {
		return false;
	}
	const referenceIso = finding.suggestedAt || finding.createdAt;
	const referenceMs = Date.parse(referenceIso);
	if (!Number.isFinite(referenceMs)) {
		return false;
	}
	return nowMs - referenceMs >= config.expiryDays * DAY_MS;
}

// WP-3.6 "move between environments" -- which lifecycle states a finding may
// be relocated FROM. Excludes both terminal states for the same reason they
// have no outgoing TRANSITIONS edge at all:
//   - `accepted`: already permanently tied to the smart function it produced
//     IN ITS ORIGINAL environment (finding-lifecycle-service.cjs#acceptFinding
//     scopes the rule to `suggested.environmentId` at the moment of
//     acceptance, and acceptFinding's own tests pin that scoping down) --
//     relocating the finding afterward would desync "what environment this
//     finding says it's in" from "what environment the rule it already
//     produced is actually scoped to", a real invariant this codebase relies
//     on, not merely stylistic.
//   - `expired`: nothing left to do with it; moving it would serve no
//     purpose the state machine's own terminal-state philosophy hasn't
//     already ruled out for every other operation.
// `new`/`suggested`/`ignored`/`paused` are all still "live" decisions in
// progress, and moving the finding to a different (permitted -- see
// electron/data/isolation.cjs#isFindingMoveAllowed) environment before that
// decision is made is exactly what this operation is for.
const MOVABLE_STATUSES = Object.freeze(["new", "suggested", "ignored", "paused"]);

function canMoveFinding(finding) {
	return Boolean(finding) && MOVABLE_STATUSES.includes(finding.status);
}

module.exports = {
	STATES,
	TRANSITIONS,
	MOVABLE_STATUSES,
	canTransition,
	canMoveFinding,
	computeBackoffMs,
	computeSuppressedUntilIso,
	isResurfaceDue,
	isFindingExpired,
};
