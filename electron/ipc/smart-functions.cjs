// ---------------------------------------------------------------------------
// Smart Functions IPC handlers (smartFunctions:*) -- WP-3.1, completed by
// WP-3.2 (the editor these channels back, plus duplicate and dry-run).
//
// -- Descriptions are attached here, not built in the renderer --------------
// Every read below returns each rule with a `description`: the plain-language
// sentence from ../services/smart-functions/describe.cjs, which is written
// against evaluate.cjs's actual predicates. Building it in the main process is
// what makes "the preview matches actual behaviour" enforceable -- a copy in
// the renderer could drift from the engine without anything failing. The
// environment NAMES the sentence uses are resolved here too, from the
// `environments` table, so the renderer never has to stitch two reads
// together to get a readable rule.
//
// `engine` is a plain value (never reassigned after main.cjs constructs it,
// exactly like `fileIndexCrawler`/`fileIndexWatcher`/`contextService`); `getDb`
// is a getter because `db` is assigned during app startup, after this module
// is required -- the same IPC module pattern every other electron/ipc/*.cjs
// file already follows.
// ---------------------------------------------------------------------------

const store = require("../services/smart-functions/store.cjs");
const { migrateScenes } = require("../services/smart-functions/migrate-scenes.cjs");
const { describeRule } = require("../services/smart-functions/describe.cjs");

function register(ipcMain, deps) {
	const { getDb, engine } = deps;

	// `{ [environmentId]: name }` for describe.cjs, read fresh each time rather
	// than cached: an environment rename must not leave stale names in a
	// preview whose whole job is to be accurate.
	function environmentNames(db) {
		const names = {};
		for (const row of db.all("SELECT id, name FROM environments")) {
			names[row.id] = row.name;
		}
		return names;
	}

	function withDescription(db, rule) {
		if (!rule) {
			return rule;
		}
		return { ...rule, description: describeRule(rule, { environmentNames: environmentNames(db) }) };
	}

	function withDescriptions(db, rules) {
		const names = environmentNames(db);
		return rules.map((rule) => ({ ...rule, description: describeRule(rule, { environmentNames: names }) }));
	}

	ipcMain.handle("smartFunctions:listForEnvironment", (_event, environmentId) => {
		const db = getDb();
		if (!db) return [];
		return withDescriptions(db, store.listRulesForEnvironment(db, environmentId || null));
	});

	ipcMain.handle("smartFunctions:listAll", () => {
		const db = getDb();
		return db ? withDescriptions(db, store.listAllRules(db)) : [];
	});

	ipcMain.handle("smartFunctions:get", (_event, id) => {
		const db = getDb();
		return db ? withDescription(db, store.getRule(db, id)) : null;
	});

	ipcMain.handle("smartFunctions:create", (_event, input) => {
		const db = getDb();
		if (!db) {
			throw new Error("Database not ready.");
		}
		const rule = store.createRule(db, input || {});
		engine?.refreshRules?.();
		return withDescription(db, rule);
	});

	ipcMain.handle("smartFunctions:update", (_event, id, patch) => {
		const db = getDb();
		if (!db || !id) {
			throw new Error("Smart function id is required.");
		}
		const rule = store.updateRule(db, id, patch || {});
		engine?.refreshRules?.();
		return withDescription(db, rule);
	});

	// WP-3.2's "duplicate". The copy starts DISABLED on purpose: duplicating a
	// rule is what you do before changing it, and a live twin firing the same
	// actions in the meantime is the one outcome nobody duplicating a rule
	// wants. `source`/`migratedFrom` are deliberately NOT carried over either
	// -- the copy is a hand-made rule from this moment on, and inheriting a
	// migrated scene's `migrated_from` would collide with that column's UNIQUE
	// constraint (see migrate-scenes.cjs's own idempotency key).
	ipcMain.handle("smartFunctions:duplicate", (_event, id) => {
		const db = getDb();
		if (!db || !id) {
			throw new Error("Smart function id is required.");
		}
		const original = store.getRule(db, id);
		if (!original) {
			throw new Error("Smart function not found.");
		}
		const copy = store.createRule(db, {
			label: `${original.label} (copy)`,
			environmentId: original.environmentId,
			enabled: false,
			trigger: original.trigger,
			conditions: original.conditions,
			actions: original.actions,
			source: "user",
			migratedFrom: null,
		});
		engine?.refreshRules?.();
		return withDescription(db, copy);
	});

	ipcMain.handle("smartFunctions:setEnabled", (_event, id, enabled) => {
		const db = getDb();
		if (!db || !id) {
			throw new Error("Smart function id is required.");
		}
		const rule = store.setRuleEnabled(db, id, Boolean(enabled));
		engine?.refreshRules?.();
		return withDescription(db, rule);
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

	// WP-3.2's dry-run. Synchronous, and deliberately so: there is nothing to
	// await because nothing is executed -- see engine.cjs#dryRun's own header.
	ipcMain.handle("smartFunctions:dryRun", (_event, id) => {
		if (!engine) {
			return { ok: false, error: "Smart functions engine not available." };
		}
		return engine.dryRun(id);
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
