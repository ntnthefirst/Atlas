"use strict";

// ---------------------------------------------------------------------------
// A minimal, real MCP server used by transports.test.js to satisfy WP-4.3's
// first acceptance criterion: "connects to a reference MCP server over both
// transports". Nothing else in Atlas requires this file.
//
// It implements exactly the three methods the client uses -- `initialize`,
// `tools/list`, `tools/call` -- plus the `notifications/initialized`
// notification it must accept and not answer. It is deliberately real rather
// than a stub: run as a child process it exercises spawning, stdio piping and
// newline framing for real, and served over HTTP it exercises the actual
// request/response path. A fake in-process object would prove none of that.
//
// Two behaviours exist purely so the tests can exercise the difficult paths:
//   - the `hang` tool never answers, so a hung server can be tested without
//     waiting for a real one to misbehave;
//   - `--noise` makes it print a non-JSON banner to stdout first, which is
//     what real servers do and what the framer has to survive.
// ---------------------------------------------------------------------------

const TOOLS = [
	{
		name: "echo",
		description: "Returns whatever it is given.",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	{
		name: "fail",
		description: "Always reports a tool-level failure.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "hang",
		description: "Never answers.",
		inputSchema: { type: "object", properties: {} },
	},
];

/**
 * Handles one JSON-RPC message. Returns the response, or `null` for a
 * notification (nothing to send) and for `hang` (deliberately no answer).
 */
function handleMessage(message) {
	if (!message || typeof message !== "object") {
		return null;
	}
	const { id, method, params } = message;

	if (method === "notifications/initialized") {
		return null;
	}

	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "atlas-reference-server", version: "1.0.0" },
			},
		};
	}

	if (method === "tools/list") {
		return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
	}

	if (method === "tools/call") {
		const name = params?.name;
		if (name === "hang") {
			return null;
		}
		if (name === "fail") {
			return {
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: "that did not work" }], isError: true },
			};
		}
		if (name === "echo") {
			return {
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: String(params?.arguments?.text ?? "") }] },
			};
		}
		return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
	}

	return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

// -- stdio mode: only when run directly as a child process -------------------
if (require.main === module) {
	if (process.argv.includes("--noise")) {
		// Exactly the sort of thing a real server logs to stdout before it
		// starts speaking protocol.
		process.stdout.write("reference server starting up\n");
	}

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				let parsed = null;
				try {
					parsed = JSON.parse(line);
				} catch {
					parsed = null;
				}
				const response = parsed ? handleMessage(parsed) : null;
				if (response) {
					process.stdout.write(`${JSON.stringify(response)}\n`);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

module.exports = { handleMessage, TOOLS };
