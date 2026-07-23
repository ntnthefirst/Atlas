"use strict";

// ---------------------------------------------------------------------------
// MCP over stdio (WP-4.3): the server is a child process, messages are
// newline-delimited JSON on its stdin/stdout.
//
// -- Containment is this file's real job -------------------------------------
// "A server crash or hang is contained -- Atlas stays responsive" is an
// acceptance criterion, and a child process is the most dangerous thing in
// this whole package. Four things enforce it:
//
//   1. Nothing here is ever awaited without a timeout. That lives in
//      ./client.cjs, which owns request correlation -- but this module must
//      never introduce a promise that can hang, which is why `send` is
//      fire-and-forget and returns nothing.
//   2. stderr is drained and kept as a bounded ring, never accumulated. A
//      chatty server must not grow Atlas's memory, and its last words are
//      exactly what you want when diagnosing why it died.
//   3. `close` escalates: a polite kill, then SIGKILL after a grace period, so
//      a process ignoring SIGTERM cannot keep Atlas alive at quit.
//   4. Spawn failure is reported through `onClose`, not thrown, so a missing
//      binary looks the same to the caller as a server that died -- one
//      failure path instead of two.
//
// -- `shell: false`, always ---------------------------------------------------
// The command and args come from user configuration, and running them through
// a shell would make a server entry a shell-injection surface for anything
// that can write that config. The cost is that shell built-ins are not
// available as commands, which is correct: an MCP server is an executable.
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const { createLineFramer } = require("./protocol.cjs");

const DEFAULT_KILL_GRACE_MS = 2000;
const STDERR_RING_LINES = 50;

/**
 * `onMessage(parsed)` receives every complete JSON message.
 * `onClose({ code, signal, reason })` fires exactly once, whether the process
 * exited, failed to spawn, or was closed deliberately.
 */
function createStdioTransport(config = {}, handlers = {}) {
	const { command, args = [], env = {}, cwd = null } = config;
	const { onMessage, onClose, onLog } = handlers;

	let child = null;
	let closed = false;
	const stderrRing = [];

	const framer = createLineFramer({
		onMessage: (message) => onMessage?.(message),
		// Servers log to stdout more often than they should; keep it as
		// diagnostics rather than treating it as a protocol violation.
		onJunk: (line) => onLog?.({ stream: "stdout", line }),
	});

	function rememberStderr(text) {
		for (const line of String(text).split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			stderrRing.push(trimmed);
			if (stderrRing.length > STDERR_RING_LINES) {
				stderrRing.shift();
			}
			onLog?.({ stream: "stderr", line: trimmed });
		}
	}

	function finish(reason, code = null, signal = null) {
		if (closed) {
			return;
		}
		closed = true;
		onClose?.({ code, signal, reason, stderr: [...stderrRing] });
	}

	function start() {
		try {
			child = spawn(command, args, {
				// See the header: never a shell.
				shell: false,
				cwd: cwd || undefined,
				// The server's own env plus whatever the config adds. Inherited
				// rather than replaced, because most servers need PATH at minimum.
				env: { ...process.env, ...env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			finish(`Could not start the server: ${error.message}`);
			return false;
		}

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => framer.push(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", rememberStderr);

		// A missing binary surfaces here, not as a throw from spawn().
		child.on("error", (error) => finish(`The server could not be run: ${error.message}`));
		child.on("exit", (code, signal) =>
			finish(signal ? `The server was stopped (${signal}).` : `The server exited with code ${code}.`, code, signal),
		);
		// An EPIPE from writing to a dead process must not become an unhandled
		// error event.
		child.stdin.on("error", () => {});
		return true;
	}

	function send(message) {
		if (closed || !child || !child.stdin.writable) {
			return false;
		}
		try {
			child.stdin.write(`${JSON.stringify(message)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	function close({ graceMs = DEFAULT_KILL_GRACE_MS } = {}) {
		if (!child || closed) {
			finish("Closed.");
			return;
		}
		try {
			child.stdin.end();
			child.kill();
		} catch {
			// Already gone.
		}
		// Escalation: a server that ignores the polite signal must not be able
		// to keep Atlas from quitting.
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}, graceMs);
		// Never hold the event loop open on this timer.
		timer.unref?.();
		finish("Closed.");
	}

	return {
		kind: "stdio",
		start,
		send,
		close,
		isClosed: () => closed,
		stderr: () => [...stderrRing],
		/** Test seam: the framer is a pure state machine worth driving directly. */
		_framer: framer,
	};
}

module.exports = { createStdioTransport, DEFAULT_KILL_GRACE_MS, STDERR_RING_LINES };
