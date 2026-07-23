"use strict";

// ---------------------------------------------------------------------------
// MCP over HTTP (WP-4.3): each JSON-RPC request is a POST; the response is
// either a single JSON object or an SSE stream carrying one.
//
// -- Why this looks so different from the stdio transport --------------------
// It presents the SAME interface (start/send/close, messages via onMessage) so
// ./client.cjs never branches on transport. But underneath there is no
// long-lived process and no persistent connection: HTTP MCP is request/
// response, so `send` performs a POST and feeds the reply back through
// `onMessage` as though it had arrived on a stream. That keeps one correlation
// path in the client instead of two.
//
// A notification (no id) still gets POSTed, and its empty/202 response is
// simply discarded -- there is nothing to correlate.
//
// -- Containment -------------------------------------------------------------
// Every request carries a hard timeout and is aborted, so a server that
// accepts a connection and then goes quiet cannot hold a request open
// indefinitely. `close` marks the transport closed so late replies from
// in-flight requests are dropped rather than delivered to a caller that has
// moved on.
//
// -- http vs https ------------------------------------------------------------
// Both are supported, because MCP servers are very often on localhost where
// TLS is meaningless. The module picks by protocol rather than assuming.
// ---------------------------------------------------------------------------

const http = require("node:http");
const https = require("node:https");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function parseSseForMessages(payload) {
	const messages = [];
	for (const record of payload.split("\n\n")) {
		const dataLines = [];
		for (const line of record.split("\n")) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		const joined = dataLines.join("\n");
		if (!joined || joined === "[DONE]") continue;
		try {
			messages.push(JSON.parse(joined));
		} catch {
			// One unreadable frame must not lose the rest.
		}
	}
	return messages;
}

function createHttpTransport(config = {}, handlers = {}) {
	const { url, headers = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = config;
	const { onMessage, onClose, onLog } = handlers;

	let closed = false;
	const inFlight = new Set();

	function finish(reason) {
		if (closed) return;
		closed = true;
		for (const request of inFlight) {
			try {
				request.destroy();
			} catch {
				// Already gone.
			}
		}
		inFlight.clear();
		onClose?.({ code: null, signal: null, reason, stderr: [] });
	}

	function start() {
		if (!url) {
			finish("No server URL configured.");
			return false;
		}
		try {
			// Validated once, up front: a malformed URL should fail at connect
			// time with a clear reason, not on the first tool call.
			void new URL(url);
		} catch {
			finish(`"${url}" is not a valid URL.`);
			return false;
		}
		return true;
	}

	function send(message) {
		if (closed) {
			return false;
		}
		let target;
		try {
			target = new URL(url);
		} catch {
			return false;
		}
		const body = JSON.stringify(message);
		const client = target.protocol === "http:" ? http : https;

		const request = client.request(
			{
				method: "POST",
				hostname: target.hostname,
				port: target.port || (target.protocol === "http:" ? 80 : 443),
				path: target.pathname + target.search,
				headers: {
					"Content-Type": "application/json",
					// Both are advertised: a server may answer either way, and the
					// reader below handles both.
					Accept: "application/json, text/event-stream",
					...headers,
					"Content-Length": Buffer.byteLength(body),
				},
				timeout: timeoutMs,
			},
			(response) => {
				const contentType = String(response.headers["content-type"] || "");
				let payload = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					payload += chunk;
				});
				response.on("end", () => {
					inFlight.delete(request);
					if (closed) {
						return; // A late reply to a transport nobody is listening to.
					}
					const status = response.statusCode || 0;
					if (status < 200 || status >= 300) {
						onLog?.({ stream: "http", line: `HTTP ${status}: ${payload.slice(0, 300)}` });
						return;
					}
					const messages = contentType.includes("text/event-stream")
						? parseSseForMessages(payload)
						: safeParseSingle(payload);
					for (const parsed of messages) {
						onMessage?.(parsed);
					}
				});
				response.on("error", () => inFlight.delete(request));
			},
		);

		inFlight.add(request);
		request.on("timeout", () => {
			inFlight.delete(request);
			request.destroy();
			onLog?.({ stream: "http", line: "The request timed out." });
		});
		request.on("error", (error) => {
			inFlight.delete(request);
			if (!closed) {
				onLog?.({ stream: "http", line: error.message });
			}
		});
		request.write(body);
		request.end();
		return true;
	}

	function safeParseSingle(payload) {
		if (!payload.trim()) {
			return []; // A notification's empty 202.
		}
		try {
			const parsed = JSON.parse(payload);
			// A server may batch responses into an array.
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			onLog?.({ stream: "http", line: "The server sent a response that could not be read." });
			return [];
		}
	}

	return {
		kind: "http",
		start,
		send,
		close: () => finish("Closed."),
		isClosed: () => closed,
		stderr: () => [],
		_parseSseForMessages: parseSseForMessages,
	};
}

module.exports = { createHttpTransport, parseSseForMessages, DEFAULT_REQUEST_TIMEOUT_MS };
