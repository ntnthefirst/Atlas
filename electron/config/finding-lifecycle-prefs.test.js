import { describe, expect, it } from "vitest";
import {
	defaultFindingLifecyclePreferences,
	normalizeFindingLifecyclePreferences,
	DEFAULT_BASE_BACKOFF_HOURS,
	DEFAULT_BACKOFF_MULTIPLIER,
	DEFAULT_MAX_BACKOFF_DAYS,
	DEFAULT_EXPIRY_DAYS,
} from "./finding-lifecycle-prefs.cjs";

describe("defaultFindingLifecyclePreferences", () => {
	it("matches the documented defaults", () => {
		expect(defaultFindingLifecyclePreferences()).toEqual({
			baseBackoffHours: DEFAULT_BASE_BACKOFF_HOURS,
			backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
			maxBackoffDays: DEFAULT_MAX_BACKOFF_DAYS,
			expiryDays: DEFAULT_EXPIRY_DAYS,
		});
	});
});

describe("normalizeFindingLifecyclePreferences", () => {
	it("falls back to full defaults for null/undefined/non-object input", () => {
		expect(normalizeFindingLifecyclePreferences(null)).toEqual(defaultFindingLifecyclePreferences());
		expect(normalizeFindingLifecyclePreferences(undefined)).toEqual(defaultFindingLifecyclePreferences());
		expect(normalizeFindingLifecyclePreferences("nope")).toEqual(defaultFindingLifecyclePreferences());
	});

	it("keeps every valid, in-range field as given", () => {
		const input = { baseBackoffHours: 12, backoffMultiplier: 3, maxBackoffDays: 10, expiryDays: 7 };
		expect(normalizeFindingLifecyclePreferences(input)).toEqual(input);
	});

	it("clamps a multiplier of exactly 1 upward, since a flat back-off defeats the whole point", () => {
		const prefs = normalizeFindingLifecyclePreferences({ backoffMultiplier: 1 });
		expect(prefs.backoffMultiplier).toBeGreaterThan(1);
	});

	it("clamps out-of-range values to their documented bounds rather than dropping to the default", () => {
		const prefs = normalizeFindingLifecyclePreferences({
			baseBackoffHours: 999999,
			backoffMultiplier: 999,
			maxBackoffDays: -5,
			expiryDays: -5,
		});
		expect(prefs.baseBackoffHours).toBeLessThanOrEqual(24 * 7);
		expect(prefs.backoffMultiplier).toBeLessThanOrEqual(10);
		expect(prefs.maxBackoffDays).toBeGreaterThanOrEqual(1);
		expect(prefs.expiryDays).toBeGreaterThanOrEqual(1);
	});

	it("falls back to a single field's default when only that field is malformed", () => {
		const prefs = normalizeFindingLifecyclePreferences({ baseBackoffHours: "not a number", expiryDays: 20 });
		expect(prefs.baseBackoffHours).toBe(DEFAULT_BASE_BACKOFF_HOURS);
		expect(prefs.expiryDays).toBe(20);
	});

	it("never throws on a deeply malformed input", () => {
		expect(() => normalizeFindingLifecyclePreferences({ baseBackoffHours: {}, expiryDays: [] })).not.toThrow();
	});
});
