import { describe, expect, it } from "vitest";
import {
	DEFAULT_CAPABILITIES,
	normalizeCapabilities,
	normalizeResult,
	normalizeToolCall,
	normalizeToolSpec,
	supports,
	validateProviderModule,
} from "./contract.cjs";

// ---------------------------------------------------------------------------
// The provider contract (WP-4.1). The normalization here is what lets every
// layer above the providers stop caring which vendor answered, so the tests
// that matter are the ones proving three genuinely different wire shapes
// collapse to one.
// ---------------------------------------------------------------------------

describe("normalizeCapabilities", () => {
	it("defaults everything to false -- a provider gets nothing it did not claim", () => {
		expect(normalizeCapabilities(undefined)).toEqual({ streaming: false, tools: false });
		expect(DEFAULT_CAPABILITIES).toEqual({ streaming: false, tools: false });
	});

	it("keeps only real booleans", () => {
		expect(normalizeCapabilities({ streaming: true, tools: "yes" })).toEqual({ streaming: true, tools: false });
	});

	it("drops flags this build has never heard of", () => {
		expect(normalizeCapabilities({ tools: true, telepathy: true })).toEqual({ streaming: false, tools: true });
	});
});

describe("validateProviderModule", () => {
	const valid = {
		id: "x",
		label: "X",
		defaultModel: "x-1",
		complete: async () => ({}),
	};

	it("accepts a minimal, honest module", () => {
		expect(validateProviderModule(valid)).toEqual({ ok: true, errors: [] });
	});

	it("names every missing field at once, rather than one per attempt", () => {
		const { ok, errors } = validateProviderModule({});
		expect(ok).toBe(false);
		expect(errors).toHaveLength(4);
	});

	it("refuses a streaming claim with no stream function", () => {
		const { ok, errors } = validateProviderModule({ ...valid, capabilities: { streaming: true } });
		expect(ok).toBe(false);
		expect(errors.join(" ")).toMatch(/streaming/);
	});

	it("accepts a streaming claim that is backed", () => {
		expect(validateProviderModule({ ...valid, capabilities: { streaming: true }, stream: async () => ({}) }).ok).toBe(
			true,
		);
	});

	// `tools` needs no separate function -- it is passed to `complete`.
	it("accepts a tools claim without demanding an extra function", () => {
		expect(validateProviderModule({ ...valid, capabilities: { tools: true } }).ok).toBe(true);
	});

	it("refuses non-objects instead of throwing", () => {
		expect(validateProviderModule(null).ok).toBe(false);
		expect(validateProviderModule("nope").ok).toBe(false);
	});
});

describe("normalizeToolSpec", () => {
	it("keeps a well-formed tool", () => {
		expect(
			normalizeToolSpec([{ name: "createTask", description: "Makes a task", parameters: { type: "object" } }]),
		).toEqual([{ name: "createTask", description: "Makes a task", parameters: { type: "object" } }]);
	});

	it("defaults a missing schema to an empty object schema -- 'takes no arguments' is real", () => {
		expect(normalizeToolSpec([{ name: "ping" }])[0].parameters).toEqual({ type: "object", properties: {} });
	});

	it("drops a tool with no usable name rather than sending a nameless one", () => {
		expect(normalizeToolSpec([{ description: "no name" }, { name: "  " }, { name: "ok" }])).toHaveLength(1);
	});

	it("never throws on garbage", () => {
		expect(normalizeToolSpec(null)).toEqual([]);
		expect(normalizeToolSpec([null, undefined, 42])).toEqual([]);
	});
});

describe("normalizeToolCall -- the shapes the three vendors actually send", () => {
	// OpenAI sends arguments as a JSON string.
	it("parses OpenAI's stringified arguments", () => {
		const call = normalizeToolCall({ id: "call_1", name: "createTask", arguments: '{"title":"Buy milk"}' });
		expect(call.arguments).toEqual({ title: "Buy milk" });
		expect(call.malformedArguments).toBe(false);
	});

	// Anthropic and Google send an object.
	it("takes an object through unchanged", () => {
		const call = normalizeToolCall({ id: "toolu_1", name: "createTask", arguments: { title: "Buy milk" } });
		expect(call.arguments).toEqual({ title: "Buy milk" });
	});

	it("flags unparsable arguments instead of throwing, so a caller can refuse the call", () => {
		const call = normalizeToolCall({ name: "createTask", arguments: "{not json" });
		expect(call.malformedArguments).toBe(true);
		expect(call.arguments).toEqual({});
	});

	it("falls back to the name when no id was sent", () => {
		expect(normalizeToolCall({ name: "ping" }).id).toBe("ping");
	});

	it("drops a call with no name", () => {
		expect(normalizeToolCall({ arguments: {} })).toBeNull();
		expect(normalizeToolCall(null)).toBeNull();
	});
});

describe("normalizeResult", () => {
	it("always produces text and toolCalls, whatever it was given", () => {
		expect(normalizeResult(undefined)).toEqual({ text: "", toolCalls: [], finishReason: null });
		expect(normalizeResult({ text: 42 }).text).toBe("");
	});

	it("filters unusable tool calls out of an otherwise fine response", () => {
		const result = normalizeResult({ text: "ok", toolCalls: [{ name: "good" }, { arguments: {} }, null] });
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].name).toBe("good");
	});
});

describe("supports", () => {
	it("answers for a provider that declares the capability", () => {
		expect(supports({ capabilities: { streaming: true } }, "streaming")).toBe(true);
		expect(supports({ capabilities: { streaming: true } }, "tools")).toBe(false);
	});

	it("is false, not a crash, for a missing provider", () => {
		expect(supports(null, "streaming")).toBe(false);
		expect(supports(undefined, "tools")).toBe(false);
	});
});
