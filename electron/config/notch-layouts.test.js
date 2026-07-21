import { describe, expect, it } from "vitest";
import { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, parseStoredNotchLayout, resolveNotchLayout } from "./notch-layouts.cjs";
import { defaultNotchPreferences, normalizeNotchPreferences } from "./notch-prefs.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS -- importing notch-layouts.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws.

describe("parseStoredNotchLayout -- defensive parsing", () => {
	it("returns schema defaults for null/undefined", () => {
		expect(parseStoredNotchLayout(null)).toEqual(defaultNotchPreferences);
		expect(parseStoredNotchLayout(undefined)).toEqual(defaultNotchPreferences);
	});

	it("returns schema defaults for an empty/whitespace-only string", () => {
		expect(parseStoredNotchLayout("")).toEqual(defaultNotchPreferences);
		expect(parseStoredNotchLayout("   ")).toEqual(defaultNotchPreferences);
	});

	it("returns schema defaults for malformed JSON, never throwing", () => {
		expect(() => parseStoredNotchLayout("{not valid json")).not.toThrow();
		expect(parseStoredNotchLayout("{not valid json")).toEqual(defaultNotchPreferences);
	});

	it("returns schema defaults for valid JSON that isn't an object (array, number, string)", () => {
		expect(parseStoredNotchLayout("[1,2,3]")).toEqual(defaultNotchPreferences);
		expect(parseStoredNotchLayout("42")).toEqual(defaultNotchPreferences);
		expect(parseStoredNotchLayout('"just a string"')).toEqual(defaultNotchPreferences);
	});

	it("parses a valid JSON string into a normalized document", () => {
		const stored = JSON.stringify({ ...defaultNotchPreferences, position: "left", locked: true });
		const result = parseStoredNotchLayout(stored);
		expect(result.position).toBe("left");
		expect(result.locked).toBe(true);
	});

	it("normalizes an already-parsed object the same way a string would be", () => {
		const result = parseStoredNotchLayout({ position: "right" });
		expect(result.position).toBe("right");
		expect(result.tabs).toEqual(defaultNotchPreferences.tabs);
	});

	it("drops unknown/invalid fields defensively rather than throwing", () => {
		const result = parseStoredNotchLayout({ position: "sideways", idleOpacity: "extreme", tabs: "not-an-array" });
		expect(result.position).toBe(defaultNotchPreferences.position);
		expect(result.idleOpacity).toBe(defaultNotchPreferences.idleOpacity);
		expect(result.tabs).toEqual(defaultNotchPreferences.tabs);
	});
});

describe("resolveNotchLayout", () => {
	const ownRaw = JSON.stringify(normalizeNotchPreferences({ position: "left", idleOpacity: "solid" }));
	const defaultRaw = JSON.stringify(normalizeNotchPreferences({ position: "top", idleOpacity: "balanced" }));

	it("resolves to the environment's own layout when notchLayoutId is set and the row exists", () => {
		const result = resolveNotchLayout({
			notchLayoutId: "env-own-layout-id",
			ownLayoutRaw: ownRaw,
			defaultLayoutRaw: defaultRaw,
		});
		expect(result.usesDefault).toBe(false);
		expect(result.layoutId).toBe("env-own-layout-id");
		expect(result.preferences.position).toBe("left");
		expect(result.preferences.idleOpacity).toBe("solid");
	});

	it("resolves to the global default when notchLayoutId is null", () => {
		const result = resolveNotchLayout({
			notchLayoutId: null,
			ownLayoutRaw: null,
			defaultLayoutRaw: defaultRaw,
		});
		expect(result.usesDefault).toBe(true);
		expect(result.layoutId).toBe(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(result.preferences.position).toBe("top");
	});

	it("treats an empty/whitespace notchLayoutId the same as null -- never an 'empty layout'", () => {
		const emptyResult = resolveNotchLayout({ notchLayoutId: "", ownLayoutRaw: null, defaultLayoutRaw: defaultRaw });
		const whitespaceResult = resolveNotchLayout({
			notchLayoutId: "   ",
			ownLayoutRaw: null,
			defaultLayoutRaw: defaultRaw,
		});
		expect(emptyResult.usesDefault).toBe(true);
		expect(whitespaceResult.usesDefault).toBe(true);
	});

	it("falls back to the default when notchLayoutId is set but the row is missing (null/undefined raw)", () => {
		const result = resolveNotchLayout({
			notchLayoutId: "deleted-or-never-seeded",
			ownLayoutRaw: null,
			defaultLayoutRaw: defaultRaw,
		});
		expect(result.usesDefault).toBe(true);
		expect(result.layoutId).toBe(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		expect(result.preferences.position).toBe("top");
	});

	it("falls back to schema defaults when even the default row is missing", () => {
		const result = resolveNotchLayout({ notchLayoutId: null, ownLayoutRaw: null, defaultLayoutRaw: null });
		expect(result.usesDefault).toBe(true);
		expect(result.preferences).toEqual(defaultNotchPreferences);
	});

	it("defensively parses a malformed own-layout row rather than throwing or leaking a broken document", () => {
		const result = resolveNotchLayout({
			notchLayoutId: "corrupt-layout",
			ownLayoutRaw: "{not valid json at all",
			defaultLayoutRaw: defaultRaw,
		});
		expect(result.usesDefault).toBe(false);
		expect(result.layoutId).toBe("corrupt-layout");
		// A broken own-layout row still normalizes to a full, valid document --
		// never an empty/partial shape, and never the default's contents either
		// (the environment still "has its own layout"; that layout just fell
		// back to schema defaults for whichever fields it couldn't parse).
		expect(result.preferences).toEqual(defaultNotchPreferences);
	});
});
