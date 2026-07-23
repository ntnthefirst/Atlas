"use strict";

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible chat completions) -- WP-4.1.
//
// Self-describing, discovered by ../registry.cjs's directory scan. The two
// OpenAI-specific things worth knowing:
//
//   - tool arguments arrive as a JSON *string*, not an object, and are
//     streamed in fragments that must be concatenated per tool-call index
//     before they parse. ../contract.cjs#normalizeToolCall does the parsing,
//     so this module only has to get the reassembly right.
//   - a streamed response reports its finish reason on the last choice rather
//     than in a distinct event.
// ---------------------------------------------------------------------------

// The transport is an INJECTED seam (`transport` on each call, defaulting to
// this module), the same convention the rest of this codebase uses for timers,
// clocks and database handles. Module mocking was tried first and silently
// failed to bind under vitest's CJS interop -- which made the streaming tests
// pass while quietly making real network calls to OpenAI and Google. An
// explicit parameter cannot fail that way.
const http = require("../http.cjs");
const { normalizeResult, normalizeToolSpec } = require("../contract.cjs");

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

function headersFor(key) {
	return { Authorization: `Bearer ${key}` };
}

function buildBody({ model, system, prompt, tools }) {
	const messages = [];
	if (system) {
		messages.push({ role: "system", content: system });
	}
	messages.push({ role: "user", content: prompt });

	const body = { model, messages };
	const specs = normalizeToolSpec(tools);
	if (specs.length > 0) {
		body.tools = specs.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}
	return body;
}

function readMessage(message) {
	const text = typeof message?.content === "string" ? message.content : "";
	const toolCalls = [];
	for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
		if (!call || !call.function?.name) continue;
		toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
	}
	return { text, toolCalls };
}

async function complete({ key, model, system, prompt, tools, transport = http }) {
	const json = await transport.requestJson(ENDPOINT, {
		headers: headersFor(key),
		body: buildBody({ model, system, prompt, tools }),
	});
	const choice = json?.choices?.[0];
	const { text, toolCalls } = readMessage(choice?.message);
	return normalizeResult({ text, toolCalls, finishReason: choice?.finish_reason });
}

async function stream({ key, model, system, prompt, tools, onChunk, transport = http }) {
	let text = "";
	let finishReason = null;
	// Keyed by the `index` OpenAI assigns each tool call, because the name
	// arrives once and the arguments arrive in fragments afterwards.
	const pendingCalls = new Map();

	await transport.requestSse(ENDPOINT, {
		headers: headersFor(key),
		body: { ...buildBody({ model, system, prompt, tools }), stream: true },
		onEvent: (event) => {
			const choice = event?.choices?.[0];
			if (!choice) return;
			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
			const delta = choice.delta;
			if (typeof delta?.content === "string" && delta.content) {
				text += delta.content;
				if (typeof onChunk === "function") onChunk(delta.content);
			}
			for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
				const index = typeof call.index === "number" ? call.index : 0;
				const pending = pendingCalls.get(index) ?? { id: call.id, name: "", argumentsText: "" };
				if (call.id) pending.id = call.id;
				if (call.function?.name) pending.name = call.function.name;
				if (typeof call.function?.arguments === "string") {
					pending.argumentsText += call.function.arguments;
				}
				pendingCalls.set(index, pending);
			}
		},
	});

	const toolCalls = [...pendingCalls.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, pending]) => pending)
		.filter((pending) => pending.name)
		.map((pending) => ({ id: pending.id, name: pending.name, arguments: pending.argumentsText || "{}" }));

	return normalizeResult({ text, toolCalls, finishReason });
}

module.exports = {
	id: "openai",
	label: "OpenAI",
	defaultModel: "gpt-4o-mini",
	capabilities: { streaming: true, tools: true },
	complete,
	stream,
	readMessage,
	buildBody,
};
