"use strict";

// ---------------------------------------------------------------------------
// Google (Gemini) -- WP-4.1.
//
// Self-describing, discovered by ../registry.cjs's directory scan. Three
// Google-specific things:
//
//   - the API key goes in the QUERY STRING, not a header. That is Google's
//     design, not a shortcut here; it is url-encoded, and the key still never
//     leaves the main process.
//   - streaming is a different endpoint (`:streamGenerateContent`) with
//     `alt=sse`, rather than a flag on the same one.
//   - a response is `candidates[].content.parts[]`, where each part is EITHER
//     prose (`text`) or a call (`functionCall`) -- so both are read from the
//     same list rather than from separate fields.
// ---------------------------------------------------------------------------

// The transport is an INJECTED seam (`transport` on each call, defaulting to
// this module), the same convention the rest of this codebase uses for timers,
// clocks and database handles. Module mocking was tried first and silently
// failed to bind under vitest's CJS interop -- which made the streaming tests
// pass while quietly making real network calls to OpenAI and Google. An
// explicit parameter cannot fail that way.
const http = require("../http.cjs");
const { normalizeResult, normalizeToolSpec } = require("../contract.cjs");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function endpointFor(model, method, key) {
	return `${BASE}/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(key)}`;
}

function buildBody({ system, prompt, tools }) {
	const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
	if (system) {
		body.systemInstruction = { parts: [{ text: system }] };
	}
	const specs = normalizeToolSpec(tools);
	if (specs.length > 0) {
		body.tools = [
			{
				functionDeclarations: specs.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		];
	}
	return body;
}

// Both prose and calls live in the same `parts` array, distinguished only by
// which field is present.
function readParts(parts) {
	const text = [];
	const toolCalls = [];
	for (const part of Array.isArray(parts) ? parts : []) {
		if (!part || typeof part !== "object") continue;
		if (typeof part.text === "string" && part.text) {
			text.push(part.text);
		}
		if (part.functionCall?.name) {
			toolCalls.push({ id: part.functionCall.name, name: part.functionCall.name, arguments: part.functionCall.args });
		}
	}
	return { text: text.join(""), toolCalls };
}

async function complete({ key, model, system, prompt, tools, transport = http }) {
	const json = await transport.requestJson(endpointFor(model, "generateContent", key), {
		body: buildBody({ system, prompt, tools }),
	});
	const candidate = json?.candidates?.[0];
	const { text, toolCalls } = readParts(candidate?.content?.parts);
	return normalizeResult({ text, toolCalls, finishReason: candidate?.finishReason });
}

async function stream({ key, model, system, prompt, tools, onChunk, transport = http }) {
	let text = "";
	const toolCalls = [];
	let finishReason = null;

	await transport.requestSse(`${endpointFor(model, "streamGenerateContent", key)}&alt=sse`, {
		body: buildBody({ system, prompt, tools }),
		onEvent: (event) => {
			const candidate = event?.candidates?.[0];
			if (!candidate) return;
			if (candidate.finishReason) {
				finishReason = candidate.finishReason;
			}
			// Each streamed chunk is a partial candidate with the same parts
			// shape, so the non-streaming reader works unchanged here.
			const chunk = readParts(candidate.content?.parts);
			if (chunk.text) {
				text += chunk.text;
				if (typeof onChunk === "function") onChunk(chunk.text);
			}
			toolCalls.push(...chunk.toolCalls);
		},
	});

	return normalizeResult({ text, toolCalls, finishReason });
}

module.exports = {
	id: "google",
	label: "Gemini (Google)",
	defaultModel: "gemini-1.5-flash",
	capabilities: { streaming: true, tools: true },
	complete,
	stream,
	readParts,
	buildBody,
	endpointFor,
};
