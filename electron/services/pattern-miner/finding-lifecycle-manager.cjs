"use strict";

// ---------------------------------------------------------------------------
// Owns the finding lifecycle's persisted preferences (back-off/expiry
// thresholds, electron/config/finding-lifecycle-prefs.cjs) and is the one
// seam electron/ipc/findings.cjs calls through -- mirrors electron/services/
// pattern-miner/miner.cjs's own split exactly: THIS module is the only place
// that touches `fs`/`app.getPath`, while every actual decision is delegated
// to ./finding-lifecycle-service.cjs (db writes) and ./finding-lifecycle.cjs
// (pure). Same factory shape (`createFindingLifecycleManager(deps)`) for the
// same testability reason: every Electron/fs touchpoint is injectable.
//
// -- Never runs anything automatically ---------------------------------------
// There is no timer here, and none of resurfaceDueFindings/sweepExpiredFindings
// are ever called except through an explicit IPC invocation -- exactly the
// miner's own "runNow() is the only way a mining run ever starts" discipline,
// for the same reason: `npm run smoke`/`smoke:windows` must never have this
// module silently accept, ignore, expire, or resurface anything on its own.
// ---------------------------------------------------------------------------

const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");
const {
	FINDING_LIFECYCLE_PREFS_FILE,
	defaultFindingLifecyclePreferences,
	normalizeFindingLifecyclePreferences,
} = require("../../config/finding-lifecycle-prefs.cjs");
const lifecycleService = require("./finding-lifecycle-service.cjs");
const patternMinerStore = require("./store.cjs");
const { resolveFindingEvidence } = require("./finding-evidence.cjs");
const { buildFindingRuleLabel, translateFindingToRuleInput } = require("./finding-translator.cjs");

function createFindingLifecycleManager(deps = {}) {
	const resolvePrefsPath = deps.getPrefsPath ?? (() => path.join(app.getPath("userData"), FINDING_LIFECYCLE_PREFS_FILE));
	const getDb = deps.getDb ?? (() => null);
	const now = deps.now ?? (() => Date.now());

	let preferences = defaultFindingLifecyclePreferences();

	function loadPreferences() {
		try {
			const raw = fs.readFileSync(resolvePrefsPath(), "utf8");
			preferences = normalizeFindingLifecyclePreferences(JSON.parse(raw));
		} catch {
			preferences = defaultFindingLifecyclePreferences();
		}
		return preferences;
	}

	function persist() {
		try {
			fs.writeFileSync(resolvePrefsPath(), JSON.stringify(preferences, null, 2), "utf8");
		} catch {
			// Non-blocking: preferences still apply for the rest of this session
			// even if they can't be written to disk.
		}
	}

	function getPreferences() {
		return preferences;
	}

	function setPreferences(patch) {
		preferences = normalizeFindingLifecyclePreferences({ ...preferences, ...(patch || {}) });
		persist();
		return preferences;
	}

	function markSuggested(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.markSuggested(db, findingId, { now: now() });
	}

	function acceptFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.acceptFinding(db, findingId, { now: now() });
	}

	function ignoreFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.ignoreFinding(db, findingId, { now: now(), config: preferences });
	}

	// -- WP-3.6's management operations -------------------------------------
	// Every one of these follows the identical shape the WP-3.4 three above
	// already set: resolve the db through the getter, refuse cleanly if it
	// isn't ready yet, delegate the whole decision to ./finding-lifecycle-
	// service.cjs. No decision of any kind is made in this file -- it exists to
	// own preferences and the fs/Electron touchpoints, and nothing else.
	// Enriched with the two things the management surface needs and cannot
	// honestly work out for itself:
	//   `description` -- the SAME plain-language phrasing the Notch's own
	//     suggestion uses (finding-translator.cjs#buildFindingRuleLabel, via
	//     suggestion-manager.cjs), built here rather than re-implemented in the
	//     renderer so the two surfaces can never word the same finding
	//     differently. A user-set `label` (migration 014) wins over it.
	//   `convertible` -- whether this pattern can become a smart function at
	//     all. translateFindingToRuleInput returns null for pattern shapes the
	//     engine has no trigger/action for yet, and acceptFinding refuses those
	//     outright; knowing that up front is what lets the UI disable
	//     accept/convert with an explanation instead of offering a button that
	//     is guaranteed to fail.
	function listFindings(environmentId) {
		const db = getDb();
		if (!db) {
			return [];
		}
		return patternMinerStore.listFindingsForEnvironment(db, environmentId).map((finding) => ({
			...finding,
			description: finding.label || buildFindingRuleLabel(finding),
			convertible: Boolean(translateFindingToRuleInput(finding)),
		}));
	}

	function getFindingEvidence(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready.", reason: "not_found", pairs: [] };
		}
		return resolveFindingEvidence(db, findingId);
	}

	function convertFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.convertFinding(db, findingId, { now: now() });
	}

	function pauseFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.pauseFinding(db, findingId);
	}

	function unpauseFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.unpauseFinding(db, findingId, { now: now() });
	}

	function setFindingLabel(findingId, label) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.setFindingLabel(db, findingId, label);
	}

	function deleteFinding(findingId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.deleteFinding(db, findingId);
	}

	function moveFinding(findingId, environmentId) {
		const db = getDb();
		if (!db) {
			return { ok: false, error: "Database not ready." };
		}
		return lifecycleService.moveFinding(db, findingId, environmentId);
	}

	function resurfaceDueFindings() {
		const db = getDb();
		if (!db) {
			return { resurfacedCount: 0, findingIds: [] };
		}
		return lifecycleService.resurfaceDueFindings(db, { now: now() });
	}

	function sweepExpiredFindings() {
		const db = getDb();
		if (!db) {
			return { expiredCount: 0, findingIds: [] };
		}
		return lifecycleService.sweepExpiredFindings(db, { now: now(), config: preferences });
	}

	return {
		loadPreferences,
		getPreferences,
		setPreferences,
		markSuggested,
		acceptFinding,
		ignoreFinding,
		listFindings,
		getFindingEvidence,
		convertFinding,
		pauseFinding,
		unpauseFinding,
		setFindingLabel,
		deleteFinding,
		moveFinding,
		resurfaceDueFindings,
		sweepExpiredFindings,
	};
}

module.exports = { createFindingLifecycleManager };
