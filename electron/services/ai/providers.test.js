import { describe, expect, it, vi } from "vitest";
import anthropic from "./providers/anthropic.cjs";
import openai from "./providers/openai.cjs";
import google from "./providers/google.cjs";
import http from "./http.cjs";

const { handleRecord } = http;

// NOTHING in this file may touch the network. Each streaming test passes an
// explicit `transport`, which is why: module mocking was tried first, silently
// failed to bind under vitest's CJS interop, and produced tests that passed
// while making real requests to OpenAI and Google. An injected parameter
// cannot fail that way, and `streamWith` asserts it was actually used.

// ---------------------------------------------------------------------------
// The provider modules (WP-4.1), tested against recorded response shapes
// rather than a socket. What is worth pinning down is the translation in both
// directions: the canonical tool spec into each vendor's wire format, and each
// vendor's very different answer back into the one normalized result.
//
// The streaming reassembly is the fiddliest part by a distance -- Anthropic
// streams tool arguments as partial JSON against a block index, OpenAI streams
// them as string fragments against a call index -- so both are exercised
// through the real SSE record parser.
// ---------------------------------------------------------------------------

const TOOL = { name: "createTask", description: "Adds a task", parameters: { type: "object", properties: {} } };

describe("request bodies -- the canonical tool spec into three wire formats", () => {
	it("Anthropic renames the schema to input_schema", () => {
		const body = anthropic.buildBody({ model: "m", prompt: "hi", maxTokens: 100, tools: [TOOL] });
		expect(body.tools).toEqual([
			{ name: "createTask", description: "Adds a task", input_schema: { type: "object", properties: {} } },
		]);
	});

	it("OpenAI wraps each tool in a function envelope", () => {
		const body = openai.buildBody({ model: "m", prompt: "hi", tools: [TOOL] });
		expect(body.tools[0].type).toBe("function");
		expect(body.tools[0].function.name).toBe("createTask");
		expect(body.tools[0].function.parameters).toEqual({ type: "object", properties: {} });
	});

	it("Google nests them under a single functionDeclarations entry", () => {
		const body = google.buildBody({ prompt: "hi", tools: [TOOL] });
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].functionDeclarations[0].name).toBe("createTask");
	});

	it("none of them send a tools field when there are no tools", () => {
		expect(anthropic.buildBody({ model: "m", prompt: "hi", maxTokens: 1 }).tools).toBeUndefined();
		expect(openai.buildBody({ model: "m", prompt: "hi" }).tools).toBeUndefined();
		expect(google.buildBody({ prompt: "hi" }).tools).toBeUndefined();
	});

	it("each carries the system prompt in its own field, and omits it when absent", () => {
		expect(anthropic.buildBody({ model: "m", prompt: "p", maxTokens: 1, system: "S" }).system).toBe("S");
		expect(openai.buildBody({ model: "m", prompt: "p", system: "S" }).messages[0]).toEqual({
			role: "system",
			content: "S",
		});
		expect(google.buildBody({ prompt: "p", system: "S" }).systemInstruction.parts[0].text).toBe("S");

		expect(anthropic.buildBody({ model: "m", prompt: "p", maxTokens: 1 }).system).toBeUndefined();
		expect(openai.buildBody({ model: "m", prompt: "p" }).messages).toHaveLength(1);
		expect(google.buildBody({ prompt: "p" }).systemInstruction).toBeUndefined();
	});
});

describe("reading answers -- three shapes, one result", () => {
	it("Anthropic: text blocks join, tool_use blocks become calls", () => {
		const { text, toolCalls } = anthropic.readContentBlocks([
			{ type: "text", text: "Sure, " },
			{ type: "text", text: "doing that." },
			{ type: "tool_use", id: "toolu_1", name: "createTask", input: { title: "Buy milk" } },
			{ type: "thinking", thinking: "ignored" },
		]);
		expect(text).toBe("Sure, doing that.");
		expect(toolCalls).toEqual([{ id: "toolu_1", name: "createTask", arguments: { title: "Buy milk" } }]);
	});

	it("OpenAI: content is the text, tool_calls carry stringified arguments", () => {
		const { text, toolCalls } = openai.readMessage({
			content: "On it.",
			tool_calls: [{ id: "call_1", function: { name: "createTask", arguments: '{"title":"Buy milk"}' } }],
		});
		expect(text).toBe("On it.");
		expect(toolCalls[0].arguments).toBe('{"title":"Buy milk"}');
	});

	it("Google: prose and calls come out of the same parts array", () => {
		const { text, toolCalls } = google.readParts([
			{ text: "Sure. " },
			{ functionCall: { name: "createTask", args: { title: "Buy milk" } } },
			{ text: "Done." },
		]);
		expect(text).toBe("Sure. Done.");
		expect(toolCalls[0].name).toBe("createTask");
	});

	it("all three survive a missing or malformed payload", () => {
		expect(anthropic.readContentBlocks(null)).toEqual({ text: "", toolCalls: [] });
		expect(openai.readMessage(undefined)).toEqual({ text: "", toolCalls: [] });
		expect(google.readParts("nope")).toEqual({ text: "", toolCalls: [] });
	});
});

describe("Google puts the key in the query string, url-encoded", () => {
	it("encodes both the model and the key", () => {
		const url = google.endpointFor("gemini/1.5", "generateContent", "key with spaces&more");
		expect(url).toContain("gemini%2F1.5");
		expect(url).toContain("key=key%20with%20spaces%26more");
	});
});

// ---------------------------------------------------------------------------
// SSE framing and streaming reassembly.
// ---------------------------------------------------------------------------

describe("SSE record parsing", () => {
	function collect(record) {
		const seen = [];
		handleRecord(record, (event) => seen.push(event));
		return seen;
	}

	it("reads a data line", () => {
		expect(collect('data: {"a":1}')).toEqual([{ a: 1 }]);
	});

	it("reads a data line with no space after the colon", () => {
		expect(collect('data:{"a":1}')).toEqual([{ a: 1 }]);
	});

	it("joins a multi-line data record", () => {
		expect(collect('data: {"a":\ndata: 1}')).toEqual([{ a: 1 }]);
	});

	it("ignores the [DONE] sentinel", () => {
		expect(collect("data: [DONE]")).toEqual([]);
	});

	it("ignores comments and other SSE fields", () => {
		expect(collect(": keep-alive")).toEqual([]);
		expect(collect("event: ping\nid: 7")).toEqual([]);
	});

	// One malformed frame must never lose a response that is otherwise fine.
	it("swallows an unparsable frame", () => {
		expect(collect("data: {not json")).toEqual([]);
	});
});

describe("streaming reassembly", () => {
	// Drives a provider's stream() with recorded events by replacing the SSE
	// transport, so the reassembly logic is exercised for real without a socket.
	async function streamWith(provider, events) {
		const chunks = [];
		const requestSse = vi.fn(async (_url, { onEvent }) => {
			for (const event of events) onEvent(event);
		});
		const result = await provider.stream({
			key: "k",
			model: "m",
			prompt: "p",
			maxTokens: 10,
			onChunk: (chunk) => chunks.push(chunk),
			// The injected seam. No module mocking, so there is nothing that can
			// silently fail to bind and let a test reach the internet.
			transport: {
				requestSse,
				requestJson: () => {
					throw new Error("stream() must not fall back to a non-streaming request");
				},
			},
		});
		expect(requestSse).toHaveBeenCalledOnce();
		return { result, chunks };
	}

	it("Anthropic: text deltas accumulate and are emitted as they arrive", async () => {
		const { result, chunks } = await streamWith(
			anthropic,
			[
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			],
		);

		expect(chunks).toEqual(["Hel", "lo"]);
		expect(result.text).toBe("Hello");
		expect(result.finishReason).toBe("end_turn");
	});

	it("Anthropic: a tool call's partial JSON is reassembled and parsed", async () => {
		const { result } = await streamWith(
			anthropic,
			[
				{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "createTask" } },
				{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"title":' } },
				{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Buy milk"}' } },
				{ type: "content_block_stop", index: 1 },
			],
		);

		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].arguments).toEqual({ title: "Buy milk" });
		expect(result.toolCalls[0].malformedArguments).toBe(false);
	});

	it("OpenAI: argument fragments are concatenated per call index", async () => {
		const { result, chunks } = await streamWith(
			openai,
			[
				{ choices: [{ delta: { content: "Wor" } }] },
				{ choices: [{ delta: { content: "king" } }] },
				{
					choices: [
						{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "createTask", arguments: '{"ti' } }] } },
					],
				},
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tle":"Buy milk"}' } }] } }] },
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			],
		);

		expect(chunks).toEqual(["Wor", "king"]);
		expect(result.text).toBe("Working");
		expect(result.toolCalls[0].arguments).toEqual({ title: "Buy milk" });
		expect(result.finishReason).toBe("tool_calls");
	});

	it("Google: each streamed candidate is read with the same parts reader", async () => {
		const { result, chunks } = await streamWith(
			google,
			[
				{ candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
				{ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }] },
			],
		);

		expect(chunks).toEqual(["Hel", "lo"]);
		expect(result.text).toBe("Hello");
		expect(result.finishReason).toBe("STOP");
		vi.restoreAllMocks();
	});
});
