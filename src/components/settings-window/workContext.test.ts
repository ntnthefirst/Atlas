import { describe, expect, it } from "vitest";
import { CONTEXT_LABELS, EMPTY_CONTEXT_STATUS, describeContextStatus } from "./workContext";
import type { ContextStatus, WorkContext } from "../../types";

// ---------------------------------------------------------------------------
// WP-2.8's status wording. The assertion that matters is precedence: a pin
// beats detection in context-service.cjs (getEffectiveContext returns
// `pinnedContext ?? state.context`), so the sentence must never report a
// detected context as being in force while something else is pinned.
// ---------------------------------------------------------------------------

function status(overrides: Partial<ContextStatus> = {}): ContextStatus {
	return { ...EMPTY_CONTEXT_STATUS, ...overrides };
}

describe("describeContextStatus", () => {
	it("reports a pin, and says detection won't override it", () => {
		const text = describeContextStatus(
			status({ isPinned: true, pinnedContext: "coding", polling: true, context: "browsing" }),
		);
		expect(text).toContain("Pinned to Coding");
		// The opposing half: detection has committed to Browsing, and the
		// sentence must not report that as what's in force.
		expect(text).not.toContain("Browsing");
	});

	it("reports a pin even when detection isn't running -- a pin is absolute", () => {
		expect(describeContextStatus(status({ isPinned: true, pinnedContext: "browsing", polling: false }))).toContain(
			"Pinned to Browsing",
		);
	});

	it("says detection is off when it is off and nothing is pinned", () => {
		expect(describeContextStatus(status({ polling: false }))).toBe(
			"Detection is off, so no context is being applied.",
		);
	});

	it("names the current context while detecting", () => {
		expect(describeContextStatus(status({ polling: true, effectiveContext: "communication" }))).toBe(
			"Currently Communication.",
		);
	});

	// A candidate is a context that hasn't held long enough to win yet, which
	// is genuinely useful to see -- it explains a switch that is about to
	// happen, or one that keeps not happening.
	it("mentions a candidate that hasn't held long enough yet", () => {
		const text = describeContextStatus(
			status({ polling: true, effectiveContext: "coding", candidate: "browsing" }),
		);
		expect(text).toContain("Currently Coding");
		expect(text).toContain("leaning towards Browsing");
	});

	it("explains the normal empty state rather than leaving it blank", () => {
		const text = describeContextStatus(status({ polling: true, effectiveContext: null }));
		expect(text).toBeTruthy();
		expect(text).toContain("held for a while");
	});

	it("has a label for every context the detector can produce", () => {
		const contexts: WorkContext[] = ["coding", "communication", "browsing"];
		for (const context of contexts) {
			expect(CONTEXT_LABELS[context]).toBeTruthy();
		}
	});

	it("starts from an empty status that reads as 'off', not as an error", () => {
		expect(describeContextStatus(EMPTY_CONTEXT_STATUS)).toBe("Detection is off, so no context is being applied.");
	});
});
