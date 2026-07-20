import { describe, expect, it } from "vitest";
import {
	DASHBOARD_PREFS_FILE,
	DASHBOARD_WIDGET_IDS,
	DASHBOARD_MAX_COLS,
	DASHBOARD_WIDGET_MAX_H,
	defaultDashboardWidgets,
	defaultDashboardPreferences,
	normalizeDashboardPreferences,
} from "./dashboard-prefs.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing dashboard-prefs.cjs across that boundary
// works, while the reverse does not: vitest's CJS entrypoint deliberately
// throws.

describe("schema constants", () => {
	it("names the preferences file", () => {
		expect(DASHBOARD_PREFS_FILE).toBe("dashboard-preferences.json");
	});

	it("includes the known widget ids used in the default layout", () => {
		for (const widget of defaultDashboardWidgets) {
			expect(DASHBOARD_WIDGET_IDS).toContain(widget.widget);
		}
	});
});

describe("normalizeDashboardPreferences — invalid top-level input", () => {
	it("falls back to defaults for null", () => {
		expect(normalizeDashboardPreferences(null)).toEqual(defaultDashboardPreferences);
	});

	it("falls back to defaults for undefined", () => {
		expect(normalizeDashboardPreferences(undefined)).toEqual(defaultDashboardPreferences);
	});

	it("falls back to defaults for a non-object (string)", () => {
		expect(normalizeDashboardPreferences("widgets")).toEqual(defaultDashboardPreferences);
	});

	it("falls back to defaults for a non-object (number)", () => {
		expect(normalizeDashboardPreferences(42)).toEqual(defaultDashboardPreferences);
	});

	it("falls back to defaults when widgets is missing", () => {
		expect(normalizeDashboardPreferences({})).toEqual(defaultDashboardPreferences);
	});

	it("falls back to defaults when widgets is not an array", () => {
		expect(normalizeDashboardPreferences({ widgets: "not-an-array" })).toEqual(defaultDashboardPreferences);
	});

	it("returns a deep copy of the defaults, not the shared instance", () => {
		const result = normalizeDashboardPreferences(null);
		result.widgets.push({ id: "extra", widget: "clock", w: 1, h: 1 });
		expect(defaultDashboardWidgets).toHaveLength(5);
	});
});

describe("normalizeDashboardPreferences — entry filtering", () => {
	it("drops null and non-object entries, falling back when nothing survives", () => {
		expect(normalizeDashboardPreferences({ widgets: [null, undefined, "string", 42] })).toEqual(
			defaultDashboardPreferences,
		);
	});

	it("drops entries whose widget id is not in DASHBOARD_WIDGET_IDS", () => {
		const result = normalizeDashboardPreferences({
			widgets: [{ id: "bogus", widget: "notARealWidget", w: 1, h: 1 }],
		});
		expect(result).toEqual(defaultDashboardPreferences);
	});

	it("keeps valid entries and drops invalid ones out of a mixed list", () => {
		const result = normalizeDashboardPreferences({
			widgets: [
				{ id: "a", widget: "clock", w: 2, h: 2 },
				{ id: "b", widget: "bogus", w: 1, h: 1 },
			],
		});
		expect(result.widgets).toEqual([{ id: "a", widget: "clock", w: 2, h: 2 }]);
	});

	it("drops a duplicate id, keeping the first occurrence", () => {
		const result = normalizeDashboardPreferences({
			widgets: [
				{ id: "a", widget: "clock", w: 1, h: 1 },
				{ id: "a", widget: "date", w: 2, h: 2 },
			],
		});
		expect(result.widgets).toEqual([{ id: "a", widget: "clock", w: 1, h: 1 }]);
	});

	it("assigns a dash-<index> id when the id is missing", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ widget: "clock", w: 1, h: 1 }] });
		expect(result.widgets[0].id).toBe("dash-0");
	});

	it("assigns a dash-<index> id when the id is blank", () => {
		const result = normalizeDashboardPreferences({
			widgets: [
				{ id: "keep", widget: "clock", w: 1, h: 1 },
				{ id: "   ", widget: "date", w: 1, h: 1 },
			],
		});
		expect(result.widgets[1].id).toBe("dash-1");
	});
});

describe("normalizeDashboardPreferences — geometry clamping", () => {
	it("clamps w above DASHBOARD_MAX_COLS down to the max", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 10, h: 1 }] });
		expect(result.widgets[0].w).toBe(DASHBOARD_MAX_COLS);
	});

	it("clamps w below the minimum up to 1", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 0, h: 1 }] });
		expect(result.widgets[0].w).toBe(1);
	});

	it("falls back a non-numeric w to 1", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: "abc", h: 1 }] });
		expect(result.widgets[0].w).toBe(1);
	});

	it("rounds a fractional w to the nearest integer before clamping", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 2.7, h: 1 }] });
		expect(result.widgets[0].w).toBe(3);
	});

	it("clamps h above DASHBOARD_WIDGET_MAX_H down to the max", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 1, h: 100 }] });
		expect(result.widgets[0].h).toBe(DASHBOARD_WIDGET_MAX_H);
	});

	it("clamps a negative h up to 1", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 1, h: -1 }] });
		expect(result.widgets[0].h).toBe(1);
	});

	it("falls back a non-numeric h (NaN) to 1", () => {
		const result = normalizeDashboardPreferences({ widgets: [{ id: "a", widget: "clock", w: 1, h: NaN }] });
		expect(result.widgets[0].h).toBe(1);
	});
});

describe("normalizeDashboardPreferences — config field", () => {
	it("trims and keeps a non-empty config string", () => {
		const result = normalizeDashboardPreferences({
			widgets: [{ id: "a", widget: "launchApp", w: 1, h: 1, config: "  hello  " }],
		});
		expect(result.widgets[0].config).toBe("hello");
	});

	it("omits config entirely when it is blank", () => {
		const result = normalizeDashboardPreferences({
			widgets: [{ id: "a", widget: "launchApp", w: 1, h: 1, config: "   " }],
		});
		expect(result.widgets[0]).not.toHaveProperty("config");
	});

	it("omits config when it is not a string", () => {
		const result = normalizeDashboardPreferences({
			widgets: [{ id: "a", widget: "launchApp", w: 1, h: 1, config: 42 }],
		});
		expect(result.widgets[0]).not.toHaveProperty("config");
	});

	it("slices an overly long config string down to 500 characters", () => {
		const longConfig = "x".repeat(600);
		const result = normalizeDashboardPreferences({
			widgets: [{ id: "a", widget: "launchApp", w: 1, h: 1, config: longConfig }],
		});
		expect(result.widgets[0].config).toHaveLength(500);
	});
});

describe("normalizeDashboardPreferences — round trip", () => {
	it("returns an equivalent structure when given the current defaults", () => {
		expect(normalizeDashboardPreferences(defaultDashboardPreferences)).toEqual(defaultDashboardPreferences);
	});
});
