import { describe, expect, it } from "vitest";
import {
	STATES,
	TRANSITIONS,
	MOVABLE_STATUSES,
	canTransition,
	canMoveFinding,
	computeBackoffMs,
	computeSuppressedUntilIso,
	isResurfaceDue,
	isFindingExpired,
} from "./finding-lifecycle.cjs";
import { defaultFindingLifecyclePreferences } from "../../config/finding-lifecycle-prefs.cjs";

const CONFIG = defaultFindingLifecyclePreferences();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("STATES / TRANSITIONS", () => {
	it("has exactly the six states the product vision's flow names", () => {
		expect([...STATES].sort()).toEqual(["accepted", "expired", "ignored", "new", "paused", "suggested"]);
	});

	it("accepted and expired are terminal -- no outgoing edges at all", () => {
		expect(TRANSITIONS.accepted).toEqual([]);
		expect(TRANSITIONS.expired).toEqual([]);
	});

	// WP-3.6. Pausing is the ONE deliberate hold in the machine, so its edges
	// are deliberately asymmetric: it can be entered from anything still live,
	// but leaving it goes back through "suggested" and nowhere else.
	it("paused leads back to suggested and nothing else -- never straight to a decision", () => {
		expect(TRANSITIONS.paused).toEqual(["suggested"]);
		expect(canTransition("paused", "accepted")).toBe(false);
		expect(canTransition("paused", "ignored")).toBe(false);
	});

	it("paused has no edge to expired -- a deliberate hold must never time out", () => {
		expect(canTransition("paused", "expired")).toBe(false);
	});

	it("can be entered from every live state, but from neither terminal one", () => {
		expect(canTransition("new", "paused")).toBe(true);
		expect(canTransition("suggested", "paused")).toBe(true);
		expect(canTransition("ignored", "paused")).toBe(true);
		expect(canTransition("accepted", "paused")).toBe(false);
		expect(canTransition("expired", "paused")).toBe(false);
	});
});

describe("canTransition", () => {
	it("allows every legal edge", () => {
		expect(canTransition("new", "suggested")).toBe(true);
		expect(canTransition("new", "expired")).toBe(true);
		expect(canTransition("suggested", "accepted")).toBe(true);
		expect(canTransition("suggested", "ignored")).toBe(true);
		expect(canTransition("suggested", "expired")).toBe(true);
		expect(canTransition("ignored", "suggested")).toBe(true);
		expect(canTransition("ignored", "expired")).toBe(true);
	});

	it("rejects re-entering a terminal state (the double-accept guard)", () => {
		expect(canTransition("accepted", "accepted")).toBe(false);
		expect(canTransition("expired", "expired")).toBe(false);
	});

	it("rejects every edge out of a terminal state", () => {
		expect(canTransition("accepted", "suggested")).toBe(false);
		expect(canTransition("accepted", "ignored")).toBe(false);
		expect(canTransition("accepted", "expired")).toBe(false);
		expect(canTransition("expired", "suggested")).toBe(false);
		expect(canTransition("expired", "accepted")).toBe(false);
	});

	it("rejects skipping straight from new to a decision, bypassing suggested", () => {
		expect(canTransition("new", "accepted")).toBe(false);
		expect(canTransition("new", "ignored")).toBe(false);
	});

	it("rejects ignored jumping straight to accepted -- it must resurface to suggested first", () => {
		expect(canTransition("ignored", "accepted")).toBe(false);
	});

	it("rejects moving backwards (suggested -> new) and self-loops that aren't listed", () => {
		expect(canTransition("suggested", "new")).toBe(false);
		expect(canTransition("ignored", "ignored")).toBe(false);
		expect(canTransition("suggested", "suggested")).toBe(false);
	});

	it("rejects an unknown state name entirely, rather than throwing", () => {
		expect(canTransition("bogus", "suggested")).toBe(false);
		expect(canTransition("new", "bogus")).toBe(false);
	});
});

describe("computeBackoffMs (increasing back-off)", () => {
	it("the first ignore's window is exactly baseBackoffHours", () => {
		expect(computeBackoffMs(1, CONFIG)).toBe(CONFIG.baseBackoffHours * HOUR);
	});

	it("each successive ignore is longer than the last, not flat or shrinking", () => {
		const first = computeBackoffMs(1, CONFIG);
		const second = computeBackoffMs(2, CONFIG);
		const third = computeBackoffMs(3, CONFIG);
		expect(second).toBeGreaterThan(first);
		expect(third).toBeGreaterThan(second);
	});

	it("matches the exact geometric formula for a fixed config", () => {
		const config = { baseBackoffHours: 10, backoffMultiplier: 3, maxBackoffDays: 365 };
		expect(computeBackoffMs(1, config)).toBe(10 * HOUR);
		expect(computeBackoffMs(2, config)).toBe(10 * HOUR * 3);
		expect(computeBackoffMs(3, config)).toBe(10 * HOUR * 9);
	});

	it("is capped at maxBackoffDays regardless of how large ignoreCount grows", () => {
		const config = { baseBackoffHours: 24, backoffMultiplier: 2, maxBackoffDays: 5 };
		const huge = computeBackoffMs(50, config);
		expect(huge).toBe(5 * DAY);
	});

	it("treats a missing/invalid ignoreCount as 1, never NaN or negative", () => {
		expect(computeBackoffMs(0, CONFIG)).toBe(computeBackoffMs(1, CONFIG));
		expect(computeBackoffMs(-3, CONFIG)).toBe(computeBackoffMs(1, CONFIG));
		expect(computeBackoffMs(undefined, CONFIG)).toBe(computeBackoffMs(1, CONFIG));
		expect(Number.isFinite(computeBackoffMs(NaN, CONFIG))).toBe(true);
	});
});

describe("computeSuppressedUntilIso", () => {
	it("is exactly now + the computed back-off", () => {
		const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
		const config = { baseBackoffHours: 24, backoffMultiplier: 2, maxBackoffDays: 30 };
		const iso = computeSuppressedUntilIso(1, nowMs, config);
		expect(iso).toBe(new Date(nowMs + 24 * HOUR).toISOString());
	});
});

describe("isResurfaceDue", () => {
	const nowMs = Date.parse("2026-01-10T00:00:00.000Z");

	it("is false for anything that isn't currently ignored", () => {
		expect(isResurfaceDue({ status: "suggested", suppressedUntil: null }, nowMs)).toBe(false);
		expect(isResurfaceDue({ status: "new", suppressedUntil: null }, nowMs)).toBe(false);
		expect(isResurfaceDue({ status: "accepted", suppressedUntil: null }, nowMs)).toBe(false);
		expect(isResurfaceDue(null, nowMs)).toBe(false);
	});

	it("is false while still inside the suppression window", () => {
		const future = new Date(nowMs + HOUR).toISOString();
		expect(isResurfaceDue({ status: "ignored", suppressedUntil: future }, nowMs)).toBe(false);
	});

	it("is true once the suppression window has elapsed", () => {
		const past = new Date(nowMs - HOUR).toISOString();
		expect(isResurfaceDue({ status: "ignored", suppressedUntil: past }, nowMs)).toBe(true);
	});

	it("is true (fail-open) for an ignored finding with no suppressedUntil at all", () => {
		expect(isResurfaceDue({ status: "ignored", suppressedUntil: null }, nowMs)).toBe(true);
	});

	it("treats an unparsable suppressedUntil as due rather than stuck forever", () => {
		expect(isResurfaceDue({ status: "ignored", suppressedUntil: "not-a-date" }, nowMs)).toBe(true);
	});
});

describe("isFindingExpired", () => {
	const nowMs = Date.parse("2026-01-30T00:00:00.000Z");
	const config = { expiryDays: 14 };

	it("is false well before the expiry window", () => {
		const suggestedAt = new Date(nowMs - 2 * DAY).toISOString();
		expect(isFindingExpired({ status: "suggested", suggestedAt }, nowMs, config)).toBe(false);
	});

	it("is true once more than expiryDays has elapsed since suggestedAt", () => {
		const suggestedAt = new Date(nowMs - 20 * DAY).toISOString();
		expect(isFindingExpired({ status: "suggested", suggestedAt }, nowMs, config)).toBe(true);
	});

	it("falls back to createdAt when suggestedAt was never set (a finding that sat in 'new' forever)", () => {
		const createdAt = new Date(nowMs - 20 * DAY).toISOString();
		expect(isFindingExpired({ status: "new", suggestedAt: null, createdAt }, nowMs, config)).toBe(true);
	});

	it("is false for a finding in 'new' well within the window", () => {
		const createdAt = new Date(nowMs - DAY).toISOString();
		expect(isFindingExpired({ status: "new", suggestedAt: null, createdAt }, nowMs, config)).toBe(false);
	});

	it("is NEVER true for an accepted finding, no matter how long ago it was suggested", () => {
		// Actively opposing fixture: elapsed time alone would clearly trip the
		// threshold (200 days against a 14-day config) if the terminal-state
		// guard were missing or wrong.
		const suggestedAt = new Date(nowMs - 200 * DAY).toISOString();
		expect(isFindingExpired({ status: "accepted", suggestedAt }, nowMs, config)).toBe(false);
	});

	it("is NEVER true for an already-expired finding", () => {
		const suggestedAt = new Date(nowMs - 200 * DAY).toISOString();
		expect(isFindingExpired({ status: "expired", suggestedAt }, nowMs, config)).toBe(false);
	});

	it("never throws on missing/unparsable timestamps", () => {
		expect(isFindingExpired({ status: "new", suggestedAt: null, createdAt: null }, nowMs, config)).toBe(false);
		expect(isFindingExpired({ status: "new", suggestedAt: "garbage", createdAt: "garbage" }, nowMs, config)).toBe(false);
		expect(isFindingExpired(null, nowMs, config)).toBe(false);
	});

	// WP-3.6: this is the property that makes "pause" mean what the word says.
	// Opposing fixture on purpose -- 200 days against a 14-day window would
	// expire any other non-terminal status by a factor of fourteen.
	it("is NEVER true for a paused finding, no matter how long it has been held", () => {
		const suggestedAt = new Date(nowMs - 200 * DAY).toISOString();
		expect(isFindingExpired({ status: "paused", suggestedAt }, nowMs, config)).toBe(false);
		// The same fixture in the state it was paused FROM does expire, which is
		// what proves the exemption above is the paused check doing the work and
		// not the fixture being too short to trip the threshold.
		expect(isFindingExpired({ status: "suggested", suggestedAt }, nowMs, config)).toBe(true);
	});
});

describe("canMoveFinding (WP-3.6)", () => {
	it("allows every live state -- a decision still in progress can be relocated", () => {
		expect(canMoveFinding({ status: "new" })).toBe(true);
		expect(canMoveFinding({ status: "suggested" })).toBe(true);
		expect(canMoveFinding({ status: "ignored" })).toBe(true);
		expect(canMoveFinding({ status: "paused" })).toBe(true);
	});

	it("refuses an accepted finding -- the rule it produced is scoped to the old environment", () => {
		expect(canMoveFinding({ status: "accepted" })).toBe(false);
	});

	it("refuses an expired finding", () => {
		expect(canMoveFinding({ status: "expired" })).toBe(false);
	});

	it("refuses garbage rather than assuming it is movable", () => {
		expect(canMoveFinding(null)).toBe(false);
		expect(canMoveFinding({})).toBe(false);
		expect(canMoveFinding({ status: "not-a-state" })).toBe(false);
	});

	it("MOVABLE_STATUSES and canMoveFinding never disagree", () => {
		for (const status of STATES) {
			expect(canMoveFinding({ status })).toBe(MOVABLE_STATUSES.includes(status));
		}
	});
});
