"use strict";

// ---------------------------------------------------------------------------
// WP-3.6's evidence drill-down: "the user can see the evidence behind a
// finding -- which events produced it." store.cjs#getFindingEvidence already
// returns `{ triggerEventId, followEventId }` PAIRS -- bare `events.id`
// numbers, exactly what is durable enough to survive a purge/re-mine but
// meaningless on its own. This module is the one place that resolves those
// ids back to the real `events` rows (type, subject, timestamp) the user
// actually recognizes, composing electron/services/pattern-miner/store.cjs
// (the pair lookup) with electron/services/event-log.cjs#listEventsByIds
// (the row lookup) -- never a raw SQL join written a second time somewhere
// else, and never a change to what either of those modules owns.
//
// -- Three distinct "there is nothing to show" cases, not one -------------
// WP-3.4's acceptFinding() deliberately purges a finding's evidence the
// moment it's accepted (see store.cjs's own header: "the purge... is a
// stated product promise, not an optimisation") -- an accepted finding
// therefore LEGITIMATELY has no evidence to show, which is a normal state
// with a clear explanation, not an error or an empty crash. This module tells
// that apart from two other, different "empty" cases so the UI can word each
// one honestly:
//   - "not_found": there is no such finding at all.
//   - "purged_on_accept": the finding IS accepted, and its evidence was
//     removed on purpose, exactly as designed.
//   - "no_evidence": the finding is NOT accepted, yet has no evidence rows
//     either (e.g. a malformed mining entry that upsertFindings skipped
//     inserting evidence for) -- worth surfacing distinctly from the
//     accepted case, since it may point at a real gap rather than an
//     intentional purge.
// A finding WITH evidence rows resolves every pair it can, and a since-pruned
// individual event (event-log.cjs's own 90-day retention, or an environment
// deletion that flushed the log) resolves to `null` for that one side rather
// than dropping the whole pair or throwing.
// ---------------------------------------------------------------------------

const patternMinerStore = require("./store.cjs");
const { listEventsByIds } = require("../event-log.cjs");

function resolveFindingEvidence(db, findingId) {
	if (!db || !findingId) {
		return { ok: false, error: "Finding not found.", reason: "not_found", pairs: [] };
	}

	const finding = patternMinerStore.getFinding(db, findingId);
	if (!finding) {
		return { ok: false, error: "Finding not found.", reason: "not_found", pairs: [] };
	}

	const pairs = patternMinerStore.getFindingEvidence(db, findingId);
	if (pairs.length === 0) {
		return {
			ok: true,
			pairs: [],
			reason: finding.status === "accepted" ? "purged_on_accept" : "no_evidence",
		};
	}

	const ids = [...new Set(pairs.flatMap((pair) => [pair.triggerEventId, pair.followEventId]))];
	const rows = listEventsByIds(db, ids);
	const byId = new Map(rows.map((row) => [row.id, row]));

	const resolved = pairs.map((pair) => ({
		triggerEvent: byId.get(pair.triggerEventId) ?? null,
		followEvent: byId.get(pair.followEventId) ?? null,
	}));

	return { ok: true, pairs: resolved, reason: null };
}

module.exports = { resolveFindingEvidence };
