// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- CRUD against the `smart_functions` table
// (migration 011). Deliberately its OWN accessor, not a fifth sub-object
// bolted onto electron/data/scoped.cjs: `scoped()` refuses to build an
// unscoped accessor at all ("requireEnvironmentId... refusing to build an
// unscoped accessor"), but a smart function's `environment_id` is legitimately
// nullable (a rule on a SHARED Notch layout, or a deliberately global
// user-authored rule -- see migration 011's header). This module mirrors
// electron/services/file-index/store.cjs's own nullable-environment
// convention instead: `environment_id IS NULL` means "applies regardless of
// which environment is active", exactly like a NULL `files.environment_id`
// means "every environment can find this file".
// ---------------------------------------------------------------------------

"use strict";

const { randomUUID } = require("node:crypto");
const { rowToRule, normalizeRuleInput } = require("./model.cjs");

const nowIso = () => new Date().toISOString();

// Every rule that applies to `environmentId` right now: its own (if it has
// one) plus every global (NULL) rule. Passing `null`/`undefined` returns only
// the global rules -- there is no "environment id" to match against yet
// (e.g. at boot, before any switch).
function listRulesForEnvironment(db, environmentId) {
	const rows = environmentId
		? db.all("SELECT * FROM smart_functions WHERE environment_id = ? OR environment_id IS NULL ORDER BY created_at ASC", [
				environmentId,
			])
		: db.all("SELECT * FROM smart_functions WHERE environment_id IS NULL ORDER BY created_at ASC");
	return rows.map(rowToRule);
}

// Every rule in the database, regardless of environment -- what the ENGINE
// evaluates against (a single event's own environmentId, or a rule's own
// environment scoping, is what narrows things at decide()-time, not this
// query -- see evaluate.cjs's environment_mismatch check). Also what the
// Settings surface's "all smart functions" list would use once WP-3.2 builds
// it.
function listAllRules(db) {
	return db.all("SELECT * FROM smart_functions ORDER BY created_at ASC").map(rowToRule);
}

function getRule(db, id) {
	if (!id) {
		return null;
	}
	return rowToRule(db.first("SELECT * FROM smart_functions WHERE id = ?", [id]));
}

function createRule(db, input) {
	const normalized = normalizeRuleInput(input);
	const id = randomUUID();
	const now = nowIso();
	db.run(
		`INSERT INTO smart_functions
		   (id, environment_id, label, enabled, trigger, conditions, actions, source, migrated_from, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			normalized.environmentId,
			normalized.label,
			normalized.enabled ? 1 : 0,
			JSON.stringify(normalized.trigger),
			JSON.stringify(normalized.conditions),
			JSON.stringify(normalized.actions),
			normalized.source,
			normalized.migratedFrom,
			now,
			now,
		],
	);
	return getRule(db, id);
}

// Partial update: only fields actually present on `patch` change, exactly
// like electron/db.cjs#setEnvironmentConfig's own patch semantics. Re-reads
// the CURRENT row first so an omitted field is preserved rather than reset
// to normalizeRuleInput's own defaults.
function updateRule(db, id, patch = {}) {
	const current = getRule(db, id);
	if (!current) {
		return null;
	}
	const merged = normalizeRuleInput({
		label: Object.prototype.hasOwnProperty.call(patch, "label") ? patch.label : current.label,
		environmentId: Object.prototype.hasOwnProperty.call(patch, "environmentId") ? patch.environmentId : current.environmentId,
		enabled: Object.prototype.hasOwnProperty.call(patch, "enabled") ? patch.enabled : current.enabled,
		trigger: Object.prototype.hasOwnProperty.call(patch, "trigger") ? patch.trigger : current.trigger,
		conditions: Object.prototype.hasOwnProperty.call(patch, "conditions") ? patch.conditions : current.conditions,
		actions: Object.prototype.hasOwnProperty.call(patch, "actions") ? patch.actions : current.actions,
		source: current.source,
		migratedFrom: current.migratedFrom,
	});
	db.run(
		`UPDATE smart_functions
		   SET environment_id = ?, label = ?, enabled = ?, trigger = ?, conditions = ?, actions = ?, updated_at = ?
		 WHERE id = ?`,
		[
			merged.environmentId,
			merged.label,
			merged.enabled ? 1 : 0,
			JSON.stringify(merged.trigger),
			JSON.stringify(merged.conditions),
			JSON.stringify(merged.actions),
			nowIso(),
			id,
		],
	);
	return getRule(db, id);
}

function setRuleEnabled(db, id, enabled) {
	return updateRule(db, id, { enabled: Boolean(enabled) });
}

function deleteRule(db, id) {
	if (!id) {
		return false;
	}
	const existing = getRule(db, id);
	if (!existing) {
		return false;
	}
	db.run("DELETE FROM smart_functions WHERE id = ?", [id]);
	return true;
}

// The migration's own idempotency check (migration 011's header) -- exposed
// here rather than duplicated as a raw query in migrate-scenes.cjs.
function findByMigratedFrom(db, migratedFrom) {
	if (!migratedFrom) {
		return null;
	}
	return rowToRule(db.first("SELECT * FROM smart_functions WHERE migrated_from = ?", [migratedFrom]));
}

module.exports = {
	listRulesForEnvironment,
	listAllRules,
	getRule,
	createRule,
	updateRule,
	setRuleEnabled,
	deleteRule,
	findByMigratedFrom,
};
