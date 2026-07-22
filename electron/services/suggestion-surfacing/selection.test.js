import { describe, expect, it } from "vitest";
import { isSurfaceable, selectFindingToSurface } from "./selection.cjs";
import { defaultFindingLifecyclePreferences } from "../../config/finding-lifecycle-prefs.cjs";

const LIFECYCLE_CONFIG = defaultFindingLifecyclePreferences();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-01-10T12:00:00.000Z");

// A translatable trigger/follow pair (electron/services/pattern-miner/
// finding-translator.cjs's TRIGGER_BUILDERS/ACTION_BUILDERS both have entries
// for session.start/session.stop with no subject required), so a base
// fixture built from this is surfaceable by default -- tests then flip
// exactly one field to prove that field is what excludes it.
function baseFinding(overrides = {}) {
	return {
		id: "f1",
		environmentId: "env-a",
		patternType: "sequential_co_occurrence",
		trigger: { type: "session.start", subject: null },
		follow: { type: "session.stop", subject: null },
		status: "new",
		createdAt: new Date(NOW - DAY).toISOString(),
		suggestedAt: null,
		suppressedUntil: null,
		...overrides,
	};
}

describe("isSurfaceable", () => {
	it("is true for a never-yet-shown ('new') finding", () => {
		expect(isSurfaceable(baseFinding({ status: "new" }), NOW, LIFECYCLE_CONFIG)).toBe(true);
	});

	it("is false for a currently-showing ('suggested') finding -- it's already visible", () => {
		expect(isSurfaceable(baseFinding({ status: "suggested" }), NOW, LIFECYCLE_CONFIG)).toBe(false);
	});

	it("is false for 'accepted'/'expired' -- both terminal", () => {
		expect(isSurfaceable(baseFinding({ status: "accepted" }), NOW, LIFECYCLE_CONFIG)).toBe(false);
		expect(isSurfaceable(baseFinding({ status: "expired" }), NOW, LIFECYCLE_CONFIG)).toBe(false);
	});

	it("is false for an 'ignored' finding still inside its back-off window", () => {
		const suppressedUntil = new Date(NOW + HOUR).toISOString();
		expect(isSurfaceable(baseFinding({ status: "ignored", suppressedUntil }), NOW, LIFECYCLE_CONFIG)).toBe(false);
	});

	it("is true for an 'ignored' finding whose back-off has elapsed", () => {
		const suppressedUntil = new Date(NOW - HOUR).toISOString();
		expect(isSurfaceable(baseFinding({ status: "ignored", suppressedUntil }), NOW, LIFECYCLE_CONFIG)).toBe(true);
	});

	it("is false for a 'new' finding that has sat unshown past the expiry window", () => {
		// Actively opposing fixture: status is "new" (which alone would pass),
		// but createdAt is far enough in the past that isFindingExpired() must
		// be the thing that excludes it.
		const createdAt = new Date(NOW - (LIFECYCLE_CONFIG.expiryDays + 1) * DAY).toISOString();
		expect(isSurfaceable(baseFinding({ status: "new", createdAt, suggestedAt: null }), NOW, LIFECYCLE_CONFIG)).toBe(
			false,
		);
	});

	it("is false for null", () => {
		expect(isSurfaceable(null, NOW, LIFECYCLE_CONFIG)).toBe(false);
	});
});

describe("selectFindingToSurface", () => {
	it("returns null for a null/missing environmentId, never guessing an unscoped answer", () => {
		expect(selectFindingToSurface([baseFinding()], null, NOW, LIFECYCLE_CONFIG)).toBeNull();
		expect(selectFindingToSurface([baseFinding()], undefined, NOW, LIFECYCLE_CONFIG)).toBeNull();
	});

	it("returns null when there is nothing eligible at all", () => {
		expect(selectFindingToSurface([], "env-a", NOW, LIFECYCLE_CONFIG)).toBeNull();
	});

	it("picks the one eligible finding in the requested environment", () => {
		const finding = baseFinding({ id: "only" });
		expect(selectFindingToSurface([finding], "env-a", NOW, LIFECYCLE_CONFIG)).toEqual(finding);
	});

	it("never picks a finding from a DIFFERENT environment, even if it's the only candidate", () => {
		// Actively opposing fixture: this finding would pass every other check.
		const otherEnvFinding = baseFinding({ id: "wrong-env", environmentId: "env-b" });
		expect(selectFindingToSurface([otherEnvFinding], "env-a", NOW, LIFECYCLE_CONFIG)).toBeNull();
	});

	it("never picks a finding whose pattern can't be translated into a rule at all", () => {
		// Actively opposing fixture: status/environment/createdAt all pass; only
		// the untranslatable trigger type should exclude it (task.create has no
		// entry in finding-translator.cjs's TRIGGER_BUILDERS).
		const untranslatable = baseFinding({
			id: "untranslatable",
			trigger: { type: "task.create", subject: "t1" },
			follow: { type: "task.create", subject: "t2" },
		});
		expect(selectFindingToSurface([untranslatable], "env-a", NOW, LIFECYCLE_CONFIG)).toBeNull();
	});

	it("picks the OLDEST eligible finding first, not the newest", () => {
		const older = baseFinding({ id: "older", createdAt: new Date(NOW - 2 * DAY).toISOString() });
		const newer = baseFinding({ id: "newer", createdAt: new Date(NOW - HOUR).toISOString() });
		// Order in the input array deliberately does NOT match createdAt order,
		// so this can't pass by accident of array order.
		const picked = selectFindingToSurface([newer, older], "env-a", NOW, LIFECYCLE_CONFIG);
		expect(picked?.id).toBe("older");
	});

	it("breaks a createdAt tie deterministically by id", () => {
		const sameCreatedAt = new Date(NOW - DAY).toISOString();
		const b = baseFinding({ id: "b", createdAt: sameCreatedAt });
		const a = baseFinding({ id: "a", createdAt: sameCreatedAt });
		expect(selectFindingToSurface([b, a], "env-a", NOW, LIFECYCLE_CONFIG)?.id).toBe("a");
	});

	it("skips an ineligible finding and still returns the one eligible finding alongside it", () => {
		const alreadyAccepted = baseFinding({ id: "accepted", status: "accepted" });
		const eligible = baseFinding({ id: "eligible", status: "new" });
		expect(selectFindingToSurface([alreadyAccepted, eligible], "env-a", NOW, LIFECYCLE_CONFIG)?.id).toBe(
			"eligible",
		);
	});
});
