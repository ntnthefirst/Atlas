import { describe, expect, it } from "vitest";
import {
	defaultPatternMinerPreferences,
	normalizePatternMinerPreferences,
	DEFAULT_WINDOW_MINUTES,
	DEFAULT_MIN_OCCURRENCES,
	DEFAULT_MIN_CONFIDENCE,
	DEFAULT_MIN_LIFT,
	DEFAULT_SIGNIFICANCE_LEVEL,
	DEFAULT_MAX_CANDIDATE_KEYS,
	DEFAULT_MIN_BUCKET_EVENTS,
} from "./pattern-miner-prefs.cjs";

describe("defaultPatternMinerPreferences", () => {
	it("matches the documented defaults", () => {
		const prefs = defaultPatternMinerPreferences();
		expect(prefs).toEqual({
			windowMinutes: DEFAULT_WINDOW_MINUTES,
			minOccurrences: DEFAULT_MIN_OCCURRENCES,
			minConfidence: DEFAULT_MIN_CONFIDENCE,
			minLift: DEFAULT_MIN_LIFT,
			significanceLevel: DEFAULT_SIGNIFICANCE_LEVEL,
			maxCandidateKeys: DEFAULT_MAX_CANDIDATE_KEYS,
			minBucketEvents: DEFAULT_MIN_BUCKET_EVENTS,
		});
	});
});

describe("normalizePatternMinerPreferences", () => {
	it("falls back to full defaults for null/undefined/non-object input", () => {
		expect(normalizePatternMinerPreferences(null)).toEqual(defaultPatternMinerPreferences());
		expect(normalizePatternMinerPreferences(undefined)).toEqual(defaultPatternMinerPreferences());
		expect(normalizePatternMinerPreferences("not an object")).toEqual(defaultPatternMinerPreferences());
	});

	it("keeps every valid, in-range field as given", () => {
		const input = {
			windowMinutes: 15,
			minOccurrences: 8,
			minConfidence: 0.75,
			minLift: 4.5,
			significanceLevel: 0.005,
			maxCandidateKeys: 60,
			minBucketEvents: 50,
		};
		expect(normalizePatternMinerPreferences(input)).toEqual(input);
	});

	it("clamps a fractional threshold instead of rounding it to an integer", () => {
		const prefs = normalizePatternMinerPreferences({ minConfidence: 0.73, minLift: 3.14 });
		expect(prefs.minConfidence).toBe(0.73);
		expect(prefs.minLift).toBe(3.14);
	});

	it("clamps out-of-range values to their documented bounds rather than dropping to the default", () => {
		const prefs = normalizePatternMinerPreferences({
			windowMinutes: 999999,
			minOccurrences: -5,
			minConfidence: 50,
			minLift: 0.1,
			significanceLevel: 5,
			maxCandidateKeys: 999999,
			minBucketEvents: -1,
		});
		expect(prefs.windowMinutes).toBeLessThanOrEqual(24 * 60);
		expect(prefs.minOccurrences).toBeGreaterThanOrEqual(2);
		expect(prefs.minConfidence).toBeLessThanOrEqual(1);
		expect(prefs.minLift).toBeGreaterThanOrEqual(1);
		expect(prefs.significanceLevel).toBeLessThanOrEqual(0.2);
		expect(prefs.maxCandidateKeys).toBeLessThanOrEqual(200);
		expect(prefs.minBucketEvents).toBeGreaterThanOrEqual(2);
	});

	it("falls back to a single field's default when only that field is malformed", () => {
		const prefs = normalizePatternMinerPreferences({ minOccurrences: "not a number", windowMinutes: 45 });
		expect(prefs.minOccurrences).toBe(DEFAULT_MIN_OCCURRENCES);
		expect(prefs.windowMinutes).toBe(45);
	});

	it("never throws on a deeply malformed input", () => {
		expect(() => normalizePatternMinerPreferences({ windowMinutes: {}, minLift: [] })).not.toThrow();
	});
});
