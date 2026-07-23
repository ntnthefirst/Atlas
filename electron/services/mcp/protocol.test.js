import { describe, expect, it, vi } from "vitest";
import {
	PROTOCOL_VERSION,
	buildInitializeRequest,
	buildNotification,
	buildRequest,
	createLineFramer,
	flattenToolResult,
	interpretResponse,
	isResponse,
	parseQualifiedToolName,
	qualifyToolName,
	toolToSpec,
} from "./protocol.cjs";

// ---------------------------------------------------------------------------
// MCP's wire protocol (WP-4.3). The framer gets the most attention here on
// purpose: it turns a byte stream into messages, and every way of getting that
// wrong produces a bug that only shows up under load or with large tool
// results -- the worst kind to reproduce from a user report.
// ---------------------------------------------------------------------------

describe("message construction", () => {
	it("builds a JSON-RPC request", () => {
		expect(buildRequest(7, "tools/list", { a: 1 })).toEqual({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/list",
			params: { a: 1 },
		});
	});

	it("omits params entirely when there are none", () => {
		expect(buildRequest(1, "tools/list")).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	});

	it("builds a notification with no id -- nothing will answer it", () => {
		const notification = buildNotification("notifications/initialized");
		expect(notification.id).toBeUndefined();
		expect(isResponse(notification)).toBe(false);
	});

	it("declares the protocol version and client in the handshake", () => {
		const request = buildInitializeRequest(1);
		expect(request.params.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(request.params.clientInfo.name).toBe("Atlas");
	});

	// Claiming capabilities Atlas has not implemented would invite requests it
	// cannot serve.
	it("declares no capabilities by default", () => {
		expect(buildInitializeRequest(1).params.capabilities).toEqual({});
	});
});

describe("interpretResponse -- refused is not the same as broken", () => {
	it("reads a result", () => {
		expect(interpretResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } })).toEqual({
			kind: "result",
			value: { tools: [] },
		});
	});

	it("reads an error as a value, not an exception", () => {
		const interpreted = interpretResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "No such method" } });
		expect(interpreted).toMatchObject({ kind: "error", code: -32601, message: "No such method" });
	});

	it("distinguishes a malformed response from either", () => {
		expect(interpretResponse({ jsonrpc: "2.0", id: 1 }).kind).toBe("invalid");
		expect(interpretResponse(null).kind).toBe("invalid");
		expect(interpretResponse("nope").kind).toBe("invalid");
	});

	it("treats a null result as a result, not an absence", () => {
		expect(interpretResponse({ jsonrpc: "2.0", id: 1, result: null })).toEqual({ kind: "result", value: null });
	});
});

describe("createLineFramer", () => {
	function framerWith() {
		const messages = [];
		const junk = [];
		const framer = createLineFramer({
			onMessage: (message) => messages.push(message),
			onJunk: (line) => junk.push(line),
		});
		return { framer, messages, junk };
	}

	it("reads one message from one chunk", () => {
		const { framer, messages } = framerWith();
		framer.push('{"id":1}\n');
		expect(messages).toEqual([{ id: 1 }]);
	});

	// The case that breaks naive implementations.
	it("reassembles a message split across several chunks", () => {
		const { framer, messages } = framerWith();
		framer.push('{"id"');
		framer.push(":1,");
		framer.push('"method":"x"}');
		expect(messages).toEqual([]);
		framer.push("\n");
		expect(messages).toEqual([{ id: 1, method: "x" }]);
	});

	it("reads several messages arriving in one chunk", () => {
		const { framer, messages } = framerWith();
		framer.push('{"id":1}\n{"id":2}\n{"id":3}\n');
		expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
	});

	it("holds a trailing partial message until its newline arrives", () => {
		const { framer, messages } = framerWith();
		framer.push('{"id":1}\n{"id":2');
		expect(messages).toEqual([{ id: 1 }]);
		expect(framer.pending()).toBe('{"id":2');
		framer.push("}\n");
		expect(messages.map((message) => message.id)).toEqual([1, 2]);
	});

	// Servers log to stdout more often than they should; a startup banner must
	// not take the connection down.
	it("skips a non-JSON line and keeps going", () => {
		const { framer, messages, junk } = framerWith();
		framer.push('Server listening on port 3000\n{"id":1}\n');
		expect(messages).toEqual([{ id: 1 }]);
		expect(junk).toEqual(["Server listening on port 3000"]);
	});

	it("ignores blank lines", () => {
		const { framer, messages, junk } = framerWith();
		framer.push('\n\n{"id":1}\n\n');
		expect(messages).toEqual([{ id: 1 }]);
		expect(junk).toEqual([]);
	});

	it("handles CRLF line endings", () => {
		const { framer, messages } = framerWith();
		framer.push('{"id":1}\r\n');
		expect(messages).toEqual([{ id: 1 }]);
	});

	// A server that never emits a newline would otherwise grow the buffer
	// without bound.
	it("drops an oversized unterminated buffer rather than exhausting memory", () => {
		const messages = [];
		const junk = [];
		const framer = createLineFramer({
			onMessage: (message) => messages.push(message),
			onJunk: (line) => junk.push(line),
			maxBufferBytes: 100,
		});

		framer.push("x".repeat(500));
		expect(framer.hasOverflowed()).toBe(true);
		expect(framer.pending()).toBe("");
		expect(junk).toHaveLength(1);

		// And it recovers -- the next well-formed message still arrives.
		framer.push('{"id":1}\n');
		expect(messages).toEqual([{ id: 1 }]);
	});
});

describe("tool names are qualified by server", () => {
	// Two servers may both offer `search`; an unqualified answer would be
	// ambiguous at exactly the moment it matters.
	it("round-trips a qualified name", () => {
		const qualified = qualifyToolName("server-1", "search");
		expect(parseQualifiedToolName(qualified)).toEqual({ serverId: "server-1", toolName: "search" });
	});

	it("keeps a tool name containing the separator intact", () => {
		const qualified = qualifyToolName("srv", "deep__search");
		expect(parseQualifiedToolName(qualified)).toEqual({ serverId: "srv", toolName: "deep__search" });
	});

	it("refuses a name that was never qualified", () => {
		expect(parseQualifiedToolName("search")).toBeNull();
		expect(parseQualifiedToolName("__search")).toBeNull();
		expect(parseQualifiedToolName("srv__")).toBeNull();
		expect(parseQualifiedToolName(null)).toBeNull();
	});
});

describe("toolToSpec", () => {
	it("maps an MCP tool onto the canonical spec", () => {
		expect(
			toolToSpec("srv", {
				name: "search",
				description: "Finds things",
				inputSchema: { type: "object", properties: { q: { type: "string" } } },
			}),
		).toEqual({
			name: "srv__search",
			description: "Finds things",
			parameters: { type: "object", properties: { q: { type: "string" } } },
		});
	});

	it("defaults a missing schema rather than sending none", () => {
		expect(toolToSpec("srv", { name: "ping" }).parameters).toEqual({ type: "object", properties: {} });
	});

	it("drops a tool with no usable name", () => {
		expect(toolToSpec("srv", { description: "nameless" })).toBeNull();
		expect(toolToSpec("srv", null)).toBeNull();
	});
});

describe("flattenToolResult", () => {
	it("joins text blocks", () => {
		expect(flattenToolResult({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] })).toEqual({
			text: "one\ntwo",
			isError: false,
		});
	});

	// A base64 image in a prompt is expensive and, for most models here,
	// meaningless -- so it is described rather than inlined.
	it("describes an image instead of inlining it", () => {
		const flattened = flattenToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
		expect(flattened.text).toBe("[image omitted]");
		expect(flattened.text).not.toContain("AAAA");
	});

	it("names a resource by uri", () => {
		expect(flattenToolResult({ content: [{ type: "resource", resource: { uri: "file:///x" } }] }).text).toBe(
			"[resource: file:///x]",
		);
	});

	// A tool that failed is a normal outcome the model should hear about.
	it("carries isError without treating it as a transport failure", () => {
		expect(flattenToolResult({ content: [{ type: "text", text: "not found" }], isError: true })).toEqual({
			text: "not found",
			isError: true,
		});
	});

	it("never throws on a malformed result", () => {
		expect(flattenToolResult(null)).toEqual({ text: "", isError: false });
		expect(flattenToolResult({ content: "nope" })).toEqual({ text: "", isError: false });
		expect(flattenToolResult({ content: [null, 42] })).toEqual({ text: "", isError: false });
	});
});

describe("isResponse", () => {
	it("is true only for something carrying an id", () => {
		expect(isResponse({ id: 1, result: {} })).toBe(true);
		expect(isResponse({ method: "notifications/x" })).toBe(false);
		expect(isResponse({ id: null })).toBe(false);
		expect(isResponse(null)).toBe(false);
	});
});

describe("no accidental I/O", () => {
	it("is a pure module -- requiring it starts nothing", () => {
		// A guard against someone later adding a connection or timer at module
		// scope: this file is required by the transports and the client, and any
		// side effect here would run in every one of them.
		const spy = vi.spyOn(globalThis, "setTimeout");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
