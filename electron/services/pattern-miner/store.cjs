"use strict";

// ---------------------------------------------------------------------------
// The pattern miner's store (WP-3.3) -- every write and read against
// `findings`/`findings_evidence` (electron/migrations/012_pattern_miner.cjs)
// lives here, the same "only this module touches these tables" discipline
// electron/services/file-index/store.cjs and electron/services/smart-
// functions/store.cjs already follow. electron/services/pattern-miner/
// miner.cjs (the main-thread orchestrator) is this module's only caller;
// mine-worker.cjs (the worker thread) never requires this file at all -- it
// has no database connection to use it with.
//
// -- Upsert by pattern identity, not by finding id ---------------------------
// Re-running the miner will, correctly, re-derive the SAME real pattern every
// time it is still true (that is the whole point of "keep mining" in the
// product vision's seven-step flow) -- `upsertFindings` treats
// `(environment_id, trigger_type, trigger_subject, follow_type,
// follow_subject)` as that pattern's stable identity (backed by
// idx_findings_environment_pattern) and UPDATEs the existing row's
// statistics in place rather than inserting a duplicate. Evidence is
// replaced wholesale on every re-detection (old rows for that finding
// deleted, the freshly computed evidence inserted) -- the evidence table
// always reflects the MOST RECENT mining pass's actual supporting events,
// never an ever-growing accumulation across every run that ever found this
// pattern.
//
// -- Evidence purge is independent of the finding row ------------------------
// `purgeFindingEvidence` is the WP-3.4 hook this WP was asked to design for
// now: deletes every row in `findings_evidence` for one finding WITHOUT
// touching `findings` itself. The finding's own summary columns
// (occurrences/confidence/lift/pValue, ...) already live on `findings`
// directly, so a finding remains fully meaningful (still shows its stats,
// still supports accept/ignore/expire) after its evidence is purged -- only
// WP-3.6's "which events produced this" drill-down loses its answer, exactly
// the tradeoff the product vision's "remove temporary learning data" step
// describes.
//
// -- A purge must not be silently undone by the NEXT mining run (WP-3.4) ----
// `upsertFindings`' existing-row branch normally calls `replaceEvidence` on
// every re-detection, unconditionally -- exactly right for a finding still
// working its way through new/suggested/ignored, where fresh evidence is
// exactly what WP-3.6's drill-down should show. But once a finding has been
// ACCEPTED, electron/services/pattern-miner/finding-lifecycle-service.cjs's
// acceptFinding() has already purged its evidence on purpose, as the literal
// "purge the temporary learning data" step of the product vision's seven-step
// flow -- if the very next mining run (the flow's own "keep mining" step)
// then re-populated it the moment it re-detects the same still-true pattern,
// that purge would only ever last until the next scheduled run, which is not
// what "purge" means. So: an existing finding whose `status` is already
// "accepted" has its stats refreshed as normal, but its evidence is left
// alone -- accepted is a terminal lifecycle state (see finding-lifecycle.cjs's
// TRANSITIONS), so there is no future decision this row's evidence could
// still inform.
// ---------------------------------------------------------------------------

const { randomUUID } = require("node:crypto");

const nowIso = () => new Date().toISOString();

function rowToFinding(row) {
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		environmentId: row.environment_id,
		patternType: row.pattern_type,
		trigger: { type: row.trigger_type, subject: row.trigger_subject ?? null },
		follow: { type: row.follow_type, subject: row.follow_subject ?? null },
		windowMinutes: row.window_minutes,
		occurrences: row.occurrences,
		trials: row.trials,
		confidence: row.confidence,
		baselineProbability: row.baseline_probability,
		lift: row.lift,
		pValue: row.p_value,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		// WP-3.4's lifecycle columns (migration 013) -- see that migration's own
		// header for what each one means. Read here unconditionally: every column
		// has a NOT NULL default (ignoreCount) or is simply nullable, so a
		// pre-WP-3.4 row (impossible in practice, since the migration backfills
		// every existing row, but still) degrades to "never ignored, never
		// suggested, never decided" rather than `undefined`.
		ignoreCount: row.ignore_count ?? 0,
		suppressedUntil: row.suppressed_until ?? null,
		suggestedAt: row.suggested_at ?? null,
		decidedAt: row.decided_at ?? null,
		acceptedRuleId: row.accepted_rule_id ?? null,
		// WP-3.6 (migration 014) -- the one user-editable field on this row; see
		// updateFindingLabel's own header for why nothing else here is. `null`
		// (every pre-014 row, and any finding never edited) means "use the
		// auto-generated description" (finding-translator.cjs#buildFindingRuleLabel),
		// read unconditionally exactly like ignoreCount above degrades safely for
		// a pre-migration row.
		label: row.label ?? null,
	};
}

function findExistingFinding(db, finding) {
	return db.first(
		`SELECT * FROM findings
		 WHERE environment_id = ? AND trigger_type = ? AND trigger_subject IS ? AND follow_type = ? AND follow_subject IS ?`,
		[
			finding.environmentId,
			finding.trigger.type,
			finding.trigger.subject ?? null,
			finding.follow.type,
			finding.follow.subject ?? null,
		],
	);
}

function replaceEvidence(db, findingId, evidence) {
	db.run("DELETE FROM findings_evidence WHERE finding_id = ?", [findingId]);
	for (const item of Array.isArray(evidence) ? evidence : []) {
		if (!Number.isFinite(item?.triggerEventId) || !Number.isFinite(item?.followEventId)) {
			continue; // malformed evidence entry -- skip rather than corrupt the row
		}
		db.run("INSERT INTO findings_evidence (finding_id, trigger_event_id, follow_event_id) VALUES (?, ?, ?)", [
			findingId,
			item.triggerEventId,
			item.followEventId,
		]);
	}
}

// Writes an entire mining run's findings in ONE transaction. `findings` is
// the plain array electron/services/pattern-miner/algorithm.cjs's
// mineBuckets() (or mine-worker.cjs's per-bucket "bucket-done" messages,
// concatenated by miner.cjs) produces -- each entry already carries
// `environmentId`. Returns `{ created, updated }` counts.
function upsertFindings(db, findings) {
	if (!db || !Array.isArray(findings) || findings.length === 0) {
		return { created: 0, updated: 0 };
	}

	let created = 0;
	let updated = 0;

	db.transaction(() => {
		for (const finding of findings) {
			// `== null` deliberately, catching BOTH undefined and null. Undefined
			// is a malformed entry; null is a real, reachable case that this
			// table cannot store: `findings.environment_id` is NOT NULL
			// (migration 012 chose that deliberately, unlike `files` and
			// `smart_functions`), while the miner genuinely produces a "no
			// environment" bucket -- listDistinctEventEnvironmentIds maps a NULL
			// `events.environment_id` to null, and miner.cjs tags that bucket's
			// findings `environmentId: null`. Events with no environment are
			// ordinary (anything recorded before the first environment switch,
			// `file_index.crawl_completed`, ...), so this is not hypothetical.
			//
			// Skipping matters far more than it looks: miner.cjs collects EVERY
			// bucket's findings and calls this function ONCE, inside a single
			// transaction. A NOT NULL violation here would therefore abort the
			// whole run's writes -- one unstorable finding silently discarding
			// every other environment's results. The comment below was already
			// right that a malformed entry is "never worth aborting the whole
			// run over"; this makes it true for the null case too.
			//
			// The cost is that patterns found outside any environment are not
			// surfaced. That follows from migration 012's NOT NULL choice, and
			// changing it would mean a table rebuild (SQLite cannot drop a NOT
			// NULL constraint in place) -- worth revisiting deliberately, not as
			// a side effect of a crash fix.
			if (!finding || finding.environmentId == null || !finding.trigger || !finding.follow) {
				continue; // malformed or unstorable -- never worth aborting the whole run over
			}
			const existing = findExistingFinding(db, finding);
			const now = nowIso();

			if (existing) {
				db.run(
					`UPDATE findings SET
						window_minutes = ?, occurrences = ?, trials = ?, confidence = ?,
						baseline_probability = ?, lift = ?, p_value = ?, updated_at = ?
					 WHERE id = ?`,
					[
						finding.windowMinutes,
						finding.occurrences,
						finding.trials,
						finding.confidence,
						finding.baselineProbability,
						finding.lift,
						finding.pValue,
						now,
						existing.id,
					],
				);
				// See this file's header ("A purge must not be silently undone by
				// the next mining run") -- an accepted finding's evidence was
				// purged on purpose and must stay purged.
				if (existing.status !== "accepted") {
					replaceEvidence(db, existing.id, finding.evidence);
				}
				updated += 1;
			} else {
				const id = randomUUID();
				db.run(
					`INSERT INTO findings
						(id, environment_id, pattern_type, trigger_type, trigger_subject, follow_type, follow_subject,
						 window_minutes, occurrences, trials, confidence, baseline_probability, lift, p_value, status,
						 created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
					[
						id,
						finding.environmentId,
						finding.patternType,
						finding.trigger.type,
						finding.trigger.subject ?? null,
						finding.follow.type,
						finding.follow.subject ?? null,
						finding.windowMinutes,
						finding.occurrences,
						finding.trials,
						finding.confidence,
						finding.baselineProbability,
						finding.lift,
						finding.pValue,
						now,
						now,
					],
				);
				replaceEvidence(db, id, finding.evidence);
				created += 1;
			}
		}
	});

	return { created, updated };
}

function listFindingsForEnvironment(db, environmentId) {
	if (!db) {
		return [];
	}
	return db
		.all("SELECT * FROM findings WHERE environment_id = ? ORDER BY created_at DESC", [environmentId])
		.map(rowToFinding);
}

function listAllFindings(db) {
	if (!db) {
		return [];
	}
	return db.all("SELECT * FROM findings ORDER BY created_at DESC").map(rowToFinding);
}

function getFinding(db, id) {
	if (!db || !id) {
		return null;
	}
	return rowToFinding(db.first("SELECT * FROM findings WHERE id = ?", [id]));
}

// WP-3.6's "which events produced this finding" drill-down.
function getFindingEvidence(db, findingId) {
	if (!db || !findingId) {
		return [];
	}
	return db
		.all("SELECT trigger_event_id, follow_event_id FROM findings_evidence WHERE finding_id = ? ORDER BY id ASC", [
			findingId,
		])
		.map((row) => ({ triggerEventId: row.trigger_event_id, followEventId: row.follow_event_id }));
}

// The WP-3.4 purge step: removes the raw evidence trail for one finding
// WITHOUT touching the finding row itself -- see this file's header. Returns
// the number of evidence rows removed, so a caller can report/verify the
// purge actually did something.
function purgeFindingEvidence(db, findingId) {
	if (!db || !findingId) {
		return 0;
	}
	const before = db.first("SELECT COUNT(*) AS count FROM findings_evidence WHERE finding_id = ?", [findingId]);
	db.run("DELETE FROM findings_evidence WHERE finding_id = ?", [findingId]);
	return before?.count ?? 0;
}

// A full delete -- the finding AND its evidence -- for WP-3.6's "delete a
// finding" operation. Distinct from purgeFindingEvidence (which deliberately
// leaves the finding behind); this one leaves nothing.
function deleteFinding(db, id) {
	if (!db || !id) {
		return false;
	}
	const existing = db.first("SELECT id FROM findings WHERE id = ?", [id]);
	if (!existing) {
		return false;
	}
	db.transaction(() => {
		db.run("DELETE FROM findings_evidence WHERE finding_id = ?", [id]);
		db.run("DELETE FROM findings WHERE id = ?", [id]);
	});
	return true;
}

// The WP-3.4 lifecycle write path: a partial update against the five columns
// migration 013 added (status, ignore_count, suppressed_until, suggested_at,
// decided_at, accepted_rule_id) -- mirrors electron/services/smart-functions/
// store.cjs#updateRule's own patch semantics exactly (re-reads the CURRENT row
// first, so a field `patch` omits is preserved, not reset). This is the ONLY
// function in this package that writes `status` -- electron/services/pattern-
// miner/finding-lifecycle-service.cjs (the stateful orchestrator) is this
// function's only caller, and it always calls this AFTER confirming the move
// through finding-lifecycle.cjs#canTransition, never as a bare, unchecked
// write. `upsertFindings` above deliberately never touches any of these
// columns -- a re-detected pattern's stats refresh in place, but re-mining
// alone can never move a finding through its lifecycle.
function updateFindingLifecycle(db, id, patch = {}) {
	const current = getFinding(db, id);
	if (!current) {
		return null;
	}
	const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
	const status = has("status") ? patch.status : current.status;
	const ignoreCount = has("ignoreCount") ? patch.ignoreCount : current.ignoreCount;
	const suppressedUntil = has("suppressedUntil") ? patch.suppressedUntil : current.suppressedUntil;
	const suggestedAt = has("suggestedAt") ? patch.suggestedAt : current.suggestedAt;
	const decidedAt = has("decidedAt") ? patch.decidedAt : current.decidedAt;
	const acceptedRuleId = has("acceptedRuleId") ? patch.acceptedRuleId : current.acceptedRuleId;
	db.run(
		`UPDATE findings SET
			status = ?, ignore_count = ?, suppressed_until = ?, suggested_at = ?, decided_at = ?, accepted_rule_id = ?, updated_at = ?
		 WHERE id = ?`,
		[status, ignoreCount, suppressedUntil, suggestedAt, decidedAt, acceptedRuleId, nowIso(), id],
	);
	return getFinding(db, id);
}

// WP-3.6's "edit" operation -- the ONLY finding field a user may hand-edit
// (migration 014's own header explains why: everything else on this row is a
// mined fact, and rewriting it would be falsifying evidence). `label` is
// trimmed and capped defensively (200 chars -- generous for a one-line
// description, but not unbounded); a blank/non-string value is normalized to
// `null` ("use the auto-generated description"), never stored as an empty
// string that would read as a real, deliberately-blank label.
function updateFindingLabel(db, id, label) {
	const current = getFinding(db, id);
	if (!current) {
		return null;
	}
	const normalized = typeof label === "string" && label.trim() ? label.trim().slice(0, 200) : null;
	db.run("UPDATE findings SET label = ?, updated_at = ? WHERE id = ?", [normalized, nowIso(), id]);
	return getFinding(db, id);
}

// WP-3.6's "move between environments" -- the raw column write only, no
// isolation opinion of its own (exactly like every other raw write in this
// module). electron/services/pattern-miner/finding-lifecycle-service.cjs#
// moveFinding is the ONLY legal caller: it is the one place that checks the
// finding is even movable (finding-lifecycle.cjs#canMoveFinding) and that the
// move doesn't cross an enclosed environment's isolation boundary
// (electron/data/isolation.cjs#isFindingMoveAllowed) BEFORE this function
// ever runs, and it purges this finding's evidence in the SAME transaction --
// see that function's own header for why the evidence purge is unconditional
// on every move, not only an enclosure-involving one.
function moveFindingEnvironment(db, id, environmentId) {
	const current = getFinding(db, id);
	if (!current) {
		return null;
	}
	db.run("UPDATE findings SET environment_id = ?, updated_at = ? WHERE id = ?", [environmentId, nowIso(), id]);
	return getFinding(db, id);
}

module.exports = {
	upsertFindings,
	listFindingsForEnvironment,
	listAllFindings,
	getFinding,
	getFindingEvidence,
	purgeFindingEvidence,
	deleteFinding,
	updateFindingLifecycle,
	updateFindingLabel,
	moveFindingEnvironment,
	rowToFinding,
};
