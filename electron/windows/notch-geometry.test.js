import { describe, expect, it } from "vitest";
import { FREE_POSITION_MARGIN, computeNotchBounds, selectTargetDisplays } from "./notch-geometry.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing notch-geometry.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws.

describe("computeNotchBounds", () => {
	// A primary display with a taskbar eating 40px off the bottom of a
	// 1920x1080 screen: bounds would be the full 1080, workArea is the 1040
	// that's actually free — the function only ever sees workArea.
	const primaryWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };

	it("centers a top-docked notch horizontally and flushes it to the workArea's top edge", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "top",
			isPrimary: true,
		});
		expect(result).toEqual({ x: 810, y: 0, width: 300, height: 70 });
	});

	it("flushes a left-docked notch to the workArea's left edge and centers it vertically", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "left",
			isPrimary: true,
		});
		expect(result).toEqual({ x: 0, y: 485, width: 300, height: 70 });
	});

	it("flushes a right-docked notch to the workArea's right edge and centers it vertically", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "right",
			isPrimary: true,
		});
		expect(result).toEqual({ x: 1620, y: 485, width: 300, height: 70 });
	});

	it("uses saved free coordinates verbatim (rounded) on the primary display", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "free",
			isPrimary: true,
			freeX: 250,
			freeY: 15,
		});
		expect(result).toEqual({ x: 250, y: 15, width: 300, height: 70 });
	});

	it("rounds fractional saved free coordinates", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "free",
			isPrimary: true,
			freeX: 250.4,
			freeY: 15.6,
		});
		// Math.round(15.6) rounds up to 16, not down.
		expect(result).toEqual({ x: 250, y: 16, width: 300, height: 70 });
	});

	it("falls back to centered-near-top-with-margin for free position with no saved coordinates", () => {
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "free",
			isPrimary: true,
		});
		expect(result).toEqual({ x: 810, y: FREE_POSITION_MARGIN, width: 300, height: 70 });
	});

	it("ignores saved free coordinates entirely on a non-primary display, even when position is free", () => {
		// Surprising: the free-coordinate branch requires isPrimary, so a
		// secondary display with position "free" always falls through to the
		// centered-near-top-with-margin default, never the saved x/y.
		const result = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "free",
			isPrimary: false,
			freeX: 999,
			freeY: 999,
		});
		expect(result).toEqual({ x: 810, y: FREE_POSITION_MARGIN, width: 300, height: 70 });
	});

	it("docks left/right/top the same way on a non-primary display as on the primary", () => {
		const left = computeNotchBounds({
			workArea: primaryWorkArea,
			width: 300,
			height: 70,
			position: "left",
			isPrimary: false,
		});
		expect(left).toEqual({ x: 0, y: 485, width: 300, height: 70 });
	});

	it("rounds a half-pixel centering offset up (Math.round, not floor)", () => {
		// (1921 - 300) / 2 === 810.5, which Math.round takes to 811.
		const result = computeNotchBounds({
			workArea: { x: 0, y: 0, width: 1921, height: 1081 },
			width: 300,
			height: 70,
			position: "top",
			isPrimary: true,
		});
		expect(result.x).toBe(811);
	});

	// --- Multi-monitor: a display to the left of/above the primary has a
	// negative workArea origin. This is where real positioning bugs live —
	// an accidental `x = width - notchWidth` instead of `x = area.x + ...`
	// would silently ignore the negative origin.
	describe("secondary display with a negative workArea origin", () => {
		const leftOfPrimary = { x: -1920, y: 0, width: 1920, height: 1080 };

		it("keeps the negative x origin for a top-docked notch", () => {
			const result = computeNotchBounds({
				workArea: leftOfPrimary,
				width: 300,
				height: 70,
				position: "top",
				isPrimary: false,
			});
			expect(result).toEqual({ x: -1110, y: 0, width: 300, height: 70 });
		});

		it("keeps the negative x origin for a left-docked notch", () => {
			const result = computeNotchBounds({
				workArea: leftOfPrimary,
				width: 300,
				height: 70,
				position: "left",
				isPrimary: false,
			});
			expect(result).toEqual({ x: -1920, y: 505, width: 300, height: 70 });
		});

		it("still lands in negative territory for a right-docked notch when the whole display is left of origin", () => {
			const result = computeNotchBounds({
				workArea: leftOfPrimary,
				width: 300,
				height: 70,
				position: "right",
				isPrimary: false,
			});
			expect(result).toEqual({ x: -300, y: 505, width: 300, height: 70 });
		});

		it("handles a display that is both left of and above the primary (negative x and y)", () => {
			const aboveAndLeft = { x: -1920, y: -200, width: 1920, height: 1080 };
			const result = computeNotchBounds({
				workArea: aboveAndLeft,
				width: 300,
				height: 70,
				position: "right",
				isPrimary: false,
			});
			expect(result).toEqual({ x: -300, y: 305, width: 300, height: 70 });
		});
	});
});

describe("selectTargetDisplays", () => {
	const primary = { id: 1, label: "primary" };
	const secondary = { id: 2, label: "secondary" };
	const third = { id: 3, label: "third" };
	const displays = [third, primary, secondary];

	it("selects only the primary display when no preference is saved (empty array)", () => {
		expect(selectTargetDisplays(displays, primary, [])).toEqual([primary]);
	});

	it("selects only the primary display when the preference is null", () => {
		expect(selectTargetDisplays(displays, primary, null)).toEqual([primary]);
	});

	it("selects only the primary display when the preference is undefined", () => {
		expect(selectTargetDisplays(displays, primary, undefined)).toEqual([primary]);
	});

	it("returns matched displays in the connected-displays list order, not the preference order", () => {
		const result = selectTargetDisplays(displays, primary, [2, 3]);
		expect(result).toEqual([third, secondary]);
	});

	it("returns every display when all are selected", () => {
		const result = selectTargetDisplays(displays, primary, [1, 2, 3]);
		expect(result).toEqual([third, primary, secondary]);
	});

	it("returns a single matched display when only one id is selected", () => {
		expect(selectTargetDisplays(displays, primary, [2])).toEqual([secondary]);
	});

	it("falls back to the primary display object when none of the saved ids are connected", () => {
		const disconnectedPrimary = { id: 99, label: "unplugged" };
		const result = selectTargetDisplays(displays, disconnectedPrimary, [42, 43]);
		expect(result).toEqual([disconnectedPrimary]);
	});

	it("ignores unmatched ids mixed in with matched ones rather than falling back", () => {
		const result = selectTargetDisplays(displays, primary, [2, 12345]);
		expect(result).toEqual([secondary]);
	});
});
