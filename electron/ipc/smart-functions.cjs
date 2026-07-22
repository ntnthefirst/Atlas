// ---------------------------------------------------------------------------
// Smart Functions IPC handlers (smartFunctions:*) -- WP-3.1.
//
// No preload/renderer wiring yet: WP-3.2 ("Smart Function editor") is the
// package that builds the UI these channels back. Registering the handlers
// now (rather than waiting for WP-3.2) keeps the engine's CRUD surface real
// and testable through the same seam every other domain uses, without
// getting ahead of a UI this WP was never asked to build -- see this WP's
// final report for why that split, not an oversight.
//
// `engine` is a plain value (never reassigned after main.cjs constructs it,
// exactly like `fileIndexCrawler`/`fileIndexWatcher`/`contextService`); `getDb`
// is a getter because `db` is assigned during app startup, after this module
// is required -- the same IPC module pattern every other electron/ipc/*.cjs
// file already follows.
// ---------------------------------------------------------------------------

const store = require("../services/smart-functions/store.cjs");
const { migrateScenes } = require("../services/smart-functions/migrate-scenes.cjs");

function register(ipcMain, deps) {
	const { getDb, engine } = deps;

	ipcMain.handle("smartFunctions:listForEnvironment", (_event, environmentId) => {
		const db = getDb();
		if (!db) return [];
		return store.listRulesForEnvironment(db, environmentId || null);
	});

	ipcMain.handle("smartFunctions:listAll", () => {
		const db = getDb();
		return db ? store.listAllRules(db) : [];
	});

	ipcMain.handle("smartFunctions:get", (_event, id) => {
		const db = getDb();
		return db ? store.getRule(db, id) : null;
	});

	ipcMain.handle("smartFunctions:create", (_event, input) => {
		const db = getDb();
		if (!db) {
			throw new Error("Database not ready.");
		}
		const rule = store.createRule(db, input || {});
		engine?.refreshRules?.();
		return rule;
	});

	ipcMain.handle("smartFunctions:update", (_event, id, patch) => {
		const db = getDb();
		if (!db || !id) {
			throw new Error("Smart function id is required.");
		}
		const rule = store.updateRule(db, id, patch || {});
		engine?.refreshRules?.();
		return rule;
	});

	ipcMain.handle("smartFunctions:setEnabled", (_event, id, enabled) => {
		const db = getDb();
		if (!db || !id) {
			throw new Error("Smart function id is required.");
		}
		const rule = store.setRuleEnabled(db, id, Boolean(enabled));
		engine?.refreshRules?.();
		return rule;
	});

	ipcMain.handle("smartFunctions:delete", (_event, id) => {
		const db = getDb();
		if (!db || !id) {
			return false;
		}
		const deleted = store.deleteRule(db, id);
		engine?.refreshRules?.();
		return deleted;
	});

	ipcMain.handle("smartFunctions:runNow", async (_event, id) => {
		if (!engine) {
			return { ok: false, error: "Smart functions engine not available." };
		}
		return engine.runManually(id);
	});

	// Re-runnable on demand (Settings' own "Re-check for scenes" button, once
	// WP-3.2 builds one) -- safe to call any number of times, see
	// migrate-scenes.cjs's own idempotency guarantee. main.cjs already calls
	// this automatically once at boot; this channel exists for visibility/
	// testing, not because automatic migration depends on it.
	ipcMain.handle("smartFunctions:migrateScenes", () => {
		const db = getDb();
		if (!db) {
			throw new Error("Database not ready.");
		}
		const result = migrateScenes(db);
		engine?.refreshRules?.();
		return result;
	});
}

module.exports = { register };
