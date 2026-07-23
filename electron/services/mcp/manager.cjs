"use strict";

// ---------------------------------------------------------------------------
// The MCP manager (WP-4.3): owns every live connection, keyed by server id,
// and is the one seam electron/ipc/mcp.cjs and the AI layer call through.
//
// -- Connections are per environment, and switching disconnects --------------
// A connection belongs to the environment whose row configured it. Switching
// environment closes every connection from the old one before opening any from
// the new: leaving them running would mean an enclosed environment's session
// still had live handles to servers configured elsewhere, which is the leak
// migration 016's NOT NULL exists to prevent -- and a process left running is
// a much more concrete leak than a row that could have been read.
//
// -- Nothing connects on its own ---------------------------------------------
// `connectEnvironment` is only ever called explicitly. Spawning child
// processes at boot for every configured server would make Atlas's startup
// depend on other people's software, and would make `npm run smoke` spawn
// them too. The same discipline the miner and the finding lifecycle already
// follow.
//
// -- A failed server costs you that server -----------------------------------
// Connecting is per-server and failures are collected, never thrown: one
// broken server must not stop the others from being usable, exactly like a
// broken AI provider module in WP-4.1's registry.
// ---------------------------------------------------------------------------

const store = require("./store.cjs");
const { createMcpClient } = require("./client.cjs");
const { createStdioTransport } = require("./transport-stdio.cjs");
const { createHttpTransport } = require("./transport-http.cjs");
const { parseQualifiedToolName } = require("./protocol.cjs");

function defaultCreateTransport(config, handlers) {
	return config.transport === "http" ? createHttpTransport(config, handlers) : createStdioTransport(config, handlers);
}

function createMcpManager(deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	const secrets = deps.secrets ?? null;
	const createTransport = deps.createTransport ?? defaultCreateTransport;
	const createClient = deps.createClient ?? createMcpClient;
	const getEventLog = deps.getEventLog ?? (() => null);

	// serverId -> { client, environmentId, label }
	const connections = new Map();
	let connectedEnvironmentId = null;

	function logSafely(type, options) {
		try {
			getEventLog()?.record?.(type, options);
		} catch {
			// A broken event log must never break a connection.
		}
	}

	function disconnectAll() {
		for (const [, connection] of connections) {
			try {
				connection.client.close();
			} catch {
				// Already gone.
			}
		}
		connections.clear();
		connectedEnvironmentId = null;
	}

	async function connectServer(server) {
		const resolved = store.resolveConfig(server, { secrets });
		const client = createClient(
			{
				id: server.id,
				transport: server.transport,
				...resolved,
			},
			{ createTransport },
		);
		const result = await client.connect();
		if (!result.ok) {
			// Not retained: a client that never connected has nothing to close
			// and nothing to offer.
			return { ok: false, id: server.id, label: server.label, error: result.error };
		}
		connections.set(server.id, { client, environmentId: server.environmentId, label: server.label });
		const listed = await client.listTools();
		logSafely("mcp.server_connected", {
			environmentId: server.environmentId,
			subject: server.id,
			// The server's LABEL and tool count only -- never a command line, a
			// URL or a header, any of which can carry a credential.
			payload: { toolCount: listed.tools.length },
		});
		return { ok: true, id: server.id, label: server.label, toolCount: listed.tools.length };
	}

	/** Closes whatever is open, then connects that environment's enabled servers. */
	async function connectEnvironment(environmentId) {
		disconnectAll();
		const db = getDb();
		if (!db || !environmentId) {
			return { connected: 0, failures: [] };
		}
		connectedEnvironmentId = environmentId;

		const servers = store.listServers(db, environmentId).filter((server) => server.enabled);
		const results = await Promise.all(servers.map((server) => connectServer(server)));
		return {
			connected: results.filter((result) => result.ok).length,
			failures: results.filter((result) => !result.ok),
		};
	}

	/** Every tool from every connected server, already qualified by server id. */
	function listTools() {
		const tools = [];
		for (const [, connection] of connections) {
			tools.push(...connection.client.getTools());
		}
		return tools;
	}

	/**
	 * Invokes a tool by its QUALIFIED name (`<serverId>__<toolName>`), which is
	 * what the model was given. An unqualified or unknown name is refused
	 * rather than guessed at -- picking a server for an ambiguous name is
	 * exactly the kind of helpfulness that becomes a security incident.
	 */
	async function callTool(qualifiedName, args) {
		const parsed = parseQualifiedToolName(qualifiedName);
		if (!parsed) {
			return { ok: false, error: `"${qualifiedName}" is not a known tool.` };
		}
		const connection = connections.get(parsed.serverId);
		if (!connection) {
			return { ok: false, error: "That server is not connected." };
		}
		const result = await connection.client.callTool(parsed.toolName, args);
		logSafely("mcp.tool_called", {
			environmentId: connection.environmentId,
			subject: qualifiedName,
			// Never the arguments or the result: both routinely contain exactly
			// the user content electron/services/event-log.cjs's privacy rules
			// keep out of the log.
			payload: { ok: result.ok, isError: Boolean(result.isError) },
		});
		return result;
	}

	function getStatus() {
		return {
			environmentId: connectedEnvironmentId,
			servers: [...connections.values()].map((connection) => ({
				...connection.client.getStatus(),
				label: connection.label,
			})),
		};
	}

	return {
		connectEnvironment,
		disconnectAll,
		listTools,
		callTool,
		getStatus,
		getLogs: (serverId) => connections.get(serverId)?.client.getLogs() ?? [],
		isConnected: (serverId) => connections.has(serverId),
	};
}

module.exports = { createMcpManager, defaultCreateTransport };
