import { describe, expect, it } from "vitest";
import {
	FINDING_STATUS_LABELS,
	availableFindingActions,
	describeFindingState,
	formatConfidence,
	formatLift,
	moveTargetsFor,
} from "./findingActions";
import type { Environment, Finding, FindingStatus } from "../../types";

// ---------------------------------------------------------------------------
// WP-3.6's management surface, pure half. These tests pin down which controls
// are offered for a finding in each state -- deliberately mirroring
// electron/services/pattern-miner/finding-lifecycle.cjs's own test file, since
// a disagreement between the two is exactly the drift that would show the user
// a button the main process is guaranteed to refuse.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-06-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function makeFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: "finding-1",
		environmentId: "env-a",
		patternType: "sequential_co_occurrence",
		trigger: { type: "app.focus", subject: "Editor" },
		follow: { type: "app.focus", subject: "Server" },
		windowMinutes: 30,
		occurrences: 12,
		trials: 15,
		confidence: 0.8,
		baselineProbability: 0.1,
		lift: 8,
		pValue: 0.0001,
		status: "suggested",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		ignoreCount: 0,
		suppressedUntil: null,
		suggestedAt: "2026-05-02T00:00:00.000Z",
		decidedAt: null,
		acceptedRuleId: null,
		label: null,
		description: "When X, then Y",
		convertible: true,
		...overrides,
	};
}

function makeEnvironment(id: string, isolationMode: Environment["isolation_mode"] = "connected"): Environment {
	return {
		id,
		name: id,
		isolation_mode: isolationMode,
		archived_at: null,
		created_at: "2026-01-01T00:00:00.000Z",
	} as Environment;
}

describe("availableFindingActions", () => {
	it("offers every decision on a suggested finding", () => {
		const actions = availableFindingActions(makeFinding({ status: "suggested" }), NOW);
		expect(actions.accept).toBe(true);
		expect(actions.convert).toBe(true);
		expect(actions.ignore).toBe(true);
		expect(actions.pause).toBe(true);
		expect(actions.unpause).toBe(false);
	});

	it("offers a decision on a new finding -- the service promotes it through suggested itself", () => {
		const actions = availableFindingActions(makeFinding({ status: "new" }), NOW);
		expect(actions.accept).toBe(true);
		expect(actions.ignore).toBe(true);
	});

	it("offers no decision on an accepted or expired finding", () => {
		for (const status of ["accepted", "expired"] as FindingStatus[]) {
			const actions = availableFindingActions(makeFinding({ status }), NOW);
			expect(actions.accept).toBe(false);
			expect(actions.convert).toBe(false);
			expect(actions.ignore).toBe(false);
			expect(actions.pause).toBe(false);
			expect(actions.move).toBe(false);
		}
	});

	it("still offers rename and delete on a terminal finding -- neither says anything about the pattern", () => {
		const actions = availableFindingActions(makeFinding({ status: "accepted" }), NOW);
		expect(actions.edit).toBe(true);
		expect(actions.remove).toBe(true);
	});

	it("withholds accept and convert from an inexpressible pattern, but not dismiss", () => {
		const actions = availableFindingActions(makeFinding({ convertible: false }), NOW);
		expect(actions.accept).toBe(false);
		expect(actions.convert).toBe(false);
		expect(actions.ignore).toBe(true);
	});

	// The clock-dependent case: an ignored finding is only decidable again once
	// its own back-off has run out, mirroring ensureSuggested's isResurfaceDue
	// check. Both halves asserted, so a fixture that simply never trips the
	// window cannot pass this by accident.
	it("withholds a decision from a dismissed finding still inside its back-off, and restores it after", () => {
		const suppressed = makeFinding({
			status: "ignored",
			suppressedUntil: new Date(NOW + 6 * HOUR).toISOString(),
		});
		expect(availableFindingActions(suppressed, NOW).accept).toBe(false);
		expect(availableFindingActions(suppressed, NOW).ignore).toBe(false);

		const elapsed = makeFinding({
			status: "ignored",
			suppressedUntil: new Date(NOW - HOUR).toISOString(),
		});
		expect(availableFindingActions(elapsed, NOW).accept).toBe(true);
		expect(availableFindingActions(elapsed, NOW).ignore).toBe(true);
	});

	it("treats an unparsable back-off as elapsed rather than trapping the finding forever", () => {
		const finding = makeFinding({ status: "ignored", suppressedUntil: "not-a-date" });
		expect(availableFindingActions(finding, NOW).accept).toBe(true);
	});

	it("offers resume, and only resume, on a paused finding", () => {
		const actions = availableFindingActions(makeFinding({ status: "paused" }), NOW);
		expect(actions.unpause).toBe(true);
		expect(actions.pause).toBe(false);
		// Deciding straight from paused is legal -- the service routes it back
		// through suggested itself, with no separate unpause step.
		expect(actions.accept).toBe(true);
		expect(actions.ignore).toBe(true);
	});
});

describe("moveTargetsFor", () => {
	const environments = [makeEnvironment("env-a"), makeEnvironment("env-b"), makeEnvironment("env-c")];

	it("offers every other connected environment", () => {
		const targets = moveTargetsFor(makeFinding({ environmentId: "env-a" }), environments);
		expect(targets.map((environment) => environment.id)).toEqual(["env-b", "env-c"]);
	});

	it("never offers the finding's own environment", () => {
		const targets = moveTargetsFor(makeFinding({ environmentId: "env-b" }), environments);
		expect(targets.map((environment) => environment.id)).not.toContain("env-b");
	});

	it("offers nothing at all when the finding lives in an enclosed environment", () => {
		const withEnclosedSource = [makeEnvironment("env-a", "enclosed"), makeEnvironment("env-b")];
		expect(moveTargetsFor(makeFinding({ environmentId: "env-a" }), withEnclosedSource)).toEqual([]);
	});

	it("filters enclosed destinations out", () => {
		const withEnclosedTarget = [makeEnvironment("env-a"), makeEnvironment("env-b", "enclosed"), makeEnvironment("env-c")];
		const targets = moveTargetsFor(makeFinding({ environmentId: "env-a" }), withEnclosedTarget);
		expect(targets.map((environment) => environment.id)).toEqual(["env-c"]);
	});

	it("offers nothing when the finding's environment isn't in the list at all", () => {
		expect(moveTargetsFor(makeFinding({ environmentId: "env-gone" }), environments)).toEqual([]);
	});
});

describe("describeFindingState", () => {
	it("explains that a paused finding neither surfaces nor expires", () => {
		const note = describeFindingState(makeFinding({ status: "paused" }), NOW);
		expect(note).toContain("won't expire");
	});

	it("explains an accepted finding's missing evidence rather than leaving it a mystery", () => {
		expect(describeFindingState(makeFinding({ status: "accepted" }), NOW)).toContain("evidence");
	});

	it("says when a dismissed finding is due back, and when it already is", () => {
		const suppressed = makeFinding({
			status: "ignored",
			ignoreCount: 2,
			suppressedUntil: new Date(NOW + 6 * HOUR).toISOString(),
		});
		expect(describeFindingState(suppressed, NOW)).toContain("won't come back before");

		const elapsed = makeFinding({
			status: "ignored",
			ignoreCount: 2,
			suppressedUntil: new Date(NOW - HOUR).toISOString(),
		});
		expect(describeFindingState(elapsed, NOW)).toContain("Due to be offered again");
	});

	it("adds nothing for states the badge already explains", () => {
		expect(describeFindingState(makeFinding({ status: "new" }), NOW)).toBeNull();
		expect(describeFindingState(makeFinding({ status: "suggested" }), NOW)).toBeNull();
	});
});

describe("formatting", () => {
	it("renders confidence as a whole percentage", () => {
		expect(formatConfidence(0.8421)).toBe("84%");
		expect(formatConfidence(1)).toBe("100%");
	});

	it("renders lift to one decimal", () => {
		expect(formatLift(7.3241)).toBe("7.3×");
	});

	it("degrades to a dash rather than NaN", () => {
		expect(formatConfidence(Number.NaN)).toBe("—");
		expect(formatLift(Number.POSITIVE_INFINITY)).toBe("—");
	});

	it("has a label for every status the state machine can produce", () => {
		const statuses: FindingStatus[] = ["new", "suggested", "accepted", "ignored", "expired", "paused"];
		for (const status of statuses) {
			expect(FINDING_STATUS_LABELS[status]).toBeTruthy();
		}
	});
});
