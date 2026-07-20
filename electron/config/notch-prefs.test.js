import { describe, expect, it } from "vitest";
import {
	NOTCH_GRID_MIN_COLS,
	NOTCH_GRID_MAX_COLS,
	NOTCH_GRID_MIN_ROWS,
	NOTCH_GRID_MAX_ROWS,
	defaultNotchTabs,
	defaultNotchPreferences,
	normalizeIdEnabledList,
	placementsOverlap,
	normalizeNotchPlacements,
	normalizeNotchTabs,
	normalizeNotchPreferences,
} from "./notch-prefs.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing notch-prefs.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws.

describe("placementsOverlap", () => {
	it("returns false for two clearly separate boxes", () => {
		expect(placementsOverlap({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 })).toBe(false);
	});

	it("returns true for two clearly overlapping boxes", () => {
		expect(placementsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
	});

	it("treats boxes that only touch along a vertical edge as non-overlapping", () => {
		// Box a covers columns [0,2), box b covers [2,4) — they share an edge but no cells.
		expect(placementsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
	});

	it("treats boxes that only touch along a horizontal edge as non-overlapping", () => {
		expect(placementsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })).toBe(false);
	});
});

describe("normalizeIdEnabledList", () => {
	const ids = ["a", "b"];
	const defaults = [
		{ id: "a", enabled: true },
		{ id: "b", enabled: true },
	];

	it("returns a copy of defaults for non-array input", () => {
		expect(normalizeIdEnabledList(null, ids, defaults)).toEqual(defaults);
		expect(normalizeIdEnabledList(undefined, ids, defaults)).toEqual(defaults);
	});

	it("returns a copy, not the same reference — mutating the result must not corrupt the defaults", () => {
		const localDefaults = [
			{ id: "a", enabled: true },
			{ id: "b", enabled: true },
		];
		const result = normalizeIdEnabledList("not-an-array", ids, localDefaults);
		expect(result).not.toBe(localDefaults);
		result[0].enabled = false;
		expect(localDefaults[0].enabled).toBe(true);
	});

	it("drops ids that are not in validIds", () => {
		const result = normalizeIdEnabledList([{ id: "a" }, { id: "not-valid" }], ids, defaults);
		expect(result).toEqual([
			{ id: "a", enabled: true },
			{ id: "b", enabled: true },
		]);
	});

	it("drops a later duplicate id, keeping the first occurrence's value", () => {
		const result = normalizeIdEnabledList(
			[
				{ id: "a", enabled: false },
				{ id: "a", enabled: true },
			],
			ids,
			defaults,
		);
		expect(result).toEqual([
			{ id: "a", enabled: false },
			{ id: "b", enabled: true },
		]);
	});

	it("preserves the user's ordering", () => {
		const result = normalizeIdEnabledList([{ id: "b" }, { id: "a" }], ids, defaults);
		expect(result.map((entry) => entry.id)).toEqual(["b", "a"]);
	});

	it("appends ids missing from the input at the end", () => {
		const result = normalizeIdEnabledList([{ id: "b" }], ids, defaults);
		expect(result).toEqual([
			{ id: "b", enabled: true },
			{ id: "a", enabled: true },
		]);
	});

	// Surprising: appended (missing) ids are always hard-coded enabled:true —
	// the defaults array's own enabled value for that id is never consulted.
	// It only matters if a caller ever ships a default with enabled:false;
	// today's real defaults are all enabled:true so this is latent, not active.
	it("appends missing ids as enabled:true even when the defaults say otherwise", () => {
		const falseDefaults = [
			{ id: "a", enabled: false },
			{ id: "b", enabled: false },
		];
		const result = normalizeIdEnabledList([], ids, falseDefaults);
		expect(result).toEqual([
			{ id: "a", enabled: true },
			{ id: "b", enabled: true },
		]);
	});

	it("coerces a non-boolean enabled value to true", () => {
		const result = normalizeIdEnabledList([{ id: "a", enabled: "yes" }], ids, defaults);
		expect(result[0]).toEqual({ id: "a", enabled: true });
	});

	it("drops non-object entries", () => {
		const result = normalizeIdEnabledList([null, "foo", 42], ids, defaults);
		expect(result).toEqual(defaults);
	});
});

describe("normalizeNotchPlacements", () => {
	// "divider" and "label" are both real NOTCH_WIDGET_IDS entries.
	it("returns an empty array for non-array input", () => {
		expect(normalizeNotchPlacements(null, 5, 5)).toEqual([]);
		expect(normalizeNotchPlacements(undefined, 5, 5)).toEqual([]);
	});

	it("drops null and non-object entries", () => {
		expect(normalizeNotchPlacements([null, "foo", 42], 5, 5)).toEqual([]);
	});

	it("drops entries with an unknown widget id", () => {
		expect(normalizeNotchPlacements([{ widget: "notAWidget", x: 0, y: 0, w: 1, h: 1 }], 5, 5)).toEqual([]);
	});

	it("clamps w/h/x/y so an oversized placement fits inside the grid", () => {
		const result = normalizeNotchPlacements([{ widget: "divider", x: 10, y: 10, w: 100, h: 100 }], 5, 5);
		expect(result).toEqual([{ id: "placement-0", widget: "divider", x: 0, y: 0, w: 5, h: 5 }]);
	});

	it("falls back non-numeric geometry fields to their defaults", () => {
		const result = normalizeNotchPlacements([{ widget: "divider", x: "a", y: "b", w: "c", h: "d" }], 5, 5);
		expect(result).toEqual([{ id: "placement-0", widget: "divider", x: 0, y: 0, w: 1, h: 1 }]);
	});

	it("clamps negative geometry up to the minimum instead of leaving it negative", () => {
		const result = normalizeNotchPlacements([{ widget: "divider", x: -5, y: -5, w: -5, h: -5 }], 5, 5);
		expect(result).toEqual([{ id: "placement-0", widget: "divider", x: 0, y: 0, w: 1, h: 1 }]);
	});

	it("generates a placement-<index> id when id is missing or blank", () => {
		// x offsets keep the two placements from overlapping, which would drop
		// the second one for a different reason than the id logic being tested.
		const result = normalizeNotchPlacements(
			[
				{ widget: "divider", x: 0 },
				{ widget: "label", id: "   ", x: 3 },
			],
			5,
			5,
		);
		expect(result.map((p) => p.id)).toEqual(["placement-0", "placement-1"]);
	});

	it("drops a later entry whose id duplicates an earlier one, even without an overlap", () => {
		const result = normalizeNotchPlacements(
			[
				{ widget: "divider", id: "x", x: 0, y: 0, w: 1, h: 1 },
				{ widget: "label", id: "x", x: 3, y: 3, w: 1, h: 1 },
			],
			5,
			5,
		);
		expect(result).toHaveLength(1);
		expect(result[0].widget).toBe("divider");
	});

	it("drops a later placement that overlaps an earlier one", () => {
		const result = normalizeNotchPlacements(
			[
				{ widget: "divider", x: 0, y: 0, w: 2, h: 2 },
				{ widget: "label", x: 1, y: 1, w: 2, h: 2 },
			],
			5,
			5,
		);
		expect(result).toHaveLength(1);
		expect(result[0].widget).toBe("divider");
	});

	it("keeps two placements that merely touch at an edge (not a real overlap)", () => {
		const result = normalizeNotchPlacements(
			[
				{ widget: "divider", x: 0, y: 0, w: 2, h: 2 },
				{ widget: "label", x: 2, y: 0, w: 2, h: 2 },
			],
			5,
			5,
		);
		expect(result).toHaveLength(2);
	});

	it("keeps a trimmed, non-empty config string", () => {
		const result = normalizeNotchPlacements([{ widget: "label", config: "  hello  " }], 5, 5);
		expect(result[0].config).toBe("hello");
	});

	it("omits config entirely when it is blank", () => {
		const result = normalizeNotchPlacements([{ widget: "label", config: "   " }], 5, 5);
		expect(result[0].config).toBeUndefined();
	});
});

describe("normalizeNotchTabs", () => {
	it("returns a deep copy of the defaults for non-array input", () => {
		const result = normalizeNotchTabs(null, defaultNotchTabs);
		expect(result).toEqual(defaultNotchTabs);
		expect(result).not.toBe(defaultNotchTabs);
	});

	it("returns the defaults for an empty array", () => {
		expect(normalizeNotchTabs([], defaultNotchTabs)).toEqual(defaultNotchTabs);
	});

	it("falls back to defaults wholesale when every entry is invalid", () => {
		const result = normalizeNotchTabs([null, {}, { id: "" }, { id: "   " }], defaultNotchTabs);
		expect(result).toEqual(defaultNotchTabs);
	});

	it("drops a later tab whose id duplicates an earlier one, keeping the first", () => {
		const result = normalizeNotchTabs(
			[
				{ id: "a", label: "First" },
				{ id: "a", label: "Second" },
			],
			defaultNotchTabs,
		);
		expect(result).toHaveLength(1);
		expect(result[0].label).toBe("First");
	});

	it("falls back label to 'Tab' when missing or blank", () => {
		expect(normalizeNotchTabs([{ id: "x" }], defaultNotchTabs)[0].label).toBe("Tab");
		expect(normalizeNotchTabs([{ id: "x", label: "  " }], defaultNotchTabs)[0].label).toBe("Tab");
	});

	it("falls back icon to Squares2X2Icon when it is not a recognized icon", () => {
		expect(normalizeNotchTabs([{ id: "x", icon: "NotARealIcon" }], defaultNotchTabs)[0].icon).toBe(
			"Squares2X2Icon",
		);
	});

	it("clamps gridCols/gridRows above the max down to the max", () => {
		const tab = normalizeNotchTabs([{ id: "x", gridCols: 999, gridRows: 999 }], defaultNotchTabs)[0];
		expect(tab.gridCols).toBe(NOTCH_GRID_MAX_COLS);
		expect(tab.gridRows).toBe(NOTCH_GRID_MAX_ROWS);
	});

	it("clamps gridCols/gridRows below the min up to the min", () => {
		const tab = normalizeNotchTabs([{ id: "x", gridCols: 1, gridRows: 0 }], defaultNotchTabs)[0];
		expect(tab.gridCols).toBe(NOTCH_GRID_MIN_COLS);
		expect(tab.gridRows).toBe(NOTCH_GRID_MIN_ROWS);
	});

	it("falls back non-numeric gridCols/gridRows to the minimum", () => {
		const tab = normalizeNotchTabs([{ id: "x", gridCols: "abc", gridRows: "xyz" }], defaultNotchTabs)[0];
		expect(tab.gridCols).toBe(NOTCH_GRID_MIN_COLS);
		expect(tab.gridRows).toBe(NOTCH_GRID_MIN_ROWS);
	});

	it("normalizes placements against the clamped grid size, not the raw requested size", () => {
		// gridCols:3 is below NOTCH_GRID_MIN_COLS(5) so it gets bumped up to 5;
		// gridRows:3 is within range so it stays 3 — the placement must be
		// clamped against that *effective* 5x3 grid, not the raw 3x3 request.
		const tab = normalizeNotchTabs(
			[{ id: "x", gridCols: 3, gridRows: 3, placements: [{ widget: "divider", x: 10, y: 10, w: 10, h: 10 }] }],
			defaultNotchTabs,
		)[0];
		expect(tab.gridCols).toBe(5);
		expect(tab.gridRows).toBe(3);
		expect(tab.placements).toEqual([{ id: "placement-0", widget: "divider", x: 0, y: 0, w: 5, h: 3 }]);
	});
});

describe("normalizeNotchPreferences", () => {
	it("returns the defaults for null", () => {
		expect(normalizeNotchPreferences(null)).toEqual(defaultNotchPreferences);
	});

	it("returns the defaults for undefined", () => {
		expect(normalizeNotchPreferences(undefined)).toEqual(defaultNotchPreferences);
	});

	it("returns the defaults for a non-object value", () => {
		expect(normalizeNotchPreferences("not an object")).toEqual(defaultNotchPreferences);
		expect(normalizeNotchPreferences(42)).toEqual(defaultNotchPreferences);
	});

	it("returns the defaults for an empty object", () => {
		expect(normalizeNotchPreferences({})).toEqual(defaultNotchPreferences);
	});

	it("falls every field back to its default when every field is wrong-typed", () => {
		const wrong = {
			enabled: "true",
			position: 123,
			x: "5",
			y: "6",
			idleOpacity: true,
			locked: "false",
			activation: 42,
			displayIds: "not-an-array",
			tabs: "not-an-array",
			infoItems: "not-an-array",
		};
		expect(normalizeNotchPreferences(wrong)).toEqual(defaultNotchPreferences);
	});

	it("round-trips a fully valid object unchanged", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences })).toEqual(defaultNotchPreferences);
	});

	it("accepts only a real boolean for enabled, rejecting truthy look-alikes", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, enabled: false }).enabled).toBe(false);
		// "false" the string and 0 are not real booleans, so both fall back to
		// the default (true) rather than being coerced to false.
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, enabled: "false" }).enabled).toBe(true);
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, enabled: 0 }).enabled).toBe(true);
	});

	it("accepts only a real boolean for locked, rejecting truthy look-alikes", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, locked: true }).locked).toBe(true);
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, locked: "true" }).locked).toBe(false);
	});

	it("only accepts a position from NOTCH_POSITIONS", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, position: "left" }).position).toBe("left");
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, position: "diagonal" }).position).toBe("top");
	});

	it("only accepts an idleOpacity from NOTCH_IDLE_OPACITIES", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, idleOpacity: "solid" }).idleOpacity).toBe(
			"solid",
		);
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, idleOpacity: "extreme" }).idleOpacity).toBe(
			"balanced",
		);
	});

	it("only accepts an activation from NOTCH_ACTIVATIONS", () => {
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, activation: "withMain" }).activation).toBe(
			"withMain",
		);
		expect(normalizeNotchPreferences({ ...defaultNotchPreferences, activation: "never" }).activation).toBe(
			"always",
		);
	});

	it("dedupes and filters displayIds down to finite numbers", () => {
		const result = normalizeNotchPreferences({
			...defaultNotchPreferences,
			displayIds: [1, 1, 2, "3", NaN, Infinity, 2],
		});
		expect(result.displayIds).toEqual([1, 2]);
	});

	it("keeps x/y only when they are real numbers, nulling them otherwise with no range clamping", () => {
		const result = normalizeNotchPreferences({ ...defaultNotchPreferences, x: "5", y: 12345 });
		expect(result.x).toBeNull();
		// Unlike placement geometry, x/y here are the free-floating notch window
		// position and are passed through with no bounds check at all.
		expect(result.y).toBe(12345);
	});
});
