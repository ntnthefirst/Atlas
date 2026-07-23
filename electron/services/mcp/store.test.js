import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	createServer,
	deleteServer,
	getServer,
	listServers,
	normalizeConfig,
	resolveConfig,
	secretKeyFor,
	updateServer,
} from "./store.cjs";

// ---------------------------------------------------------------------------
// MCP server configuration (WP-4.3, migration 016). Two things carry weight:
// per-environment scoping (the isolation criterion), and keeping credentials
// out of the database (`config` is plain JSON on disk).
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-store-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

// An in-memory stand-in for electron/services/secrets.cjs, so no test ever
// touches the real OS keystore.
function fakeVault() {
	const values = new Map();
	return {
		values,
		get: vi.fn((key) => values.get(key) ?? ""),
		set: vi.fn((key, value) => values.set(key, value)),
		remove: vi.fn((key) => values.delete(key)),
	};
}

async function twoEnvironments() {
	const db = await AtlasDatabase.create(createTempDbPath());
	return { db, a: db.createEnvironment("A"), b: db.createEnvironment("B") };
}

const STDIO = { label: "Files", transport: "stdio", config: { command: "mcp-files", args: ["--root", "."] } };

describe("per-environment scoping -- the isolation criterion", () => {
	it("lists only the asked-for environment's servers", async () => {
		const { db, a, b } = await twoEnvironments();
		createServer(db, a.id, STDIO);
		createServer(db, b.id, { ...STDIO, label: "B's server" });

		expect(listServers(db, a.id).map((server) => server.label)).toEqual(["Files"]);
		expect(listServers(db, b.id).map((server) => server.label)).toEqual(["B's server"]);
	});

	it("does not return another environment's server, even given its exact id", async () => {
		const { db, a, b } = await twoEnvironments();
		const secret = createServer(db, b.id, STDIO);

		expect(getServer(db, a.id, secret.id)).toBeNull();
		expect(getServer(db, b.id, secret.id)).toBeTruthy();
	});

	it("does not update or delete across environments", async () => {
		const { db, a, b } = await twoEnvironments();
		const secret = createServer(db, b.id, STDIO);

		expect(updateServer(db, a.id, secret.id, { label: "hijacked" })).toBeNull();
		expect(deleteServer(db, a.id, secret.id)).toBe(false);
		expect(getServer(db, b.id, secret.id).label).toBe("Files");
	});

	it("returns nothing without an environment id -- never everything", async () => {
		const { db, a } = await twoEnvironments();
		createServer(db, a.id, STDIO);

		expect(listServers(db, null)).toEqual([]);
		expect(createServer(db, null, STDIO)).toBeNull();
	});
});

describe("credentials never reach the database", () => {
	it("routes an Authorization header to the vault, not to config", async () => {
		const { db, a } = await twoEnvironments();
		const secrets = fakeVault();

		const server = createServer(
			db,
			a.id,
			{
				label: "Remote",
				transport: "http",
				config: { url: "https://example.com/mcp", headers: { Authorization: "Bearer super-secret", "X-Trace": "on" } },
			},
			{ secrets },
		);

		// The stored row keeps the harmless header and not the credential.
		expect(server.config.headers).toEqual({ "X-Trace": "on" });
		// Proven against the raw column, not just the parsed object.
		const raw = db.first("SELECT config FROM mcp_servers WHERE id = ?", [server.id]).config;
		expect(raw).not.toContain("super-secret");
		expect(secrets.set).toHaveBeenCalledWith(secretKeyFor(server.id), expect.stringContaining("super-secret"));
	});

	it("recognises every credential-shaped header name, case-insensitively", () => {
		const { config, secretHeaders } = normalizeConfig("http", {
			url: "https://x",
			headers: {
				authorization: "a",
				"X-API-Key": "b",
				"api-key": "c",
				Cookie: "d",
				"X-Auth-Token": "e",
				"Content-Language": "en",
			},
		});

		expect(Object.keys(secretHeaders).sort()).toEqual([
			"Cookie",
			"X-API-Key",
			"X-Auth-Token",
			"api-key",
			"authorization",
		]);
		expect(config.headers).toEqual({ "Content-Language": "en" });
	});

	it("puts the credential back at connect time, in memory only", async () => {
		const { db, a } = await twoEnvironments();
		const secrets = fakeVault();
		const server = createServer(
			db,
			a.id,
			{ label: "Remote", transport: "http", config: { url: "https://x", headers: { Authorization: "Bearer s3cret" } } },
			{ secrets },
		);

		const resolved = resolveConfig(getServer(db, a.id, server.id), { secrets });
		expect(resolved.headers.Authorization).toBe("Bearer s3cret");
		// The stored row still does not carry it.
		expect(getServer(db, a.id, server.id).config.headers.Authorization).toBeUndefined();
	});

	// The same refusal WP-0.4 established for AI keys: no plaintext fallback.
	it("saves the server without the credential when the vault refuses", async () => {
		const { db, a } = await twoEnvironments();
		const secrets = fakeVault();
		secrets.set.mockImplementation(() => {
			throw new Error("Keystore unavailable");
		});

		const server = createServer(
			db,
			a.id,
			{ label: "Remote", transport: "http", config: { url: "https://x", headers: { Authorization: "Bearer s3cret" } } },
			{ secrets },
		);

		expect(server).toBeTruthy();
		const raw = db.first("SELECT config FROM mcp_servers WHERE id = ?", [server.id]).config;
		expect(raw).not.toContain("s3cret");
	});

	it("forgets the credential when the server is deleted", async () => {
		const { db, a } = await twoEnvironments();
		const secrets = fakeVault();
		const server = createServer(
			db,
			a.id,
			{ label: "Remote", transport: "http", config: { url: "https://x", headers: { Authorization: "Bearer s3cret" } } },
			{ secrets },
		);

		deleteServer(db, a.id, server.id, { secrets });
		expect(secrets.remove).toHaveBeenCalledWith(secretKeyFor(server.id));
	});
});

describe("validation", () => {
	it("refuses a server with nothing to connect to", async () => {
		const { db, a } = await twoEnvironments();

		expect(createServer(db, a.id, { label: "Empty", transport: "stdio", config: {} })).toBeNull();
		expect(createServer(db, a.id, { label: "Empty", transport: "http", config: {} })).toBeNull();
		expect(createServer(db, a.id, { label: "", transport: "stdio", config: { command: "x" } })).toBeNull();
		expect(listServers(db, a.id)).toEqual([]);
	});

	it("defaults an unknown transport to stdio rather than storing nonsense", async () => {
		const { db, a } = await twoEnvironments();
		const server = createServer(db, a.id, { label: "X", transport: "carrier-pigeon", config: { command: "x" } });
		expect(server.transport).toBe("stdio");
	});

	it("keeps only string args and env values", () => {
		const { config } = normalizeConfig("stdio", {
			command: "srv",
			args: ["--flag", 42, null, "--ok"],
			env: { GOOD: "yes", BAD: 7 },
		});
		expect(config.args).toEqual(["--flag", "--ok"]);
		expect(config.env).toEqual({ GOOD: "yes" });
	});

	it("survives a corrupted config column", async () => {
		const { db, a } = await twoEnvironments();
		const server = createServer(db, a.id, STDIO);
		db.run("UPDATE mcp_servers SET config = ? WHERE id = ?", ["{not json", server.id]);

		expect(getServer(db, a.id, server.id).config).toEqual({});
	});
});

describe("update", () => {
	it("changes only what the patch names", async () => {
		const { db, a } = await twoEnvironments();
		const server = createServer(db, a.id, STDIO);

		const updated = updateServer(db, a.id, server.id, { enabled: false });
		expect(updated.enabled).toBe(false);
		expect(updated.label).toBe("Files");
		expect(updated.config.command).toBe("mcp-files");
	});

	it("re-splits credentials when the config is replaced", async () => {
		const { db, a } = await twoEnvironments();
		const secrets = fakeVault();
		const server = createServer(db, a.id, { label: "Remote", transport: "http", config: { url: "https://x" } }, { secrets });

		updateServer(
			db,
			a.id,
			server.id,
			{ config: { url: "https://x", headers: { Authorization: "Bearer new" } } },
			{ secrets },
		);

		const raw = db.first("SELECT config FROM mcp_servers WHERE id = ?", [server.id]).config;
		expect(raw).not.toContain("Bearer new");
		expect(secrets.set).toHaveBeenCalledWith(secretKeyFor(server.id), expect.stringContaining("Bearer new"));
	});
});
