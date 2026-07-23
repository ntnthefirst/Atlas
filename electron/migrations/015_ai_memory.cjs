// Migration 015 (WP-4.2) -- per-environment AI memory: durable facts the user
// wants the assistant to know inside one environment, and nowhere else.
//
// -- Why environment_id is NOT NULL ------------------------------------------
// Every other nullable `environment_id` in this schema (files, smart_functions)
// means "applies regardless of which environment is active", which is a useful
// thing for a file index or a global rule to say. It is exactly the wrong thing
// for AI memory. A memory row with no environment would be a fact that follows
// the user into every environment including enclosed ones -- which is the
// precise leak WP-0.8's isolation model exists to prevent, and it would be
// invisible, because nothing about a remembered sentence announces which
// environment taught it.
//
// So this column matches `findings.environment_id` (migration 012) rather than
// `files.environment_id`: a memory belongs to exactly one environment, always,
// and there is deliberately no way to express a global one. If a genuinely
// app-wide instruction is ever wanted, it should be a separate concept with its
// own name and its own isolation story, not a null in this column.
//
// -- No content constraints beyond NOT NULL ----------------------------------
// The content is free text the user wrote. Length is bounded at the service
// layer (electron/services/ai/memory-store.cjs) rather than by the schema, for
// the same reason findings.label is: a column constraint that rejects a write
// turns a too-long paste into a crash, while a service-layer cap turns it into
// a trim.
"use strict";

module.exports = {
	version: 15,
	name: "015_ai_memory",

	up(db) {
		db.run(`CREATE TABLE IF NOT EXISTS ai_memory (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);

		// Every read is "this environment's memories", so this is the only index
		// the access pattern needs.
		db.run("CREATE INDEX IF NOT EXISTS idx_ai_memory_environment ON ai_memory(environment_id)");
	},
};
