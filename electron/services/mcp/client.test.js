import { describe, expect, it } from "vitest";
import { createMcpClient, STATE } from "./client.cjs";

// ---------------------------------------------------------------------------
// One MCP connection (WP-4.3). The criterion under test is "a server crash or
// hang is contained -- Atlas stays responsive", so most of this file is about
// what happens when a server misbehaves: never answering, dying mid-request,
// answering something nobody asked for, or answering after a timeout.
//
// The transport is INJECTED (no module mocking anywhere in this package -- see
// WP-4.1's provider tests for why that discipline exists), so a fake server can
// be scripted precisely and no real process is ever spawned.
// ---------------------------------------------------------------------------

/**
 * A scriptable fake MCP server. `respond` decides what, if anything, comes back
 * for each request -- returning undefined means "never answer", which is how a
 * hang is simulated without waiting for one.
 */
function createFakeTransport(respond) {
	const sent = [];
	let handlers = null;
	let closed = false;

	const transport = {
		kind: "fake",
		start: () => true,
		send(message) {
			if (closed) return false;
			sent.push(message);
			const reply = respond(message, transport);
			if (reply !== undefined) {
				// Delivered asynchronously, like a real transport would.
				queueMicrotask(() => handlers?.onMessage?.(reply));
			}
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			handlers?.onClose?.({ reason: "Closed.", stderr: [] });
		},
		isClosed: () => closed,
		stderr: () => [],
		// Test helpers.
		sent,
		crash(reason = "The server exited with code 1.", stderr = []) {
			closed = true;
			handlers?.onClose?.({ reason, stderr });
		},
		emit(message) {
			handlers?.onMessage?.(message);
		},
		_bind(next) {
			handlers = next;
		},
	};
	return transport;
}

function clientWith(respond, config = {}) {
	let transport = null;
	const client = createMcpClient(
		{ id: "srv", ...config },
		{
			createTransport: (_config, handlers) => {
				transport = createFakeTransport(respond);
				transport._bind(handlers);
				return transport;
			},
		},
	);
	return { client, getTransport: () => transport };
}

const initializeResult = (message) => ({
	jsonrpc: "2.0",
	id: message.id,
	result: { protocolVersion: "2024-11-05", serverInfo: { name: "Fake", version: "1" }, capabilities: {} },
});

describe("connect", () => {
	it("completes the handshake and reaches ready", async () => {
		const { client, getTransport } = clientWith((message) =>
			message.method === "initialize" ? initializeResult(message) : undefined,
		);

		const result = await client.connect();

		expect(result.ok).toBe(true);
		expect(client.getStatus().state).toBe(STATE.READY);
		expect(result.serverInfo.name).toBe("Fake");
		// MCP requires the initialized notification once the handshake succeeds.
		expect(getTransport().sent.some((message) => message.method === "notifications/initialized")).toBe(true);
	});

	// THE containment criterion, at connect time.
	it("gives up in bounded time when the server never answers the handshake", async () => {
		const { client } = clientWith(() => undefined, { connectTimeoutMs: 20 });

		const result = await client.connect();

		expect(result.ok).toBe(false);
		expect(client.getStatus().state).toBe(STATE.FAILED);
		expect(result.error).toMatch(/handshake/i);
	});

	// A half-connected server left running with nobody reading it is a leaked
	// process.
	it("closes the transport when the handshake times out", async () => {
		const { client, getTransport } = clientWith(() => undefined, { connectTimeoutMs: 20 });

		await client.connect();

		expect(getTransport().isClosed()).toBe(true);
	});

	it("reports a server that refuses the handshake", async () => {
		const { client } = clientWith((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32600, message: "Unsupported protocol version" },
		}));

		const result = await client.connect();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unsupported protocol version");
	});

	it("fails cleanly with no transport rather than throwing", async () => {
		const client = createMcpClient({ id: "srv" }, {});
		const result = await client.connect();
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("listTools", () => {
	async function connected(respond) {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : respond(message)));
		await built.client.connect();
		return built;
	}

	it("qualifies every tool with the server id", async () => {
		const { client } = await connected((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			result: { tools: [{ name: "search", description: "Finds", inputSchema: { type: "object" } }] },
		}));

		const result = await client.listTools();

		expect(result.ok).toBe(true);
		expect(result.tools[0].name).toBe("srv__search");
		expect(result.tools[0].rawName).toBe("search");
	});

	it("reports a refusal rather than throwing", async () => {
		const { client } = await connected((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: "Not supported" },
		}));

		const result = await client.listTools();
		expect(result.ok).toBe(false);
		expect(result.tools).toEqual([]);
	});

	it("refuses before the handshake instead of hanging", async () => {
		const { client } = clientWith(() => undefined);
		const result = await client.listTools();
		expect(result.ok).toBe(false);
	});
});

describe("callTool", () => {
	async function connectedWithTool(respond, config = {}) {
		const built = clientWith((message) => {
			if (message.method === "initialize") return initializeResult(message);
			if (message.method === "tools/list") {
				return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } };
			}
			return respond(message);
		}, config);
		await built.client.connect();
		await built.client.listTools();
		return built;
	}

	it("returns the flattened text of a successful call", async () => {
		const { client } = await connectedWithTool((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: "found it" }] },
		}));

		expect(await client.callTool("search", { q: "x" })).toEqual({ ok: true, text: "found it", isError: false });
	});

	// A tool that failed is a normal outcome the model should hear about, not a
	// transport failure.
	it("distinguishes a tool that failed from a call that failed", async () => {
		const { client } = await connectedWithTool((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: "no such file" }], isError: true },
		}));

		const result = await client.callTool("search", {});
		expect(result.ok).toBe(true);
		expect(result.isError).toBe(true);
	});

	it("sends the server's own tool name, not the qualified one", async () => {
		const { client, getTransport } = await connectedWithTool((message) => ({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [] },
		}));

		await client.callTool("search", {});
		const call = getTransport().sent.find((message) => message.method === "tools/call");
		expect(call.params.name).toBe("search");
	});

	// THE containment criterion, at call time.
	it("times out a call the server never answers, and stays usable afterwards", async () => {
		let answer = false;
		const { client } = await connectedWithTool(
			(message) =>
				answer ? { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "later" }] } } : undefined,
			// A short timeout: this asserts the deadline EXISTS, and waiting the
			// production 30s to prove it would make the suite unusable.
			{ requestTimeoutMs: 20 },
		);

		const first = await client.callTool("search", {});
		expect(first.ok).toBe(false);
		expect(first.error).toMatch(/in time/i);

		// The connection is not wedged: the next call still works.
		answer = true;
		const second = await client.callTool("search", {});
		expect(second).toMatchObject({ ok: true, text: "later" });
	});

	it("drops a reply that arrives after its request timed out", async () => {
		const { client, getTransport } = await connectedWithTool(() => undefined, { requestTimeoutMs: 20 });

		const pendingResult = await client.callTool("search", {});
		expect(pendingResult.ok).toBe(false);

		// The late answer must not resolve anything, and must not throw.
		expect(() => getTransport().emit({ jsonrpc: "2.0", id: 3, result: { content: [] } })).not.toThrow();
		expect(client.getStatus().pendingCount).toBe(0);
	});
});

describe("crash containment", () => {
	it("rejects every outstanding request when the server dies mid-call", async () => {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : undefined));
		await built.client.connect();

		const inFlight = built.client.callTool("search", {});
		// The server dies before answering.
		built.getTransport().crash("The server exited with code 1.", ["Traceback: boom"]);

		const result = await inFlight;
		expect(result.ok).toBe(false);
		expect(built.client.getStatus().state).toBe(STATE.FAILED);
	});

	it("keeps the server's last words for diagnosis", async () => {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : undefined));
		await built.client.connect();

		built.getTransport().crash("The server exited with code 1.", ["ImportError: no module named mcp"]);

		expect(built.client.getLogs().some((entry) => entry.line.includes("ImportError"))).toBe(true);
	});

	it("forgets its tools when the connection drops", async () => {
		const built = clientWith((message) => {
			if (message.method === "initialize") return initializeResult(message);
			if (message.method === "tools/list") {
				return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } };
			}
			return undefined;
		});
		await built.client.connect();
		await built.client.listTools();
		expect(built.client.getTools()).toHaveLength(1);

		built.getTransport().crash();
		expect(built.client.getTools()).toEqual([]);
	});

	// A crashed server stays crashed until something explicit reconnects it --
	// automatic restarts would turn a crash-on-startup into a spawn loop.
	it("does not reconnect on its own", async () => {
		let starts = 0;
		const client = createMcpClient(
			{ id: "srv" },
			{
				createTransport: (_config, handlers) => {
					starts += 1;
					const transport = createFakeTransport((message) =>
						message.method === "initialize" ? initializeResult(message) : undefined,
					);
					transport._bind(handlers);
					return transport;
				},
			},
		);

		await client.connect();
		expect(starts).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(starts).toBe(1);
	});

	it("ignores an unsolicited server message without crashing", async () => {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : undefined));
		await built.client.connect();

		expect(() => built.getTransport().emit({ jsonrpc: "2.0", method: "notifications/progress" })).not.toThrow();
		expect(built.client.getStatus().state).toBe(STATE.READY);
	});
});

describe("close", () => {
	it("rejects outstanding requests rather than leaving them pending forever", async () => {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : undefined));
		await built.client.connect();

		const inFlight = built.client.callTool("search", {});
		built.client.close();

		expect((await inFlight).ok).toBe(false);
		expect(built.client.getStatus().pendingCount).toBe(0);
		expect(built.client.getStatus().state).toBe(STATE.CLOSED);
	});

	it("is safe to call twice", async () => {
		const built = clientWith((message) => (message.method === "initialize" ? initializeResult(message) : undefined));
		await built.client.connect();

		built.client.close();
		expect(() => built.client.close()).not.toThrow();
	});
});
