"use strict";

// ---------------------------------------------------------------------------
// Pattern miner IPC handlers (patternMiner:*) -- WP-3.3.
//
// No preload/renderer wiring yet -- exactly the precedent electron/ipc/
// smart-functions.cjs's own header sets for WP-3.1: a later WP (WP-3.5,
// "Suggestion surfacing" / WP-3.6, "Findings management") is what builds the
// UI these channels back. Registering the handlers now keeps `runNow()`/the
// findings read surface real and testable through the same seam every other
// domain uses, without building UI this WP was never asked to build.
//
// `miner` is a plain value (never reassigned after main.cjs constructs it,
// exactly like `fileIndexCrawler`/`smartFunctionsEngine`); `getDb` is a
// getter for the usual reason -- `db` is a `let` main.cjs reassigns during
// startup, well after this module is required.
// ---------------------------------------------------------------------------

const store = require("../services/pattern-miner/store.cjs");

function register(ipcMain, deps) {
	const { miner, getDb } = deps;

	ipcMain.handle("patternMiner:getPreferences", () => miner.getPreferences());

	ipcMain.handle("patternMiner:setPreferences", (_event, patch) => miner.setPreferences(patch || {}));

	// The ONLY way a mining run ever starts -- see miner.cjs's own header for
	// why nothing else in this app may call runNow() automatically.
	ipcMain.handle("patternMiner:runNow", () => miner.runNow());

	ipcMain.handle("patternMiner:getStatus", () => miner.getStatus());

	ipcMain.handle("patternMiner:listFindings", (_event, environmentId) => {
		const db = getDb();
		if (!db) return [];
		return environmentId ? store.listFindingsForEnvironment(db, environmentId) : store.listAllFindings(db);
	});

	ipcMain.handle("patternMiner:getFindingEvidence", (_event, findingId) => {
		const db = getDb();
		if (!db || !findingId) return [];
		return store.getFindingEvidence(db, findingId);
	});
}

module.exports = { register };
