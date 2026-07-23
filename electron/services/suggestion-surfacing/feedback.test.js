import { describe, expect, it } from "vitest";
import { FEEDBACK_EVENT_TYPES, categoryKey, summarizeFeedback, suppressedPatternTypes } from "./feedback.cjs";

// ---------------------------------------------------------------------------
// WP-3.7's feedback loop, pure. The two assertions that carry the acceptance
// criteria are "three dismissals in a row suppress a category" and "an accept
// clears that count"; the two that carry the isolation model are that a
// verdict never crosses an environment boundary in either direction.
// ---------------------------------------------------------------------------

const CONFIG = { suppressAfterDismissals: 3 };
const TYPE = "sequential_co_occurrence";

let clock = Date.parse("2026-06-01T09:00:00Z");

function event(type, { patternType = TYPE, environmentId = "env-a", ts } = {}) {
	// Each fixture event is a minute after the last unless pinned, so ordering
	// is unambiguous without every test spelling out timestamps.
	clock += 60_000;
	return {
		ts: ts ?? new Date(clock).toISOString(),
		environmentId,
		type,
		subject: "finding-1",
		payload: { patternType },
	};
}

const shown = (options) => event("suggestion.shown", options);
const accepted = (options) => event("suggestion.accepted", options);
const dismissed = (options) => event("suggestion.dismissed", options);

describe("summarizeFeedback", () => {
	it("counts each outcome and reports the category not yet suppressed", () => {
		const summary = summarizeFeedback([shown(), dismissed(), shown(), dismissed()], "env-a", { config: CONFIG });

		expect(summary).toHaveLength(1);
		expect(summary[0]).toMatchObject({
			environmentId: "env-a",
			patternType: TYPE,
			shown: 2,
			dismissed: 2,
			accepted: 0,
			consecutiveDismissals: 2,
			threshold: 3,
			suppressed: false,
		});
	});

	// The headline acceptance criterion: "repeated rejection of a pattern type
	// visibly reduces its suggestions."
	it("suppresses a category once it has been dismissed threshold times in a row", () => {
		const summary = summarizeFeedback([dismissed(), dismissed(), dismissed()], "env-a", { config: CONFIG });

		expect(summary[0].consecutiveDismissals).toBe(3);
		expect(summary[0].suppressed).toBe(true);
	});

	it("does not suppress at one short of the threshold", () => {
		const summary = summarizeFeedback([dismissed(), dismissed()], "env-a", { config: CONFIG });
		expect(summary[0].suppressed).toBe(false);
	});

	// The other half of the rule, and the one that keeps the loop from
	// hardening against a category the user actually uses.
	it("an accept clears the consecutive count, so earlier dismissals stop counting", () => {
		const summary = summarizeFeedback([dismissed(), dismissed(), accepted(), dismissed()], "env-a", {
			config: CONFIG,
		});

		expect(summary[0].dismissed).toBe(3);
		expect(summary[0].accepted).toBe(1);
		// Three lifetime dismissals against a threshold of three -- suppressed
		// only if the rule were a lifetime tally, which is exactly what this
		// fixture exists to rule out.
		expect(summary[0].consecutiveDismissals).toBe(1);
		expect(summary[0].suppressed).toBe(false);
	});

	it("re-suppresses once the run rebuilds after an accept", () => {
		const summary = summarizeFeedback([accepted(), dismissed(), dismissed(), dismissed()], "env-a", {
			config: CONFIG,
		});
		expect(summary[0].suppressed).toBe(true);
	});

	it("orders by timestamp, not array order, so the consecutive rule is not fooled by an out-of-order read", () => {
		const first = dismissed();
		const second = dismissed();
		const third = dismissed();
		const theAccept = accepted();
		// The accept is genuinely last in time; feeding it in first must not
		// change the verdict.
		const summary = summarizeFeedback([theAccept, third, first, second], "env-a", { config: CONFIG });
		expect(summary[0].consecutiveDismissals).toBe(0);
		expect(summary[0].suppressed).toBe(false);
	});

	it("keeps pattern types apart -- rejecting one says nothing about another", () => {
		const summary = summarizeFeedback(
			[
				dismissed({ patternType: "type-a" }),
				dismissed({ patternType: "type-a" }),
				dismissed({ patternType: "type-a" }),
				dismissed({ patternType: "type-b" }),
			],
			"env-a",
			{ config: CONFIG },
		);

		const byType = Object.fromEntries(summary.map((entry) => [entry.patternType, entry]));
		expect(byType["type-a"].suppressed).toBe(true);
		expect(byType["type-b"].suppressed).toBe(false);
	});

	// -- The isolation boundary ----------------------------------------------

	it("ignores another environment's answers entirely", () => {
		const summary = summarizeFeedback(
			[
				dismissed({ environmentId: "env-b" }),
				dismissed({ environmentId: "env-b" }),
				dismissed({ environmentId: "env-b" }),
				dismissed({ environmentId: "env-a" }),
			],
			"env-a",
			{ config: CONFIG },
		);

		// Three dismissals exist in the data. Only the one belonging to env-a
		// may count, so env-a must be nowhere near suppressed.
		expect(summary).toHaveLength(1);
		expect(summary[0].environmentId).toBe("env-a");
		expect(summary[0].dismissed).toBe(1);
		expect(summary[0].suppressed).toBe(false);
	});

	it("refuses to summarize unscoped rather than aggregating across every environment", () => {
		expect(summarizeFeedback([dismissed(), dismissed(), dismissed()], null, { config: CONFIG })).toEqual([]);
		expect(summarizeFeedback([dismissed()], "", { config: CONFIG })).toEqual([]);
	});

	// -- Resets ---------------------------------------------------------------

	it("discounts everything at or before a reset watermark", () => {
		const first = dismissed();
		const second = dismissed();
		const third = dismissed();
		const resets = { [categoryKey("env-a", TYPE)]: third.ts };

		const summary = summarizeFeedback([first, second, third], "env-a", { config: CONFIG, resets });
		// Every event is at or before the watermark, so the category has no
		// history left to show at all.
		expect(summary).toEqual([]);
	});

	it("keeps counting answers given after a reset", () => {
		const before = dismissed();
		const watermark = before.ts;
		const after = [dismissed(), dismissed(), dismissed()];
		const resets = { [categoryKey("env-a", TYPE)]: watermark };

		const summary = summarizeFeedback([before, ...after], "env-a", { config: CONFIG, resets });
		expect(summary[0].dismissed).toBe(3);
		expect(summary[0].suppressed).toBe(true);
		expect(summary[0].resetAt).toBe(new Date(Date.parse(watermark)).toISOString());
	});

	it("applies a reset to one category only", () => {
		const dismissA = [dismissed({ patternType: "type-a" }), dismissed({ patternType: "type-a" })];
		const dismissB = [
			dismissed({ patternType: "type-b" }),
			dismissed({ patternType: "type-b" }),
			dismissed({ patternType: "type-b" }),
		];
		const resets = { [categoryKey("env-a", "type-a")]: dismissA[1].ts };

		const summary = summarizeFeedback([...dismissA, ...dismissB], "env-a", { config: CONFIG, resets });
		const byType = Object.fromEntries(summary.map((entry) => [entry.patternType, entry]));
		expect(byType["type-a"]).toBeUndefined();
		expect(byType["type-b"].suppressed).toBe(true);
	});

	// -- Robustness -----------------------------------------------------------

	it("ignores events that are not feedback outcomes at all", () => {
		const noise = { ts: new Date(clock).toISOString(), environmentId: "env-a", type: "app.focus", payload: {} };
		const summary = summarizeFeedback([noise, dismissed()], "env-a", { config: CONFIG });
		expect(summary[0].dismissed).toBe(1);
		expect(summary[0].shown).toBe(0);
	});

	it("ignores an outcome event with no pattern type to attribute it to", () => {
		const orphan = { ...dismissed(), payload: {} };
		expect(summarizeFeedback([orphan], "env-a", { config: CONFIG })).toEqual([]);
	});

	it("never throws on garbage input", () => {
		expect(summarizeFeedback(null, "env-a", { config: CONFIG })).toEqual([]);
		expect(summarizeFeedback([null, undefined, {}], "env-a", { config: CONFIG })).toEqual([]);
		expect(summarizeFeedback([{ ...dismissed(), ts: "garbage" }], "env-a", { config: CONFIG })).toEqual([]);
	});

	it("falls back to the documented default threshold on a missing or absurd config", () => {
		const three = [dismissed(), dismissed(), dismissed()];
		expect(summarizeFeedback(three, "env-a", {})[0].threshold).toBe(3);
		expect(summarizeFeedback(three, "env-a", { config: { suppressAfterDismissals: 0 } })[0].threshold).toBe(3);
		expect(summarizeFeedback(three, "env-a", { config: { suppressAfterDismissals: "lots" } })[0].threshold).toBe(3);
	});

	it("honours a configured threshold other than the default", () => {
		const one = [dismissed()];
		expect(summarizeFeedback(one, "env-a", { config: { suppressAfterDismissals: 1 } })[0].suppressed).toBe(true);
		expect(summarizeFeedback(one, "env-a", { config: { suppressAfterDismissals: 5 } })[0].suppressed).toBe(false);
	});
});

describe("suppressedPatternTypes", () => {
	it("returns exactly the suppressed categories, as a set", () => {
		const events = [
			dismissed({ patternType: "type-a" }),
			dismissed({ patternType: "type-a" }),
			dismissed({ patternType: "type-a" }),
			dismissed({ patternType: "type-b" }),
		];

		const suppressed = suppressedPatternTypes(events, "env-a", { config: CONFIG });
		expect(suppressed.has("type-a")).toBe(true);
		expect(suppressed.has("type-b")).toBe(false);
		expect(suppressed.size).toBe(1);
	});

	it("is empty when nothing has been rejected often enough", () => {
		expect(suppressedPatternTypes([dismissed()], "env-a", { config: CONFIG }).size).toBe(0);
	});
});

describe("FEEDBACK_EVENT_TYPES", () => {
	it("names exactly the three outcomes WP-3.5 and WP-3.6 record", () => {
		expect([...FEEDBACK_EVENT_TYPES].sort()).toEqual([
			"suggestion.accepted",
			"suggestion.dismissed",
			"suggestion.shown",
		]);
	});
});
