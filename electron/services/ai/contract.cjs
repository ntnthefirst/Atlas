"use strict";

// ---------------------------------------------------------------------------
// The AI provider contract (WP-4.1) -- what a provider module must look like,
// what it may claim to do, and the one shape every provider's answer is
// normalized into. Pure: no network, no filesystem, no Electron, no keys.
//
// -- Why a contract module at all --------------------------------------------
// WP-4.1's fourth acceptance criterion is "adding a provider requires no
// changes outside its own module". That is only achievable if there is a
// written-down shape for a provider to satisfy and a registry that discovers
// modules rather than listing them (see ./registry.cjs). This file is the
// shape; validateProviderModule is what the registry uses to refuse a module
// that does not meet it, rather than discovering the mismatch at request time
// with the user waiting.
//
// -- Capabilities are claims a caller can check BEFORE asking ----------------
// Providers differ, and D6 says a local model must slot in later without
// redesign -- a local model will almost certainly have different capabilities
// again. So a provider declares what it can do, and callers degrade instead of
// failing: ask for streaming from a provider that lacks it and you get one
// whole chunk rather than an error, ask for tools from a provider that lacks
// them and you find out before you build a request around them.
//
// -- One normalized result shape ---------------------------------------------
// The three cloud APIs disagree about nearly everything: Anthropic returns
// content blocks, OpenAI returns choices with a message, Google returns
// candidates with parts. `normalizeResult` is the only place those differences
// are allowed to exist -- everything above this layer sees `{ text, toolCalls,
// finishReason }` and never branches on which provider answered.
// ---------------------------------------------------------------------------

/** Every capability flag this contract knows about, with its safe default. */
const DEFAULT_CAPABILITIES = Object.freeze({
	/** Can deliver a response incrementally through an onChunk callback. */
	streaming: false,
	/** Can be given tool definitions and may answer with tool calls. */
	tools: false,
});

const CAPABILITY_NAMES = Object.freeze(Object.keys(DEFAULT_CAPABILITIES));

// Unknown flags are dropped rather than carried through: a provider claiming a
// capability this build has never heard of cannot be honoured, and silently
// passing it along would let a caller branch on something meaningless.
function normalizeCapabilities(raw) {
	const result = { ...DEFAULT_CAPABILITIES };
	if (!raw || typeof raw !== "object") {
		return result;
	}
	for (const name of CAPABILITY_NAMES) {
		if (typeof raw[name] === "boolean") {
			result[name] = raw[name];
		}
	}
	return result;
}

/**
 * Checks one candidate provider module against the contract. Returns
 * `{ ok, errors }` rather than throwing, so ./registry.cjs can skip a bad
 * module and keep every good one working -- one broken provider must never
 * take the whole AI layer down.
 */
function validateProviderModule(candidate) {
	const errors = [];
	if (!candidate || typeof candidate !== "object") {
		return { ok: false, errors: ["not an object"] };
	}
	if (typeof candidate.id !== "string" || !candidate.id.trim()) {
		errors.push("missing a non-empty string `id`");
	}
	if (typeof candidate.label !== "string" || !candidate.label.trim()) {
		errors.push("missing a non-empty string `label`");
	}
	if (typeof candidate.defaultModel !== "string" || !candidate.defaultModel.trim()) {
		errors.push("missing a non-empty string `defaultModel`");
	}
	if (typeof candidate.complete !== "function") {
		errors.push("missing a `complete` function");
	}

	const capabilities = normalizeCapabilities(candidate.capabilities);
	// A capability is a promise about behaviour, so it has to be backed by the
	// function that delivers it. Claiming streaming without a `stream` function
	// would make every caller's degrade-check a lie.
	if (capabilities.streaming && typeof candidate.stream !== "function") {
		errors.push("claims `streaming` but has no `stream` function");
	}
	return { ok: errors.length === 0, errors };
}

/**
 * The canonical tool definition. Each provider translates FROM this into its
 * own wire format -- callers (WP-4.3's MCP tools, WP-4.5's Atlas operations)
 * only ever write this one.
 */
function normalizeToolSpec(tools) {
	if (!Array.isArray(tools)) {
		return [];
	}
	return tools
		.map((tool) => {
			if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
				return null;
			}
			return {
				name: tool.name.trim(),
				description: typeof tool.description === "string" ? tool.description : "",
				// A JSON Schema object. Defaulted to an empty object schema rather
				// than omitted: every provider requires *something* here, and "takes
				// no arguments" is a legitimate, common tool.
				parameters:
					tool.parameters && typeof tool.parameters === "object"
						? tool.parameters
						: { type: "object", properties: {} },
			};
		})
		.filter((tool) => tool !== null);
}

/**
 * One tool call the model asked for, normalized. `arguments` is always a
 * parsed object: OpenAI sends a JSON *string*, Anthropic and Google send an
 * object, and making every caller handle both would guarantee someone gets it
 * wrong. Unparsable arguments degrade to `{}` with `malformedArguments: true`
 * rather than throwing, so a caller can refuse the call intelligently instead
 * of the whole response failing.
 */
function normalizeToolCall(raw) {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name) {
		return null;
	}
	let args = {};
	let malformedArguments = false;
	if (typeof raw.arguments === "string") {
		try {
			const parsed = JSON.parse(raw.arguments || "{}");
			args = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			malformedArguments = true;
		}
	} else if (raw.arguments && typeof raw.arguments === "object") {
		args = raw.arguments;
	}
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : name,
		name,
		arguments: args,
		malformedArguments,
	};
}

/** The single shape every provider resolves to. */
function normalizeResult(raw) {
	const value = raw && typeof raw === "object" ? raw : {};
	return {
		text: typeof value.text === "string" ? value.text : "",
		toolCalls: Array.isArray(value.toolCalls)
			? value.toolCalls.map(normalizeToolCall).filter((call) => call !== null)
			: [],
		// Free-form and provider-specific on purpose -- useful for diagnostics,
		// never something this codebase branches on.
		finishReason: typeof value.finishReason === "string" ? value.finishReason : null,
	};
}

/** Whether `provider` claims `capability`. Safe on a missing provider. */
function supports(provider, capability) {
	return Boolean(provider && normalizeCapabilities(provider.capabilities)[capability]);
}

module.exports = {
	DEFAULT_CAPABILITIES,
	CAPABILITY_NAMES,
	normalizeCapabilities,
	validateProviderModule,
	normalizeToolSpec,
	normalizeToolCall,
	normalizeResult,
	supports,
};
