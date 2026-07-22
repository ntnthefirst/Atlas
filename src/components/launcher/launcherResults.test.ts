import { describe, expect, it } from "vitest";
import { clampSelectedIndex, moveSelection, reconcileLauncherResults } from "./launcherResults";
import type { LauncherResult } from "../../types";

function result(id: string, title = id): LauncherResult {
	return { id, kind: "action", title };
}

describe("reconcileLauncherResults (WP-2.1)", () => {
	it("uses the incoming order as-is when selection is not active", () => {
		const previous = [result("a"), result("b")];
		const next = [result("c"), result("a")];

		expect(reconcileLauncherResults(previous, next, false)).toEqual(next);
	});

	it("uses the incoming order as-is when there is nothing previously shown", () => {
		const next = [result("a"), result("b")];
		expect(reconcileLauncherResults([], next, true)).toEqual(next);
	});

	// The core guarantee: an active selection must not be yanked around by a
	// query update that reorders/adds/removes rows.
	it("keeps existing rows in their CURRENT position while selection is active", () => {
		const previous = [result("a"), result("b"), result("c")];
		// The provider now (for whatever reason -- a re-ranked query) returns
		// these in a completely different order.
		const next = [result("c"), result("b"), result("a")];

		expect(reconcileLauncherResults(previous, next, true)).toEqual([result("a"), result("b"), result("c")]);
	});

	it("drops rows that disappeared from the new results without leaving a gap", () => {
		const previous = [result("a"), result("b"), result("c")];
		const next = [result("a"), result("c")];

		expect(reconcileLauncherResults(previous, next, true)).toEqual([result("a"), result("c")]);
	});

	it("appends brand-new rows after the existing ones, never inserting above the cursor", () => {
		const previous = [result("a"), result("b")];
		const next = [result("new"), result("b"), result("a")];

		expect(reconcileLauncherResults(previous, next, true)).toEqual([result("a"), result("b"), result("new")]);
	});

	it("refreshes row content (title/subtitle) in place without moving it", () => {
		const previous = [result("a", "Old title")];
		const next = [result("a", "New title")];

		expect(reconcileLauncherResults(previous, next, true)).toEqual([result("a", "New title")]);
	});
});

describe("clampSelectedIndex", () => {
	it("returns 0 for an empty list regardless of index", () => {
		expect(clampSelectedIndex(5, 0)).toBe(0);
		expect(clampSelectedIndex(-3, 0)).toBe(0);
	});

	it("clamps a negative index up to 0", () => {
		expect(clampSelectedIndex(-1, 5)).toBe(0);
	});

	it("clamps an out-of-range index down to the last row", () => {
		expect(clampSelectedIndex(10, 3)).toBe(2);
	});

	it("passes an in-range index through unchanged", () => {
		expect(clampSelectedIndex(1, 3)).toBe(1);
	});
});

describe("moveSelection", () => {
	it("moves down by one", () => {
		expect(moveSelection(0, 4, 1)).toBe(1);
	});

	it("moves up by one", () => {
		expect(moveSelection(2, 4, -1)).toBe(1);
	});

	it("wraps from the last row to the first on Down", () => {
		expect(moveSelection(3, 4, 1)).toBe(0);
	});

	it("wraps from the first row to the last on Up", () => {
		expect(moveSelection(0, 4, -1)).toBe(3);
	});

	it("returns 0 for an empty list", () => {
		expect(moveSelection(0, 0, 1)).toBe(0);
	});
});
