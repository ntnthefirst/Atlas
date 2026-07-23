import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient } from "./client.cjs";
import { createStdioTransport } from "./transport-stdio.cjs";
import { createHttpTransport, parseSseForMessages } from "./transport-http.cjs";
import referenceServer from "./__fixtures__/reference-server.cjs";

// ---------------------------------------------------------------------------
// WP-4.3's first acceptance criterion: "connects to a reference MCP server
// over both transports."
//
// These are real: the stdio tests spawn an actual child process and speak
// newline-framed JSON over its pipes, and the HTTP tests run an actual server
// on localhost. Nothing is faked, because the point is to exercise spawning,
// piping, framing and sockets -- an in-process stub would prove none of it.
//
// The only network involved is 127.0.0.1 on an ephemeral port.
// ---------------------------------------------------------------------------

const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "reference-server.cjs");

const openClients = [];
const openServers = [];

afterEach(async () => {
	while (openClients.length > 0) {
		try {
			openClients.pop().close();
		} catch {
			// Already gone.
		}
	}
	while (openServers.length > 0) {
		const server = openServers.pop();
		await new Promise((resolve) => server.close(resolve));
	}
});

function stdioClient(args = [], config = {}) {
	const client = createMcpClient(
		{
			id: "ref",
			command: process.execPath,
			args: [SERVER_PATH, ...args],
			connectTimeoutMs: 10_000,
			requestTimeoutMs: 10_000,
			...config,
		},
		{ createTransport: (transportConfig, handlers) => createStdioTransport(transportConfig, handlers) },
	);
	openClients.push(client);
	return client;
}

/** Serves the reference server's message handler over real HTTP. */
async function startHttpServer({ asSse = false } = {}) {
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = null;
			}
			const result = parsed ? referenceServer.handleMessage(parsed) : null;
			if (!result) {
				response.writeHead(202).end();
				return;
			}
			if (asSse) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end(`data: ${JSON.stringify(result)}\n\n`);
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(result));
		});
	});
	openServers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${server.address().port}/mcp`;
}

function httpClient(url, config = {}) {
	const client = createMcpClient(
		{ id: "ref", url, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000, ...config },
		{ createTransport: (transportConfig, handlers) => createHttpTransport(transportConfig, handlers) },
	);
	openClients.push(client);
	return client;
}

describe("stdio transport against a real child process", () => {
	it("connects, discovers tools and calls one", async () => {
		const client = stdioClient();

		const connected = await client.connect();
		expect(connected.ok).toBe(true);
		expect(connected.serverInfo.name).toBe("atlas-reference-server");

		const listed = await client.listTools();
		expect(listed.ok).toBe(true);
		expect(listed.tools.map((tool) => tool.name)).toContain("ref__echo");

		const called = await client.callTool("echo", { text: "hello over stdio" });
		expect(called).toMatchObject({ ok: true, text: "hello over stdio", isError: false });
	});

	// Real servers print banners to stdout. The framer has to survive it.
	it("survives a server that logs non-JSON to stdout before speaking protocol", async () => {
		const client = stdioClient(["--noise"]);

		const connected = await client.connect();
		expect(connected.ok).toBe(true);
		expect((await client.callTool("echo", { text: "still fine" })).text).toBe("still fine");
	});

	it("reports a tool-level failure as a normal outcome", async () => {
		const client = stdioClient();
		await client.connect();

		const result = await client.callTool("fail", {});
		expect(result.ok).toBe(true);
		expect(result.isError).toBe(true);
	});

	// THE containment criterion, against a genuinely unresponsive server.
	it("times out a real hung call and stays usable", async () => {
		const client = stdioClient([], { requestTimeoutMs: 300 });
		await client.connect();

		const hung = await client.callTool("hang", {});
		expect(hung.ok).toBe(false);
		expect(hung.error).toMatch(/in time/i);

		// The process is alive and the connection still works.
		expect((await client.callTool("echo", { text: "recovered" })).text).toBe("recovered");
	});

	it("reports a command that does not exist, rather than hanging or throwing", async () => {
		const client = createMcpClient(
			{ id: "ref", command: "atlas-no-such-binary-hopefully", args: [], connectTimeoutMs: 3000 },
			{ createTransport: (config, handlers) => createStdioTransport(config, handlers) },
		);
		openClients.push(client);

		const result = await client.connect();
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("kills the child process on close", async () => {
		const client = stdioClient();
		await client.connect();

		client.close();

		// A closed connection refuses further work rather than hanging.
		expect((await client.callTool("echo", { text: "x" })).ok).toBe(false);
	});
});

describe("http transport against a real server", () => {
	it("connects, discovers tools and calls one over JSON", async () => {
		const client = httpClient(await startHttpServer());

		const connected = await client.connect();
		expect(connected.ok).toBe(true);
		expect(connected.serverInfo.name).toBe("atlas-reference-server");

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toContain("ref__echo");

		expect((await client.callTool("echo", { text: "hello over http" })).text).toBe("hello over http");
	});

	// MCP servers may answer a POST with an SSE stream instead of a JSON body.
	it("reads a response delivered as server-sent events", async () => {
		const client = httpClient(await startHttpServer({ asSse: true }));

		expect((await client.connect()).ok).toBe(true);
		expect((await client.callTool("echo", { text: "over sse" })).text).toBe("over sse");
	});

	it("reports a refused connection rather than hanging", async () => {
		// Port 1 on localhost: nothing listens there.
		const client = httpClient("http://127.0.0.1:1/mcp", { connectTimeoutMs: 2000 });

		const result = await client.connect();
		expect(result.ok).toBe(false);
	});

	it("refuses a malformed URL at connect time, not on the first call", async () => {
		const client = httpClient("not a url");
		const result = await client.connect();
		expect(result.ok).toBe(false);
	});
});

describe("SSE frame parsing", () => {
	it("reads one message per record and ignores the sentinel", () => {
		expect(parseSseForMessages('data: {"id":1}\n\ndata: [DONE]\n\ndata: {"id":2}\n\n')).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it("skips an unreadable frame without losing the rest", () => {
		expect(parseSseForMessages('data: {broken\n\ndata: {"id":2}\n\n')).toEqual([{ id: 2 }]);
	});
});
