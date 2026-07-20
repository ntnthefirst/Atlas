import { describe, expect, it } from "vitest";
import { todayKey, clampFocusInt, normalizeFocusConfig, normalizeFocusStats, defaultFocusConfig } from "./focus-prefs.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing focus-prefs.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws.

describe("todayKey", () => {
	it("formats an explicit local Date as YYYY-MM-DD, zero-padding a single-digit month and day", () => {
		// new Date(2026, 2, 5) is built from local y/m/d components (month is
		// 0-indexed, so 2 = March) rather than parsed from an ISO string, which
		// keeps this assertion stable regardless of the CI machine's timezone.
		expect(todayKey(new Date(2026, 2, 5))).toBe("2026-03-05");
	});

	it("zero-pads a single-digit day even when the month is double-digit", () => {
		expect(todayKey(new Date(2026, 10, 5))).toBe("2026-11-05");
	});

	it("zero-pads a single-digit month even when the day is double-digit", () => {
		expect(todayKey(new Date(2026, 2, 15))).toBe("2026-03-15");
	});
});

describe("clampFocusInt", () => {
	it("falls back for genuinely non-finite input (NaN, Infinity, -Infinity, undefined, a non-numeric string)", () => {
		expect(clampFocusInt(NaN, 1, 10, 5)).toBe(5);
		expect(clampFocusInt(Infinity, 1, 10, 5)).toBe(5);
		expect(clampFocusInt(-Infinity, 1, 10, 5)).toBe(5);
		expect(clampFocusInt(undefined, 1, 10, 5)).toBe(5);
		expect(clampFocusInt("abc", 1, 10, 5)).toBe(5);
	});

	// Surprising: Number(null) === 0 and Number("") === 0, both finite, so
	// these do NOT hit the fallback like undefined/NaN do — they get clamped
	// as the number 0 instead (up to the minimum here).
	it("treats null and an empty string as the finite number 0, clamping to the minimum instead of falling back", () => {
		expect(clampFocusInt(null, 1, 10, 5)).toBe(1);
		expect(clampFocusInt("", 1, 10, 5)).toBe(1);
	});

	it("parses a numeric string via Number() and clamps it like a real number", () => {
		expect(clampFocusInt("5", 1, 10, 0)).toBe(5);
	});

	it("rounds a .5 value using Math.round's round-toward-+Infinity rule", () => {
		expect(clampFocusInt(2.5, 0, 10, 0)).toBe(3);
		// Not -3: Math.round(-2.5) is -2, rounding toward +Infinity, not away from zero.
		expect(clampFocusInt(-2.5, -10, 10, 0)).toBe(-2);
	});

	it("clamps a value above max down to max", () => {
		expect(clampFocusInt(1000, 1, 180, 25)).toBe(180);
	});

	it("clamps a value below min up to min", () => {
		expect(clampFocusInt(-5, 1, 180, 25)).toBe(1);
	});
});

describe("normalizeFocusConfig", () => {
	it("returns full defaults for null, undefined, and non-object input", () => {
		expect(normalizeFocusConfig(null)).toEqual(defaultFocusConfig);
		expect(normalizeFocusConfig(undefined)).toEqual(defaultFocusConfig);
		expect(normalizeFocusConfig("not an object")).toEqual(defaultFocusConfig);
	});

	describe("duration fields", () => {
		it("clamps focusMinutes to the documented 1-180 range", () => {
			expect(normalizeFocusConfig({ focusMinutes: 300 }).focusMinutes).toBe(180);
			expect(normalizeFocusConfig({ focusMinutes: 0 }).focusMinutes).toBe(1);
		});

		it("clamps shortBreakMinutes to the documented 1-60 range", () => {
			expect(normalizeFocusConfig({ shortBreakMinutes: 999 }).shortBreakMinutes).toBe(60);
			expect(normalizeFocusConfig({ shortBreakMinutes: -5 }).shortBreakMinutes).toBe(1);
		});

		it("clamps longBreakMinutes to the documented 1-120 range", () => {
			expect(normalizeFocusConfig({ longBreakMinutes: 500 }).longBreakMinutes).toBe(120);
			expect(normalizeFocusConfig({ longBreakMinutes: 0 }).longBreakMinutes).toBe(1);
		});

		it("clamps roundsBeforeLongBreak to the documented 1-12 range", () => {
			expect(normalizeFocusConfig({ roundsBeforeLongBreak: 50 }).roundsBeforeLongBreak).toBe(12);
			expect(normalizeFocusConfig({ roundsBeforeLongBreak: 0 }).roundsBeforeLongBreak).toBe(1);
		});

		it("falls back focusMinutes and roundsBeforeLongBreak to their defaults when given non-numeric input", () => {
			expect(normalizeFocusConfig({ focusMinutes: "abc" }).focusMinutes).toBe(defaultFocusConfig.focusMinutes);
			expect(normalizeFocusConfig({ roundsBeforeLongBreak: undefined }).roundsBeforeLongBreak).toBe(
				defaultFocusConfig.roundsBeforeLongBreak,
			);
		});
	});

	describe("boolean fields", () => {
		it("accepts a real boolean for autoStartBreaks, autoStartFocus, and nudgesOnlyDuringFocus", () => {
			expect(normalizeFocusConfig({ autoStartBreaks: false }).autoStartBreaks).toBe(false);
			expect(normalizeFocusConfig({ autoStartFocus: true }).autoStartFocus).toBe(true);
			expect(normalizeFocusConfig({ nudgesOnlyDuringFocus: false }).nudgesOnlyDuringFocus).toBe(false);
		});

		it("falls back to the default rather than coercing a truthy/falsy look-alike", () => {
			// 0 is falsy, but the default (true) wins — proves a strict typeof
			// check, not Boolean(value) truthiness coercion.
			expect(normalizeFocusConfig({ autoStartBreaks: 0 }).autoStartBreaks).toBe(true);
			// "true" is truthy, but the default (false) wins, for the same reason.
			expect(normalizeFocusConfig({ autoStartFocus: "true" }).autoStartFocus).toBe(false);
			expect(normalizeFocusConfig({ nudgesOnlyDuringFocus: 0 }).nudgesOnlyDuringFocus).toBe(true);
		});
	});

	describe("nudges", () => {
		it("always emits nudges in defaultFocusConfig's order, regardless of input order", () => {
			const result = normalizeFocusConfig({ nudges: [{ kind: "posture" }, { kind: "stand" }] });
			expect(result.nudges.map((n) => n.kind)).toEqual(["stand", "eyes", "hydrate", "posture"]);
		});

		it("ignores an unknown nudge kind entirely, falling back to defaults for all four real kinds", () => {
			const result = normalizeFocusConfig({ nudges: [{ kind: "bogus", enabled: true, everyMinutes: 1 }] });
			expect(result.nudges).toEqual(defaultFocusConfig.nudges);
		});

		it("lets a partial input nudge inherit its remaining fields from the default", () => {
			const result = normalizeFocusConfig({ nudges: [{ kind: "hydrate", everyMinutes: 200 }] });
			expect(result.nudges.find((n) => n.kind === "hydrate")).toEqual({
				kind: "hydrate",
				enabled: false, // inherited — not present in the input
				everyMinutes: 200, // taken from the input
			});
		});

		it("still includes a nudge kind missing entirely from the input, with its full default", () => {
			const result = normalizeFocusConfig({ nudges: [{ kind: "stand", enabled: true }] });
			expect(result.nudges.find((n) => n.kind === "eyes")).toEqual({ kind: "eyes", enabled: false, everyMinutes: 20 });
		});

		it("clamps everyMinutes to the documented 1-360 range", () => {
			expect(normalizeFocusConfig({ nudges: [{ kind: "stand", everyMinutes: 500 }] }).nudges[0].everyMinutes).toBe(
				360,
			);
			expect(normalizeFocusConfig({ nudges: [{ kind: "stand", everyMinutes: 0 }] }).nudges[0].everyMinutes).toBe(1);
		});

		it("returns fresh nudge objects, not references into defaultFocusConfig — mutating the result must not corrupt the module's defaults", () => {
			const result = normalizeFocusConfig({});
			expect(result.nudges[0]).not.toBe(defaultFocusConfig.nudges[0]);

			result.nudges[0].enabled = true;
			result.nudges[0].everyMinutes = 999;

			expect(defaultFocusConfig.nudges[0]).toEqual({ kind: "stand", enabled: false, everyMinutes: 50 });
			expect(normalizeFocusConfig({}).nudges[0].enabled).toBe(false);
		});
	});
});

describe("normalizeFocusStats", () => {
	it("returns today's key and zeroed counters for null or non-object input", () => {
		expect(normalizeFocusStats(null)).toEqual({ day: todayKey(), focusRoundsCompleted: 0, focusMsCompleted: 0 });
		expect(normalizeFocusStats("nope")).toEqual({ day: todayKey(), focusRoundsCompleted: 0, focusMsCompleted: 0 });
	});

	it("falls day back to today's key when missing, blank, or not a string", () => {
		expect(normalizeFocusStats({}).day).toBe(todayKey());
		expect(normalizeFocusStats({ day: "" }).day).toBe(todayKey());
		expect(normalizeFocusStats({ day: 20260305 }).day).toBe(todayKey());
	});

	it("passes a non-empty day string through verbatim, even if it is only whitespace", () => {
		// Only the exact empty string "" counts as blank — "   " is truthy and
		// survives unchanged, with no trimming or date-format validation at all.
		expect(normalizeFocusStats({ day: "   " }).day).toBe("   ");
		expect(normalizeFocusStats({ day: "2026-01-01" }).day).toBe("2026-01-01");
	});

	it("clamps focusRoundsCompleted to 0-100000, including negative and non-numeric input", () => {
		expect(normalizeFocusStats({ focusRoundsCompleted: -5 }).focusRoundsCompleted).toBe(0);
		expect(normalizeFocusStats({ focusRoundsCompleted: 999999 }).focusRoundsCompleted).toBe(100000);
		expect(normalizeFocusStats({ focusRoundsCompleted: "abc" }).focusRoundsCompleted).toBe(0);
		expect(normalizeFocusStats({ focusRoundsCompleted: 42 }).focusRoundsCompleted).toBe(42);
	});

	it("never lets focusMsCompleted go negative, and coerces non-numeric input to 0", () => {
		expect(normalizeFocusStats({ focusMsCompleted: -250 }).focusMsCompleted).toBe(0);
		expect(normalizeFocusStats({ focusMsCompleted: "abc" }).focusMsCompleted).toBe(0);
		expect(normalizeFocusStats({ focusMsCompleted: 12345 }).focusMsCompleted).toBe(12345);
	});
});
