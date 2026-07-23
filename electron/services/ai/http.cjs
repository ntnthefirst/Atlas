"use strict";

// ---------------------------------------------------------------------------
// The two HTTP shapes every AI provider needs (WP-4.1): one JSON round trip,
// and one server-sent-events stream. Lifted out of electron/ai.cjs so the
// provider modules under ./providers/ contain only the part that is actually
// provider-specific -- the request body, the auth header, and how to read the
// answer -- and never a fourth copy of Node's https plumbing.
//
// -- Errors carry the provider's own message ---------------------------------
// A failed AI call is nearly always something the user can act on (a bad key,
// an unknown model, a rate limit), and the provider already says which in the
// response body. Both functions dig that message out and throw it, rather than
// throwing "HTTP 400" and making the user guess.
//
// -- The stream parser is deliberately dumb ----------------------------------
// `requestSse` knows about the SSE framing (blank-line-separated records,
// `data:` prefixes, the `[DONE]` sentinel) and nothing whatsoever about what
// the JSON inside means. Each provider passes its own `onEvent` to interpret
// its own deltas -- so adding a provider with a different event vocabulary
// needs no change here.
// ---------------------------------------------------------------------------

const https = require("node:https");

const DEFAULT_TIMEOUT_MS = 60_000;
// Streams legitimately stay open far longer than a single completion, but not
// forever -- an idle socket that never ends would hang a caller indefinitely.
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

function extractErrorMessage(payload, status) {
	let json = null;
	try {
		json = payload ? JSON.parse(payload) : null;
	} catch {
		// Non-JSON body; fall through to the raw text below.
	}
	const fromJson = json && json.error && (json.error.message || json.error);
	if (typeof fromJson === "string" && fromJson) {
		return fromJson;
	}
	if (payload) {
		return payload.slice(0, 300);
	}
	return `HTTP ${status}`;
}

function buildRequestOptions(url, { method, headers, bodyLength }) {
	const target = new URL(url);
	return {
		method,
		hostname: target.hostname,
		path: target.pathname + target.search,
		headers: {
			"Content-Type": "application/json",
			...headers,
			...(bodyLength ? { "Content-Length": bodyLength } : {}),
		},
	};
}

/** One JSON request, one JSON answer. */
function requestJson(url, { method = "POST", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const request = https.request(
			{
				...buildRequestOptions(url, { method, headers, bodyLength: data ? Buffer.byteLength(data) : 0 }),
				timeout: timeoutMs,
			},
			(response) => {
				let payload = "";
				response.on("data", (chunk) => {
					payload += chunk;
				});
				response.on("end", () => {
					const status = response.statusCode || 0;
					if (status < 200 || status >= 300) {
						reject(new Error(extractErrorMessage(payload, status)));
						return;
					}
					try {
						resolve(payload ? JSON.parse(payload) : {});
					} catch {
						reject(new Error("The provider returned a response that could not be read."));
					}
				});
			},
		);
		request.on("timeout", () => request.destroy(new Error("The request timed out.")));
		request.on("error", reject);
		if (data) request.write(data);
		request.end();
	});
}

/**
 * One request, many events. `onEvent(parsed)` is called once per `data:`
 * record with the parsed JSON; the `[DONE]` sentinel and any unparsable record
 * are swallowed rather than surfaced, because a single malformed frame should
 * not lose a response that is otherwise arriving fine.
 *
 * Resolves once the stream ends. Streams carry their errors in the HTTP status
 * like any other request, so a non-2xx response is drained and rejected with
 * the provider's own message rather than being parsed as events.
 */
function requestSse(url, { method = "POST", headers = {}, body, onEvent, timeoutMs = DEFAULT_STREAM_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const request = https.request(
			{
				...buildRequestOptions(url, {
					method,
					headers: { Accept: "text/event-stream", ...headers },
					bodyLength: data ? Buffer.byteLength(data) : 0,
				}),
				timeout: timeoutMs,
			},
			(response) => {
				const status = response.statusCode || 0;
				if (status < 200 || status >= 300) {
					let payload = "";
					response.on("data", (chunk) => {
						payload += chunk;
					});
					response.on("end", () => reject(new Error(extractErrorMessage(payload, status))));
					return;
				}

				let buffer = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					buffer += chunk;
					// SSE records are separated by a blank line. Anything after the
					// last separator is a partial record and stays in the buffer.
					let separator = buffer.indexOf("\n\n");
					while (separator !== -1) {
						const record = buffer.slice(0, separator);
						buffer = buffer.slice(separator + 2);
						handleRecord(record, onEvent);
						separator = buffer.indexOf("\n\n");
					}
				});
				response.on("end", () => {
					// A final record with no trailing blank line still counts.
					if (buffer.trim()) {
						handleRecord(buffer, onEvent);
					}
					resolve();
				});
				response.on("error", reject);
			},
		);
		request.on("timeout", () => request.destroy(new Error("The request timed out.")));
		request.on("error", reject);
		if (data) request.write(data);
		request.end();
	});
}

// Exported for its own tests: the framing rules are fiddly enough (multi-line
// records, `data:` with and without a leading space, comment lines, the
// sentinel) to be worth testing without a socket.
function handleRecord(record, onEvent) {
	const dataLines = [];
	for (const line of record.split("\n")) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
		// Every other field (`event:`, `id:`, `retry:`, `:` comments) is
		// deliberately ignored -- no provider here needs them, and guessing at
		// them would be inventing behaviour.
	}
	if (dataLines.length === 0) {
		return;
	}
	const payload = dataLines.join("\n");
	if (!payload || payload === "[DONE]") {
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return; // One bad frame never loses the rest of the stream.
	}
	if (typeof onEvent === "function") {
		onEvent(parsed);
	}
}

module.exports = { requestJson, requestSse, handleRecord, extractErrorMessage };
