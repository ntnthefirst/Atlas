"use strict";

// ---------------------------------------------------------------------------
// MCP IPC handlers (mcp:*) -- WP-4.3.
//
// Every channel takes an environment id, because every MCP server belongs to
// exactly one environment (migration 016). There is no "list all servers"
// channel and no unscoped variant of anything here, for the same reason
// electron/services/mcp/store.cjs cannot express one.
//
// -- What crosses the boundary, and what does not ----------------------------
// A server's stored `config` is returned to the renderer so the settings UI can
// show and edit it -- but credentials were never in it (store.cjs routes them
// to the vault), so there is nothing here to redact. `resolveConfig`, which
// puts the credential back, is only ever called inside the manager at connect
// time and its result never leaves the main process.
//
// `manager` is a plain value; `getDb` is a getter for the usual reason.
// ---------------------------------------------------------------------------

const store = require("../services/mcp/store.cjs");

function register(ipcMain, deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	const getSecrets = deps.getSecrets ?? (() => null);
	const manager = deps.manager ?? null;

	const secretsDep = () => ({ secrets: getSecrets() });

	ipcMain.handle("mcp:listServers", (_event, environmentId) => store.listServers(getDb(), environmentId));

	ipcMain.handle("mcp:createServer", (_event, environmentId, input) =>
		store.createServer(getDb(), environmentId, input || {}, secretsDep()),
	);

	ipcMain.handle("mcp:updateServer", (_event, environmentId, id, patch) =>
		store.updateServer(getDb(), environmentId, id, patch || {}, secretsDep()),
	);

	ipcMain.handle("mcp:deleteServer", (_event, environmentId, id) =>
		store.deleteServer(getDb(), environmentId, id, secretsDep()),
	);

	// Connecting is always explicit -- see manager.cjs's header on why nothing
	// spawns a child process on its own.
	ipcMain.handle("mcp:connect", async (_event, environmentId) => {
		if (!manager) {
			return { connected: 0, failures: [], error: "MCP is not available." };
		}
		return manager.connectEnvironment(environmentId);
	});

	ipcMain.handle("mcp:disconnect", () => {
		manager?.disconnectAll();
		return true;
	});

	ipcMain.handle("mcp:getStatus", () => manager?.getStatus() ?? { environmentId: null, servers: [] });

	ipcMain.handle("mcp:listTools", () => manager?.listTools() ?? []);

	// Exposed so the settings UI can show why a server will not start. The logs
	// are a bounded ring of the server's own stdout/stderr, which is exactly
	// what diagnosing "it just says failed" needs.
	ipcMain.handle("mcp:getLogs", (_event, serverId) => manager?.getLogs(serverId) ?? []);

	// A manual invocation, for testing a server from the settings UI. The AI
	// path does NOT come through here -- it goes through the manager directly
	// (see electron/services/ai/tool-runner.cjs), so a renderer cannot use this
	// channel to bypass anything the AI path enforces.
	ipcMain.handle("mcp:callTool", async (_event, qualifiedName, args) => {
		if (!manager) {
			return { ok: false, error: "MCP is not available." };
		}
		return manager.callTool(qualifiedName, args || {});
	});
}

module.exports = { register };
