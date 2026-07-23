"use strict";

// ---------------------------------------------------------------------------
// One MCP server connection (WP-4.3): the handshake, request correlation,
// timeouts, tool listing and tool invocation. Transport-agnostic -- it is
// handed something with `start/send/close` and never asks which kind it is.
//
// -- Every pending request has a timeout, without exception -------------------
// This is the module that makes "a server crash or hang is contained" true.
// A request is registered with a timer before it is sent; if the answer does
// not arrive the promise REJECTS rather than sitting there, and the pending
// entry is removed so a late reply cannot resolve something nobody is waiting
// on. When the transport closes, every outstanding request is rejected at once
// with the reason the connection ended.
//
// There is deliberately no code path here that awaits anything without a
// deadline. A hung server therefore costs one failed call, not a wedged app.
//
// -- Connect is itself timed --------------------------------------------------
// The `initialize` handshake uses the same mechanism, so a server that starts
// and then never speaks fails to connect in bounded time instead of leaving
// the connection in a permanent "connecting" state.
//
// -- Why the client never restarts on its own --------------------------------
// A crashed server stays crashed until something explicit reconnects it (see
// ./manager.cjs). Automatic restarts would turn a server that crashes on
// startup into an infinite spawn loop, which is a worse failure than being
// offline -- and the user can see, and fix, "not connected".
// ---------------------------------------------------------------------------

const {
	buildInitializeRequest,
	buildNotification,
	buildRequest,
	flattenToolResult,
	interpretResponse,
	isResponse,
	toolToSpec,
} = require("./protocol.cjs");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const STATE = Object.freeze({
	IDLE: "idle",
	CONNECTING: "connecting",
	READY: "ready",
	FAILED: "failed",
	CLOSED: "closed",
});

/**
 * `deps.createTransport(config, handlers)` builds the transport. Injected so a
 * test can drive a fake one directly -- there is no module mocking anywhere in
 * this package, for the reasons WP-4.1's provider tests recorded the hard way.
 */
function createMcpClient(config = {}, deps = {}) {
	const createTransport = deps.createTransport;
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimeout ?? setTimeout;
	const clearTimer = deps.clearTimeout ?? clearTimeout;
	const requestTimeoutMs = Number.isFinite(config.requestTimeoutMs)
		? config.requestTimeoutMs
		: DEFAULT_REQUEST_TIMEOUT_MS;
	const connectTimeoutMs = Number.isFinite(config.connectTimeoutMs)
		? config.connectTimeoutMs
		: DEFAULT_CONNECT_TIMEOUT_MS;

	let transport = null;
	let state = STATE.IDLE;
	let lastError = null;
	let serverInfo = null;
	let nextId = 0;
	let tools = [];
	const pending = new Map();
	const logs = [];

	function rememberLog(entry) {
		logs.push({ ...entry, at: now() });
		if (logs.length > 100) {
			logs.shift();
		}
	}

	// Rejects every outstanding request. Called on close and on failure, so no
	// caller is ever left holding a promise that can never settle.
	function rejectAllPending(reason) {
		for (const [, entry] of pending) {
			clearTimer(entry.timer);
			entry.reject(new Error(reason));
		}
		pending.clear();
	}

	function handleMessage(message) {
		if (!isResponse(message)) {
			// Server-initiated requests and notifications. Atlas declares no
			// capabilities that would prompt one, so there is nothing to answer;
			// recorded for diagnostics rather than silently dropped.
			rememberLog({ stream: "protocol", line: `Unsolicited ${message?.method ?? "message"}` });
			return;
		}
		const entry = pending.get(message.id);
		if (!entry) {
			// A reply to something that already timed out.
			return;
		}
		pending.delete(message.id);
		clearTimer(entry.timer);
		entry.resolve(interpretResponse(message));
	}

	function handleClose(info) {
		const wasReady = state === STATE.READY;
		const wasAlreadyFailed = state === STATE.FAILED;
		state = state === STATE.CLOSED ? STATE.CLOSED : STATE.FAILED;
		if (info?.reason) {
			// A connection that has ALREADY failed for a specific reason keeps
			// that reason. Closing the transport afterwards is our own cleanup,
			// and letting its generic "Closed." overwrite "Unsupported protocol
			// version" would replace the only useful diagnosis with a tautology.
			if (!wasAlreadyFailed || !lastError) {
				lastError = info.reason;
			}
			rememberLog({ stream: "lifecycle", line: info.reason });
		}
		for (const line of info?.stderr ?? []) {
			rememberLog({ stream: "stderr", line });
		}
		rejectAllPending(info?.reason || "The server connection closed.");
		if (wasReady) {
			tools = [];
		}
	}

	/** Sends a request and resolves with the interpreted response, or rejects on timeout. */
	function call(method, params, timeoutMs = requestTimeoutMs) {
		return new Promise((resolve, reject) => {
			if (!transport || transport.isClosed()) {
				reject(new Error("Not connected."));
				return;
			}
			const id = ++nextId;
			// Registered BEFORE sending: a server fast enough to answer
			// synchronously must find its entry already there.
			const timer = setTimer(() => {
				pending.delete(id);
				reject(new Error(`The server did not answer "${method}" in time.`));
			}, timeoutMs);
			timer.unref?.();
			pending.set(id, { resolve, reject, timer, method });

			if (!transport.send(buildRequest(id, method, params))) {
				pending.delete(id);
				clearTimer(timer);
				reject(new Error("The server connection is not writable."));
			}
		});
	}

	async function connect() {
		if (state === STATE.CONNECTING || state === STATE.READY) {
			return { ok: state === STATE.READY, state };
		}
		if (typeof createTransport !== "function") {
			state = STATE.FAILED;
			lastError = "No transport available for this server.";
			return { ok: false, state, error: lastError };
		}

		state = STATE.CONNECTING;
		lastError = null;
		transport = createTransport(config, {
			onMessage: handleMessage,
			onClose: handleClose,
			onLog: rememberLog,
		});

		if (!transport.start()) {
			state = STATE.FAILED;
			return { ok: false, state, error: lastError ?? "The server could not be started." };
		}

		try {
			const response = await new Promise((resolve, reject) => {
				const id = ++nextId;
				const timer = setTimer(() => {
					pending.delete(id);
					reject(new Error("The server did not complete the handshake in time."));
				}, connectTimeoutMs);
				timer.unref?.();
				pending.set(id, { resolve, reject, timer, method: "initialize" });
				if (!transport.send(buildInitializeRequest(id))) {
					pending.delete(id);
					clearTimer(timer);
					reject(new Error("The server connection is not writable."));
				}
			});

			if (response.kind !== "result") {
				throw new Error(response.message || "The server refused the handshake.");
			}
			serverInfo = response.value?.serverInfo ?? null;
			// MCP requires this notification once initialize succeeds.
			transport.send(buildNotification("notifications/initialized"));
			state = STATE.READY;
			return { ok: true, state, serverInfo };
		} catch (error) {
			// Captured BEFORE closing: close() fires onClose, and reading
			// `lastError` afterwards would return the cleanup's reason rather
			// than the failure's.
			const reason = error.message;
			lastError = reason;
			state = STATE.FAILED;
			// The transport may still be alive (a slow server that eventually
			// answers) -- close it, so a half-connected server is never left
			// running with nobody reading it.
			try {
				transport.close();
			} catch {
				// Already gone.
			}
			return { ok: false, state, error: reason };
		}
	}

	async function listTools() {
		if (state !== STATE.READY) {
			return { ok: false, error: lastError ?? "Not connected.", tools: [] };
		}
		try {
			const response = await call("tools/list");
			if (response.kind !== "result") {
				return { ok: false, error: response.message ?? "The server refused to list its tools.", tools: [] };
			}
			const listed = Array.isArray(response.value?.tools) ? response.value.tools : [];
			tools = listed
				.map((tool) => {
					const spec = toolToSpec(config.id, tool);
					return spec ? { ...spec, serverId: config.id, rawName: tool.name } : null;
				})
				.filter((tool) => tool !== null);
			return { ok: true, tools: [...tools] };
		} catch (error) {
			return { ok: false, error: error.message, tools: [] };
		}
	}

	/** `toolName` is the server's OWN name, not the qualified one. */
	async function callTool(toolName, args) {
		if (state !== STATE.READY) {
			return { ok: false, error: lastError ?? "Not connected." };
		}
		try {
			const response = await call("tools/call", { name: toolName, arguments: args ?? {} });
			if (response.kind !== "result") {
				return { ok: false, error: response.message ?? "The tool call failed." };
			}
			const { text, isError } = flattenToolResult(response.value);
			// `isError` is a normal outcome the model should hear about, not a
			// transport failure -- so `ok` stays true and the flag is carried.
			return { ok: true, text, isError };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	}

	function close() {
		state = STATE.CLOSED;
		rejectAllPending("The server connection was closed.");
		tools = [];
		try {
			transport?.close();
		} catch {
			// Already gone.
		}
	}

	function getStatus() {
		return {
			id: config.id ?? null,
			state,
			error: lastError,
			serverInfo,
			toolCount: tools.length,
			pendingCount: pending.size,
		};
	}

	return {
		connect,
		listTools,
		callTool,
		close,
		getStatus,
		getTools: () => [...tools],
		getLogs: () => [...logs],
	};
}

module.exports = { createMcpClient, STATE, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS };
