"use strict";

// ---------------------------------------------------------------------------
// MCP's wire protocol (WP-4.3) -- JSON-RPC 2.0 message construction, response
// interpretation, stream framing, and the translation of an MCP tool
// definition into this codebase's canonical tool spec. Pure: no sockets, no
// child processes, no Electron.
//
// -- Why framing gets its own tested function --------------------------------
// The stdio transport reads a byte stream, not messages. A server can write
// half a message, two messages in one chunk, or a message split across three
// chunks, and every one of those is normal. Getting that wrong produces bugs
// that only appear under load or with large tool results -- exactly the ones
// that are miserable to reproduce -- so `createLineFramer` is a standalone,
// directly tested state machine rather than a few lines buried in the
// transport.
//
// -- MCP is newline-delimited JSON over stdio --------------------------------
// One JSON object per line, no Content-Length headers. Blank lines and any
// non-JSON line (servers commonly log to stdout by accident) are skipped
// rather than treated as protocol errors -- a server that prints a startup
// banner should not take the connection down.
//
// -- Errors are values, not exceptions ---------------------------------------
// A JSON-RPC error response is a legitimate reply, not a transport failure.
// `interpretResponse` returns a discriminated result so a caller can tell "the
// server said no" from "the server never answered", which are different
// problems with different remedies.
// ---------------------------------------------------------------------------

const JSONRPC_VERSION = "2.0";

// The MCP protocol revision this client implements. Sent during `initialize`;
// a server that speaks a different one still answers, and the mismatch is
// surfaced rather than guessed at.
const PROTOCOL_VERSION = "2024-11-05";

const CLIENT_INFO = Object.freeze({ name: "Atlas", version: "1.0.0" });

/** Builds a JSON-RPC request. `id` correlates the eventual response. */
function buildRequest(id, method, params) {
	const request = { jsonrpc: JSONRPC_VERSION, id, method };
	if (params !== undefined) {
		request.params = params;
	}
	return request;
}

/** A notification has no id and never receives a response. */
function buildNotification(method, params) {
	const notification = { jsonrpc: JSONRPC_VERSION, method };
	if (params !== undefined) {
		notification.params = params;
	}
	return notification;
}

function buildInitializeRequest(id, options = {}) {
	return buildRequest(id, "initialize", {
		protocolVersion: PROTOCOL_VERSION,
		// Declared honestly: Atlas consumes tools and nothing else today. A
		// server may use this to decide what to offer, so claiming capabilities
		// that are not implemented would invite requests that cannot be served.
		capabilities: options.capabilities ?? {},
		clientInfo: options.clientInfo ?? CLIENT_INFO,
	});
}

/**
 * Interprets one parsed JSON-RPC response.
 *
 * Returns `{ kind: "result", value }`, `{ kind: "error", code, message, data }`
 * or `{ kind: "invalid", message }`. A caller must be able to distinguish a
 * server that refused from a message that was never a valid response at all.
 */
function interpretResponse(message) {
	if (!message || typeof message !== "object") {
		return { kind: "invalid", message: "Response was not an object." };
	}
	if (message.error) {
		const error = message.error;
		return {
			kind: "error",
			code: Number.isFinite(error.code) ? error.code : null,
			message: typeof error.message === "string" && error.message ? error.message : "The server reported an error.",
			data: error.data ?? null,
		};
	}
	if ("result" in message) {
		return { kind: "result", value: message.result };
	}
	return { kind: "invalid", message: "Response contained neither a result nor an error." };
}

/** True for a message that is a response to a request (rather than a server-initiated one). */
function isResponse(message) {
	return Boolean(message && typeof message === "object" && message.id !== undefined && message.id !== null);
}

/**
 * A stateful newline framer. Feed it arbitrary chunks; it calls `onMessage`
 * with each complete parsed JSON object, in order.
 *
 * Deliberately tolerant: a line that is not JSON is handed to `onJunk` (for
 * diagnostics) and skipped, never thrown. Servers log to stdout more often
 * than anyone would like.
 */
function createLineFramer({ onMessage, onJunk, maxBufferBytes = 8 * 1024 * 1024 } = {}) {
	let buffer = "";
	let overflowed = false;

	function push(chunk) {
		buffer += chunk;
		// A server that never emits a newline would otherwise grow this buffer
		// without bound. Dropping the buffer is better than exhausting memory,
		// and is reported so the caller can treat the connection as broken.
		if (buffer.length > maxBufferBytes) {
			buffer = "";
			overflowed = true;
			onJunk?.("Discarded an oversized message with no line break.");
			return;
		}

		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				let parsed = null;
				try {
					parsed = JSON.parse(line);
				} catch {
					onJunk?.(line);
				}
				if (parsed !== null) {
					onMessage?.(parsed);
				}
			}
			newline = buffer.indexOf("\n");
		}
	}

	return {
		push,
		/** Exposed for tests and for reporting a half-message at shutdown. */
		pending: () => buffer,
		hasOverflowed: () => overflowed,
		reset: () => {
			buffer = "";
			overflowed = false;
		},
	};
}

/**
 * An MCP tool definition into this codebase's canonical spec
 * (electron/services/ai/contract.cjs#normalizeToolSpec's input shape).
 *
 * `serverId` is folded into the name because tool names are only unique WITHIN
 * one server: two servers may both offer `search`, and a model answering
 * `search` with no qualifier would be ambiguous at exactly the moment it
 * matters. The qualified name is what the model sees and what comes back.
 */
function toolToSpec(serverId, tool) {
	if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
		return null;
	}
	const name = tool.name.trim();
	return {
		name: qualifyToolName(serverId, name),
		description: typeof tool.description === "string" ? tool.description : "",
		parameters:
			tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
	};
}

// A separator that cannot appear in an MCP tool name (they are identifiers),
// so splitting is unambiguous.
const TOOL_NAME_SEPARATOR = "__";

function qualifyToolName(serverId, toolName) {
	return `${serverId}${TOOL_NAME_SEPARATOR}${toolName}`;
}

/** The inverse. Returns null for a name that was never qualified. */
function parseQualifiedToolName(qualified) {
	if (typeof qualified !== "string") {
		return null;
	}
	const index = qualified.indexOf(TOOL_NAME_SEPARATOR);
	if (index <= 0) {
		return null;
	}
	const serverId = qualified.slice(0, index);
	const toolName = qualified.slice(index + TOOL_NAME_SEPARATOR.length);
	if (!serverId || !toolName) {
		return null;
	}
	return { serverId, toolName };
}

/**
 * Flattens an MCP `tools/call` result into text. MCP returns typed content
 * blocks; Atlas hands tool results back to a model as text, so images and
 * other binary blocks are described rather than inlined -- a base64 payload in
 * a prompt is expensive and, for most models here, meaningless.
 *
 * `isError` is carried through separately: a tool that failed is a normal
 * outcome the model should be told about, not an exception.
 */
function flattenToolResult(result) {
	if (!result || typeof result !== "object") {
		return { text: "", isError: false };
	}
	const blocks = Array.isArray(result.content) ? result.content : [];
	const parts = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string" && block.text) {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image omitted]");
		} else if (block.type === "resource" && block.resource?.uri) {
			parts.push(`[resource: ${block.resource.uri}]`);
		}
	}
	return { text: parts.join("\n").trim(), isError: Boolean(result.isError) };
}

module.exports = {
	JSONRPC_VERSION,
	PROTOCOL_VERSION,
	CLIENT_INFO,
	TOOL_NAME_SEPARATOR,
	buildRequest,
	buildNotification,
	buildInitializeRequest,
	interpretResponse,
	isResponse,
	createLineFramer,
	toolToSpec,
	qualifyToolName,
	parseQualifiedToolName,
	flattenToolResult,
};
