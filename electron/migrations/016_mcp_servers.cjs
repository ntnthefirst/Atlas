// Migration 016 (WP-4.3) -- MCP servers, configured per environment.
//
// -- environment_id is NOT NULL, for the same reason ai_memory's is ----------
// WP-4.3's fourth criterion is "server config is per environment and
// isolation-respecting". A globally-configured MCP server would be reachable
// from inside an enclosed environment, which means an enclosed environment
// could send its own data out through a tool the user configured somewhere
// else entirely. That is precisely the leak enclosure exists to prevent, and
// it would be invisible: nothing about a tool call announces which environment
// configured the server.
//
// So a server belongs to exactly one environment, always. Wanting the same
// server in two environments means configuring it twice -- deliberately, with
// the second one visible as its own row that can be removed on its own.
//
// -- `config` is an open JSON document ---------------------------------------
// stdio servers need command/args/env/cwd; HTTP servers need url/headers. A
// column per field would mean a migration every time a transport gains an
// option, and half the columns null for every row. The same open-document
// convention smart_functions' trigger/conditions/actions already use, parsed
// defensively by electron/services/mcp/store.cjs.
//
// -- Secrets do NOT go here ---------------------------------------------------
// An HTTP server's auth header is a credential. `config` is plain JSON on
// disk, so the store refuses to persist anything under a secret-shaped key and
// routes it to the vault (WP-0.4) instead -- see store.cjs's own header.
"use strict";

module.exports = {
	version: 16,
	name: "016_mcp_servers",

	up(db) {
		db.run(`CREATE TABLE IF NOT EXISTS mcp_servers (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			label TEXT NOT NULL,
			transport TEXT NOT NULL,
			config TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);

		db.run("CREATE INDEX IF NOT EXISTS idx_mcp_servers_environment ON mcp_servers(environment_id)");
	},
};
