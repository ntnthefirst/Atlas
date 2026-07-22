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
			if (!finding || finding.environmentId === undefined || !finding.trigger || !finding.follow) {
				continue; // malformed entry -- never worth aborting the whole run over
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
				replaceEvidence(db, existing.id, finding.evidence);
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

module.exports = {
	upsertFindings,
	listFindingsForEnvironment,
	listAllFindings,
	getFinding,
	getFindingEvidence,
	purgeFindingEvidence,
	deleteFinding,
	rowToFinding,
};
