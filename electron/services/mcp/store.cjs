"use strict";

// ---------------------------------------------------------------------------
// MCP server configuration (WP-4.3) -- every read and write against
// `mcp_servers` (migration 016).
//
// -- Environment-scoped in the same way ai_memory is -------------------------
// There is no listAllServers and no get-by-id-alone. A server belongs to one
// environment; an accessor that spanned environments would be one refactor
// away from letting an enclosed environment reach a server configured
// elsewhere, which is exactly what migration 016's NOT NULL exists to prevent.
//
// -- Credentials never land in `config` --------------------------------------
// `config` is plain JSON in the database. An HTTP MCP server usually needs an
// Authorization header, which is a credential, and writing it here would
// undo WP-0.4's whole point. So:
//
//   - `normalizeConfig` strips any header whose name looks like a credential
//     and returns them separately;
//   - the caller stores those through electron/services/secrets.cjs under a
//     per-server vault key;
//   - `resolveConfig` puts them back at connect time, in memory only.
//
// The stripping is deliberately by NAME rather than by value: a value-based
// heuristic would have to guess what a secret looks like, and would miss the
// first one that did not look like one.
// ---------------------------------------------------------------------------

const { randomUUID } = require("node:crypto");

const nowIso = () => new Date().toISOString();

const TRANSPORTS = Object.freeze(["stdio", "http"]);

// Header names that carry a credential. Matched case-insensitively; anything
// here is routed to the vault instead of the database.
const SECRET_HEADER_PATTERN = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|x-auth-token)$/i;

/** The vault key for one server's secret headers. */
const secretKeyFor = (serverId) => `mcp.${serverId}.headers`;

const asTrimmed = (value) => (typeof value === "string" ? value.trim() : "");

function normalizeStdioConfig(raw) {
	const command = asTrimmed(raw.command);
	return {
		command,
		args: Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === "string") : [],
		env:
			raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
				? Object.fromEntries(
						Object.entries(raw.env).filter(([key, value]) => typeof key === "string" && typeof value === "string"),
					)
				: {},
		cwd: asTrimmed(raw.cwd) || null,
	};
}

function normalizeHttpConfig(raw) {
	const headers = {};
	const secretHeaders = {};
	if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
		for (const [name, value] of Object.entries(raw.headers)) {
			if (typeof name !== "string" || typeof value !== "string") continue;
			if (SECRET_HEADER_PATTERN.test(name.trim())) {
				secretHeaders[name.trim()] = value;
			} else {
				headers[name.trim()] = value;
			}
		}
	}
	return { config: { url: asTrimmed(raw.url), headers }, secretHeaders };
}

/**
 * Splits a raw config into what may be persisted and what must go to the
 * vault. Returns `{ transport, config, secretHeaders }`.
 */
function normalizeConfig(transport, raw) {
	const value = raw && typeof raw === "object" ? raw : {};
	if (transport === "stdio") {
		return { transport, config: normalizeStdioConfig(value), secretHeaders: {} };
	}
	const { config, secretHeaders } = normalizeHttpConfig(value);
	return { transport: "http", config, secretHeaders };
}

function parseConfig(raw) {
	if (typeof raw !== "string" || !raw.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function rowToServer(row) {
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		environmentId: row.environment_id,
		label: row.label,
		transport: TRANSPORTS.includes(row.transport) ? row.transport : "stdio",
		config: parseConfig(row.config),
		enabled: Number(row.enabled) === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function listServers(db, environmentId) {
	if (!db || !environmentId) {
		return [];
	}
	return db
		.all("SELECT * FROM mcp_servers WHERE environment_id = ? ORDER BY created_at ASC, id ASC", [environmentId])
		.map(rowToServer);
}

function getServer(db, environmentId, id) {
	if (!db || !environmentId || !id) {
		return null;
	}
	return rowToServer(db.first("SELECT * FROM mcp_servers WHERE id = ? AND environment_id = ?", [id, environmentId]));
}

/**
 * `deps.secrets` is electron/services/secrets.cjs (injected so tests never
 * touch the real OS keystore). Secret headers are stored there; a vault that
 * is unavailable means the server is saved WITHOUT them rather than with them
 * in plaintext -- the same refusal WP-0.4 established for AI keys.
 */
function createServer(db, environmentId, input, deps = {}) {
	if (!db || !environmentId) {
		return null;
	}
	const label = asTrimmed(input?.label);
	const transport = TRANSPORTS.includes(input?.transport) ? input.transport : "stdio";
	const { config, secretHeaders } = normalizeConfig(transport, input?.config);
	if (!label) {
		return null;
	}
	// A server with nothing to connect to is refused rather than stored as a
	// row that can only ever fail.
	if (transport === "stdio" ? !config.command : !config.url) {
		return null;
	}

	const id = randomUUID();
	const now = nowIso();
	db.run(
		`INSERT INTO mcp_servers (id, environment_id, label, transport, config, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, environmentId, label, transport, JSON.stringify(config), input?.enabled === false ? 0 : 1, now, now],
	);
	persistSecretHeaders(id, secretHeaders, deps);
	return getServer(db, environmentId, id);
}

function updateServer(db, environmentId, id, patch, deps = {}) {
	const current = getServer(db, environmentId, id);
	if (!current) {
		return null;
	}
	const has = (key) => Object.prototype.hasOwnProperty.call(patch ?? {}, key);
	const transport = has("transport") && TRANSPORTS.includes(patch.transport) ? patch.transport : current.transport;
	const rawConfig = has("config") ? patch.config : current.config;
	const { config, secretHeaders } = normalizeConfig(transport, rawConfig);

	db.run(
		`UPDATE mcp_servers SET label = ?, transport = ?, config = ?, enabled = ?, updated_at = ?
		 WHERE id = ? AND environment_id = ?`,
		[
			has("label") && asTrimmed(patch.label) ? asTrimmed(patch.label) : current.label,
			transport,
			JSON.stringify(config),
			has("enabled") ? (patch.enabled ? 1 : 0) : current.enabled ? 1 : 0,
			nowIso(),
			id,
			environmentId,
		],
	);
	if (has("config")) {
		persistSecretHeaders(id, secretHeaders, deps);
	}
	return getServer(db, environmentId, id);
}

function deleteServer(db, environmentId, id, deps = {}) {
	if (!getServer(db, environmentId, id)) {
		return false;
	}
	db.run("DELETE FROM mcp_servers WHERE id = ? AND environment_id = ?", [id, environmentId]);
	try {
		deps.secrets?.remove?.(secretKeyFor(id));
	} catch {
		// A vault that cannot be written must not block the delete -- the row is
		// gone either way, and an orphaned secret is harmless.
	}
	return true;
}

function persistSecretHeaders(serverId, secretHeaders, deps) {
	if (!deps.secrets) {
		return;
	}
	try {
		if (Object.keys(secretHeaders).length === 0) {
			deps.secrets.remove?.(secretKeyFor(serverId));
			return;
		}
		deps.secrets.set(secretKeyFor(serverId), JSON.stringify(secretHeaders));
	} catch {
		// See this file's header: no plaintext fallback, ever. The server is
		// saved without its credential and will fail to authenticate, which is
		// visible and fixable -- unlike a secret quietly written to disk.
	}
}

/**
 * The connect-time view: the stored config with its secret headers put back.
 * In memory only; never written anywhere, never returned to the renderer.
 */
function resolveConfig(server, deps = {}) {
	if (!server) {
		return null;
	}
	if (server.transport !== "http") {
		return { ...server.config, id: server.id };
	}
	let secretHeaders = {};
	try {
		const raw = deps.secrets?.get?.(secretKeyFor(server.id));
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") {
				secretHeaders = parsed;
			}
		}
	} catch {
		// A vault read that fails leaves the request unauthenticated, which the
		// server will reject with a message the user can act on.
	}
	return { ...server.config, headers: { ...(server.config.headers ?? {}), ...secretHeaders }, id: server.id };
}

module.exports = {
	TRANSPORTS,
	SECRET_HEADER_PATTERN,
	secretKeyFor,
	normalizeConfig,
	listServers,
	getServer,
	createServer,
	updateServer,
	deleteServer,
	resolveConfig,
	rowToServer,
};
