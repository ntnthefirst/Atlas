import { describe, expect, it } from "vitest";
import {
	SUGGESTION_FEEDBACK_FILE,
	defaultSuggestionFeedbackState,
	normalizeSuggestionFeedbackState,
} from "./suggestion-feedback.cjs";

// ---------------------------------------------------------------------------
// WP-3.7's persisted reset watermarks. The whole point of this module is that
// a corrupted file must never take the suggestion pipeline down with it, so
// most of what is worth testing here is what it does with rubbish.
// ---------------------------------------------------------------------------

describe("defaultSuggestionFeedbackState", () => {
	it("starts with no resets at all", () => {
		expect(defaultSuggestionFeedbackState()).toEqual({ resets: {} });
	});

	it("hands back a fresh object each time, never a shared one callers could mutate into each other", () => {
		const first = defaultSuggestionFeedbackState();
		first.resets["env-a::type"] = "2026-01-01T00:00:00.000Z";
		expect(defaultSuggestionFeedbackState().resets).toEqual({});
	});

	it("names its own file", () => {
		expect(SUGGESTION_FEEDBACK_FILE).toBe("suggestion-feedback.json");
	});
});

describe("normalizeSuggestionFeedbackState", () => {
	it("keeps every well-formed entry", () => {
		const input = {
			resets: {
				"env-a::sequential_co_occurrence": "2026-05-01T10:00:00.000Z",
				"env-b::other": "2026-05-02T10:00:00.000Z",
			},
		};
		expect(normalizeSuggestionFeedbackState(input)).toEqual(input);
	});

	it("drops only the entries it can't use, keeping the rest", () => {
		const result = normalizeSuggestionFeedbackState({
			resets: {
				"env-a::good": "2026-05-01T10:00:00.000Z",
				"env-a::not-a-date": "whenever",
				"env-a::not-a-string": 1717236000000,
				"env-a::null": null,
			},
		});

		// One bad entry must not cost the user the resets that were fine.
		expect(Object.keys(result.resets)).toEqual(["env-a::good"]);
	});

	it("falls back to empty on anything that isn't the expected shape", () => {
		expect(normalizeSuggestionFeedbackState(null)).toEqual({ resets: {} });
		expect(normalizeSuggestionFeedbackState("nope")).toEqual({ resets: {} });
		expect(normalizeSuggestionFeedbackState({})).toEqual({ resets: {} });
		expect(normalizeSuggestionFeedbackState({ resets: "nope" })).toEqual({ resets: {} });
		expect(normalizeSuggestionFeedbackState({ resets: [] })).toEqual({ resets: {} });
	});

	it("never throws", () => {
		expect(() => normalizeSuggestionFeedbackState({ resets: { "": "2026-05-01T10:00:00.000Z" } })).not.toThrow();
		expect(normalizeSuggestionFeedbackState({ resets: { "": "2026-05-01T10:00:00.000Z" } })).toEqual({ resets: {} });
	});
});
