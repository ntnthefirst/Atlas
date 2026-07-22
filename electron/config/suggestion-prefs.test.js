import { describe, expect, it } from "vitest";
import {
	defaultSuggestionPreferences,
	normalizeSuggestionPreferences,
	DEFAULT_ENABLED,
	DEFAULT_MAX_PER_SESSION,
	DEFAULT_MAX_PER_DAY,
} from "./suggestion-prefs.cjs";

describe("defaultSuggestionPreferences", () => {
	it("matches the documented defaults", () => {
		expect(defaultSuggestionPreferences()).toEqual({
			enabled: DEFAULT_ENABLED,
			maxPerSession: DEFAULT_MAX_PER_SESSION,
			maxPerDay: DEFAULT_MAX_PER_DAY,
		});
	});

	it("defaults maxPerSession to exactly 1 -- the plan's own hard rule", () => {
		expect(defaultSuggestionPreferences().maxPerSession).toBe(1);
	});
});

describe("normalizeSuggestionPreferences", () => {
	it("falls back to full defaults for null/undefined/non-object input", () => {
		expect(normalizeSuggestionPreferences(null)).toEqual(defaultSuggestionPreferences());
		expect(normalizeSuggestionPreferences(undefined)).toEqual(defaultSuggestionPreferences());
		expect(normalizeSuggestionPreferences("nope")).toEqual(defaultSuggestionPreferences());
	});

	it("keeps every valid, in-range field as given", () => {
		const input = { enabled: false, maxPerSession: 2, maxPerDay: 5 };
		expect(normalizeSuggestionPreferences(input)).toEqual(input);
	});

	it("clamps out-of-range values to their documented bounds rather than dropping to the default", () => {
		const prefs = normalizeSuggestionPreferences({ maxPerSession: 999, maxPerDay: -5 });
		expect(prefs.maxPerSession).toBeLessThanOrEqual(10);
		expect(prefs.maxPerDay).toBeGreaterThanOrEqual(1);
	});

	it("falls back to a single field's default when only that field is malformed", () => {
		const prefs = normalizeSuggestionPreferences({ maxPerSession: "not a number", maxPerDay: 7 });
		expect(prefs.maxPerSession).toBe(DEFAULT_MAX_PER_SESSION);
		expect(prefs.maxPerDay).toBe(7);
	});

	it("rejects a non-boolean enabled rather than coercing it truthy/falsy", () => {
		expect(normalizeSuggestionPreferences({ enabled: "false" }).enabled).toBe(DEFAULT_ENABLED);
		expect(normalizeSuggestionPreferences({ enabled: 0 }).enabled).toBe(DEFAULT_ENABLED);
	});

	it("never throws on a deeply malformed input", () => {
		expect(() => normalizeSuggestionPreferences({ maxPerSession: {}, maxPerDay: [] })).not.toThrow();
	});
});
