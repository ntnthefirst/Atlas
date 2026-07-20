import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, normalizeTrackedAppName, pad } from "./formatters";

describe("pad", () => {
	it("adds a leading zero to single digits", () => {
		expect(pad(0)).toBe("00");
		expect(pad(7)).toBe("07");
	});

	it("leaves two-digit numbers unchanged", () => {
		expect(pad(42)).toBe("42");
	});

	it("does not truncate numbers wider than two digits", () => {
		expect(pad(123)).toBe("123");
	});

	it("leaves negative numbers unchanged, since the sign already fills the width", () => {
		expect(pad(-5)).toBe("-5");
	});
});

describe("formatClock", () => {
	it("formats zero as a zeroed clock", () => {
		expect(formatClock(0)).toBe("00:00:00");
	});

	it("clamps negative durations to zero", () => {
		expect(formatClock(-5000)).toBe("00:00:00");
	});

	it("formats hours, minutes and seconds", () => {
		// 1h 1m 1s
		expect(formatClock(3_661_000)).toBe("01:01:01");
	});

	it("floors fractional seconds rather than rounding", () => {
		// 1500ms is 1.5s, which should truncate down to 1s, not round to 2s.
		expect(formatClock(1_500)).toBe("00:00:01");
	});

	it("does not pad hour counts past two digits", () => {
		// 100 hours exactly.
		expect(formatClock(360_000_000)).toBe("100:00:00");
	});
});

describe("formatDuration", () => {
	it("formats zero as a zeroed duration", () => {
		expect(formatDuration(0)).toBe("0h 00m 00s");
	});

	it("clamps negative durations to zero", () => {
		expect(formatDuration(-100)).toBe("0h 00m 00s");
	});

	it("pads minutes and seconds but leaves hours unpadded", () => {
		// 1h 1m 1s
		expect(formatDuration(3_661_000)).toBe("1h 01m 01s");
	});

	it("floors fractional seconds rather than rounding", () => {
		expect(formatDuration(1_500)).toBe("0h 00m 01s");
	});

	it("handles very large durations without truncating the hour count", () => {
		expect(formatDuration(360_000_000)).toBe("100h 00m 00s");
	});
});

describe("normalizeTrackedAppName", () => {
	it("returns a clean name unchanged", () => {
		expect(normalizeTrackedAppName("Chrome")).toBe("Chrome");
	});

	it("strips a single bracketed suffix", () => {
		expect(normalizeTrackedAppName("Chrome [Private Browsing]")).toBe("Chrome");
	});

	it("strips multiple bracketed segments and collapses the gap they leave behind", () => {
		expect(normalizeTrackedAppName("App [Tag1] [Tag2] Name")).toBe("App Name");
	});

	it("collapses runs of internal whitespace", () => {
		expect(normalizeTrackedAppName("App   Name")).toBe("App Name");
	});

	it("falls back to Unknown for an empty string", () => {
		expect(normalizeTrackedAppName("")).toBe("Unknown");
	});

	it("falls back to Unknown for a whitespace-only string", () => {
		expect(normalizeTrackedAppName("   ")).toBe("Unknown");
	});

	it("falls back to Unknown when the whole value is a bracketed tag", () => {
		expect(normalizeTrackedAppName("[Only Tag]")).toBe("Unknown");
	});
});
