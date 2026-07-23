"use strict";

// ---------------------------------------------------------------------------
// Per-environment AI memory (WP-4.2) -- every read and write against
// `ai_memory` (migration 015), following the same "only this module touches
// this table" discipline as pattern-miner/store.cjs and file-index/store.cjs.
//
// -- Every function requires an environment id, and refuses without one -------
// There is no listAllMemories, no getMemory-by-id-alone, and no way to ask this
// module a question that spans environments. That is not an oversight to be
// filled in later: a memory is a fact the user taught the assistant inside one
// environment, and an accessor that could return another environment's
// memories would be one refactor away from putting them in a prompt. The
// discipline mirrors electron/data/scoped.cjs's own `requireEnvironmentId`
// ("refusing to build an unscoped accessor") -- the boundary is easier to hold
// when crossing it is not expressible.
//
// `getMemory` and `deleteMemory` take BOTH an id and an environment id and
// verify the row belongs there, exactly like scoped.cjs's own tasks.get: an id
// alone is a capability, and ids leak.
// ---------------------------------------------------------------------------

const { randomUUID } = require("node:crypto");

const nowIso = () => new Date().toISOString();

// Generous for a remembered fact, and far below anything that would meaningfully
// eat a context budget on its own. Trimmed rather than rejected -- see migration
// 015's header on why the cap lives here and not in the schema.
const MAX_CONTENT_LENGTH = 2000;

function rowToMemory(row) {
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		environmentId: row.environment_id,
		content: row.content,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function normalizeContent(content) {
	if (typeof content !== "string") {
		return "";
	}
	return content.trim().slice(0, MAX_CONTENT_LENGTH);
}

/**
 * One environment's memories, oldest first. The order is deliberate and
 * stable: context-builder.cjs truncates by dropping from the END, so "oldest
 * first" means the memories a user set up earliest survive a squeeze. Any
 * recency-based order would make the same prompt include different facts on
 * different days, which is precisely the non-determinism WP-4.2 rules out.
 */
function listMemories(db, environmentId) {
	if (!db || !environmentId) {
		return [];
	}
	return db
		.all("SELECT * FROM ai_memory WHERE environment_id = ? ORDER BY created_at ASC, id ASC", [environmentId])
		.map(rowToMemory);
}

function getMemory(db, environmentId, id) {
	if (!db || !environmentId || !id) {
		return null;
	}
	// Scoped in the query itself, not filtered afterwards -- a row belonging to
	// another environment is never loaded at all.
	return rowToMemory(db.first("SELECT * FROM ai_memory WHERE id = ? AND environment_id = ?", [id, environmentId]));
}

function createMemory(db, environmentId, content) {
	if (!db || !environmentId) {
		return null;
	}
	const normalized = normalizeContent(content);
	if (!normalized) {
		// An empty memory is not a memory. Refused rather than stored, so the
		// context builder never has to filter blanks out later.
		return null;
	}
	const id = randomUUID();
	const now = nowIso();
	db.run("INSERT INTO ai_memory (id, environment_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
		id,
		environmentId,
		normalized,
		now,
		now,
	]);
	return getMemory(db, environmentId, id);
}

function updateMemory(db, environmentId, id, content) {
	const existing = getMemory(db, environmentId, id);
	if (!existing) {
		return null;
	}
	const normalized = normalizeContent(content);
	if (!normalized) {
		return existing; // Refuse to blank an existing memory; delete is explicit.
	}
	db.run("UPDATE ai_memory SET content = ?, updated_at = ? WHERE id = ? AND environment_id = ?", [
		normalized,
		nowIso(),
		id,
		environmentId,
	]);
	return getMemory(db, environmentId, id);
}

function deleteMemory(db, environmentId, id) {
	if (!getMemory(db, environmentId, id)) {
		return false;
	}
	db.run("DELETE FROM ai_memory WHERE id = ? AND environment_id = ?", [id, environmentId]);
	return true;
}

/** Used when an environment is deleted, so its memories go with it. */
function deleteMemoriesForEnvironment(db, environmentId) {
	if (!db || !environmentId) {
		return 0;
	}
	const before = db.first("SELECT COUNT(*) AS count FROM ai_memory WHERE environment_id = ?", [environmentId]);
	db.run("DELETE FROM ai_memory WHERE environment_id = ?", [environmentId]);
	return before?.count ?? 0;
}

module.exports = {
	MAX_CONTENT_LENGTH,
	listMemories,
	getMemory,
	createMemory,
	updateMemory,
	deleteMemory,
	deleteMemoriesForEnvironment,
	rowToMemory,
};
