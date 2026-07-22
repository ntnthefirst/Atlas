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
		resurfaceDueFindings,
		sweepExpiredFindings,
	};
}

module.exports = { createFindingLifecycleManager };
