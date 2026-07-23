import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createServer } from "./store.cjs";
import { createMcpManager } from "./manager.cjs";

// ---------------------------------------------------------------------------
// The MCP manager (WP-4.3). The assertions that carry the isolation criterion
// are about CONNECTIONS, not rows: a server configured in one environment must
// not still be running and reachable while another environment is active. A
// process left alive is a far more concrete leak than a row that could have
// been read.
//
// Clients are injected, so nothing here spawns a process or opens a socket.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-manager-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

/** A fake client whose behaviour each test scripts. */
function fakeClientFactory(script = {}) {
	const created = [];
	const factory = vi.fn((config) => {
		const behaviour = script[config.id] ?? {};
		const client = {
			config,
			closed: false,
			connect: vi.fn(async () =>
				behaviour.failConnect ? { ok: false, state: "failed", error: behaviour.failConnect } : { ok: true, state: "ready" },
			),
			listTools: vi.fn(async () => ({ ok: true, tools: behaviour.tools ?? [] })),
			callTool: vi.fn(async (name, args) => behaviour.callResult ?? { ok: true, text: `${name}:${JSON.stringify(args)}` }),
			close: vi.fn(function close() {
				client.closed = true;
			}),
			getStatus: () => ({ id: config.id, state: client.closed ? "closed" : "ready" }),
			getTools: () => behaviour.tools ?? [],
			getLogs: () => [],
		};
		created.push(client);
		return client;
	});
	return { factory, created };
}

async function seeded() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const a = db.createEnvironment("A");
	const b = db.createEnvironment("B");
	return { db, a, b };
}

const stdio = (label) => ({ label, transport: "stdio", config: { command: "srv" } });

describe("connections are per environment", () => {
	it("connects only that environment's enabled servers", async () => {
		const { db, a, b } = await seeded();
		createServer(db, a.id, stdio("A one"));
		createServer(db, a.id, { ...stdio("A disabled"), enabled: false });
		createServer(db, b.id, stdio("B one"));

		const { factory } = fakeClientFactory();
		const manager = createMcpManager({ getDb: () => db, createClient: factory });

		const result = await manager.connectEnvironment(a.id);

		expect(result.connected).toBe(1);
		expect(factory).toHaveBeenCalledOnce();
	});

	// THE isolation assertion: switching must not leave the old environment's
	// servers running.
	it("closes the previous environment's connections before opening the next", async () => {
		const { db, a, b } = await seeded();
		const serverA = createServer(db, a.id, stdio("A one"));
		createServer(db, b.id, stdio("B one"));

		const { factory, created } = fakeClientFactory();
		const manager = createMcpManager({ getDb: () => db, createClient: factory });

		await manager.connectEnvironment(a.id);
		expect(manager.isConnected(serverA.id)).toBe(true);

		await manager.connectEnvironment(b.id);

		expect(created[0].close).toHaveBeenCalled();
		expect(manager.isConnected(serverA.id)).toBe(false);
		expect(manager.getStatus().environmentId).toBe(b.id);
	});

	it("exposes no tools from an environment that is no longer active", async () => {
		const { db, a, b } = await seeded();
		const serverA = createServer(db, a.id, stdio("A one"));
		createServer(db, b.id, stdio("B one"));

		const { factory } = fakeClientFactory({
			[serverA.id]: { tools: [{ name: `${serverA.id}__secret`, serverId: serverA.id, rawName: "secret" }] },
		});
		const manager = createMcpManager({ getDb: () => db, createClient: factory });

		await manager.connectEnvironment(a.id);
		expect(manager.listTools()).toHaveLength(1);

		await manager.connectEnvironment(b.id);
		expect(manager.listTools()).toEqual([]);
	});

	it("disconnectAll leaves nothing running", async () => {
		const { db, a } = await seeded();
		createServer(db, a.id, stdio("A one"));

		const { factory, created } = fakeClientFactory();
		const manager = createMcpManager({ getDb: () => db, createClient: factory });
		await manager.connectEnvironment(a.id);

		manager.disconnectAll();

		expect(created[0].close).toHaveBeenCalled();
		expect(manager.getStatus().servers).toEqual([]);
	});

	it("connects nothing without an environment, and nothing without a database", async () => {
		const { db } = await seeded();
		const { factory } = fakeClientFactory();

		const noEnv = createMcpManager({ getDb: () => db, createClient: factory });
		expect(await noEnv.connectEnvironment(null)).toEqual({ connected: 0, failures: [] });

		const noDb = createMcpManager({ getDb: () => null, createClient: factory });
		expect(await noDb.connectEnvironment("env")).toEqual({ connected: 0, failures: [] });
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("a failing server costs you that server", () => {
	it("keeps the others when one refuses to connect", async () => {
		const { db, a } = await seeded();
		const good = createServer(db, a.id, stdio("Good"));
		const bad = createServer(db, a.id, stdio("Bad"));

		const { factory } = fakeClientFactory({ [bad.id]: { failConnect: "Command not found" } });
		const manager = createMcpManager({ getDb: () => db, createClient: factory });

		const result = await manager.connectEnvironment(a.id);

		expect(result.connected).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].error).toBe("Command not found");
		expect(manager.isConnected(good.id)).toBe(true);
		expect(manager.isConnected(bad.id)).toBe(false);
	});
});

describe("callTool", () => {
	async function withTool() {
		const { db, a } = await seeded();
		const server = createServer(db, a.id, stdio("Files"));
		const { factory, created } = fakeClientFactory({
			[server.id]: { tools: [{ name: `${server.id}__search`, serverId: server.id, rawName: "search" }] },
		});
		const manager = createMcpManager({ getDb: () => db, createClient: factory });
		await manager.connectEnvironment(a.id);
		return { manager, server, created };
	}

	it("routes a qualified name to the right server, with the unqualified name", async () => {
		const { manager, server, created } = await withTool();

		const result = await manager.callTool(`${server.id}__search`, { q: "x" });

		expect(result.ok).toBe(true);
		expect(created[0].callTool).toHaveBeenCalledWith("search", { q: "x" });
	});

	// Picking a server for an ambiguous name is the kind of helpfulness that
	// becomes a security incident.
	it("refuses an unqualified name rather than guessing a server", async () => {
		const { manager } = await withTool();
		expect(await manager.callTool("search", {})).toMatchObject({ ok: false });
	});

	it("refuses a server that is not connected", async () => {
		const { manager } = await withTool();
		expect(await manager.callTool("other-server__search", {})).toMatchObject({ ok: false });
	});
});

describe("what gets logged", () => {
	it("records a connection without its command line or URL", async () => {
		const { db, a } = await seeded();
		createServer(db, a.id, {
			label: "Remote",
			transport: "http",
			config: { url: "https://internal.example.com/mcp?token=abc" },
		});
		const record = vi.fn();
		const { factory } = fakeClientFactory();
		const manager = createMcpManager({ getDb: () => db, createClient: factory, getEventLog: () => ({ record }) });

		await manager.connectEnvironment(a.id);

		const logged = JSON.stringify(record.mock.calls);
		expect(logged).not.toContain("internal.example.com");
		expect(logged).not.toContain("token=abc");
	});

	// Tool arguments and results routinely contain exactly the user content the
	// event log's privacy rules keep out.
	it("records a tool call without its arguments or result", async () => {
		const { db, a } = await seeded();
		const server = createServer(db, a.id, stdio("Files"));
		const record = vi.fn();
		const { factory } = fakeClientFactory({
			[server.id]: { callResult: { ok: true, text: "the private file contents" } },
		});
		const manager = createMcpManager({ getDb: () => db, createClient: factory, getEventLog: () => ({ record }) });
		await manager.connectEnvironment(a.id);

		await manager.callTool(`${server.id}__search`, { query: "my private search" });

		const logged = JSON.stringify(record.mock.calls);
		expect(logged).not.toContain("my private search");
		expect(logged).not.toContain("the private file contents");
	});

	it("survives a broken event log", async () => {
		const { db, a } = await seeded();
		createServer(db, a.id, stdio("Files"));
		const { factory } = fakeClientFactory();
		const manager = createMcpManager({
			getDb: () => db,
			createClient: factory,
			getEventLog: () => ({
				record: () => {
					throw new Error("log is broken");
				},
			}),
		});

		await expect(manager.connectEnvironment(a.id)).resolves.toMatchObject({ connected: 1 });
	});
});
