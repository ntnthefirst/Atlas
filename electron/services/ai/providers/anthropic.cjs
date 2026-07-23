"use strict";

// ---------------------------------------------------------------------------
// Anthropic (Claude) -- WP-4.1.
//
// Self-describing: ../registry.cjs discovers this file by scanning the
// directory, so nothing outside this module names it. Everything
// Anthropic-specific lives here -- the auth header, the `content` block
// vocabulary, and the streaming event names -- and nothing else in Atlas
// branches on "is this Anthropic".
// ---------------------------------------------------------------------------

// The transport is an INJECTED seam (`transport` on each call, defaulting to
// this module), the same convention the rest of this codebase uses for timers,
// clocks and database handles. Module mocking was tried first and silently
// failed to bind under vitest's CJS interop -- which made the streaming tests
// pass while quietly making real network calls to OpenAI and Google. An
// explicit parameter cannot fail that way.
const http = require("../http.cjs");
const { normalizeResult, normalizeToolSpec } = require("../contract.cjs");

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

function headersFor(key) {
	return { "x-api-key": key, "anthropic-version": API_VERSION };
}

function buildBody({ model, system, prompt, maxTokens, tools }) {
	const body = {
		model,
		max_tokens: maxTokens,
		messages: [{ role: "user", content: prompt }],
	};
	if (system) {
		body.system = system;
	}
	const specs = normalizeToolSpec(tools);
	if (specs.length > 0) {
		// Anthropic calls the schema `input_schema`; the canonical spec calls it
		// `parameters`. This one line is the whole difference.
		body.tools = specs.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}
	return body;
}

// Anthropic answers with a list of typed content blocks: `text` blocks make up
// the prose, `tool_use` blocks are the calls it wants made.
function readContentBlocks(blocks) {
	const text = [];
	const toolCalls = [];
	for (const block of Array.isArray(blocks) ? blocks : []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			text.push(block.text);
		} else if (block.type === "tool_use") {
			toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
		}
	}
	return { text: text.join(""), toolCalls };
}

async function complete({ key, model, system, prompt, maxTokens, tools, transport = http }) {
	const json = await transport.requestJson(ENDPOINT, {
		headers: headersFor(key),
		body: buildBody({ model, system, prompt, maxTokens, tools }),
	});
	const { text, toolCalls } = readContentBlocks(json.content);
	return normalizeResult({ text, toolCalls, finishReason: json.stop_reason });
}

async function stream({ key, model, system, prompt, maxTokens, tools, onChunk, transport = http }) {
	let text = "";
	const toolCalls = [];
	// Anthropic streams a tool call's arguments as a series of partial JSON
	// strings against a block index, so they have to be accumulated per index
	// and parsed only once the block stops.
	const partialToolInput = new Map();
	let finishReason = null;

	await transport.requestSse(ENDPOINT, {
		headers: headersFor(key),
		body: { ...buildBody({ model, system, prompt, maxTokens, tools }), stream: true },
		onEvent: (event) => {
			if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
				partialToolInput.set(event.index, {
					id: event.content_block.id,
					name: event.content_block.name,
					json: "",
				});
			} else if (event.type === "content_block_delta") {
				if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
					text += event.delta.text;
					if (typeof onChunk === "function") onChunk(event.delta.text);
				} else if (event.delta?.type === "input_json_delta") {
					const pending = partialToolInput.get(event.index);
					if (pending) pending.json += event.delta.partial_json || "";
				}
			} else if (event.type === "content_block_stop") {
				const pending = partialToolInput.get(event.index);
				if (pending) {
					toolCalls.push({ id: pending.id, name: pending.name, arguments: pending.json || "{}" });
					partialToolInput.delete(event.index);
				}
			} else if (event.type === "message_delta" && event.delta?.stop_reason) {
				finishReason = event.delta.stop_reason;
			}
		},
	});

	return normalizeResult({ text, toolCalls, finishReason });
}

module.exports = {
	id: "anthropic",
	label: "Claude (Anthropic)",
	defaultModel: "claude-sonnet-5",
	capabilities: { streaming: true, tools: true },
	complete,
	stream,
	// Exported for tests: the block/event readers are the fiddly part, and they
	// are worth exercising against recorded payloads without a socket.
	readContentBlocks,
	buildBody,
};
