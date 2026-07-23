import { describe, expect, it } from "vitest";
import {
	ACTION_CHOICES,
	CONDITION_CHOICES,
	TRIGGER_CHOICES,
	blankAction,
	blankCondition,
	blankTrigger,
	canSave,
	describeDryRunReason,
	describeGaps,
	draftFromRule,
	draftToInput,
	isValidTime,
	type SmartFunctionDraft,
} from "./smartFunctionForm";
import type { SmartFunction } from "../../types";

// ---------------------------------------------------------------------------
// WP-3.2's editor logic. The assertion that carries "users build rules without
// a manual" is the gap-naming one: the engine's normalizer silently DROPS a
// malformed condition or action, so anything it would drop has to be named
// here first, or the user saves a rule and gets back a different one with no
// explanation.
// ---------------------------------------------------------------------------

function draft(overrides: Partial<SmartFunctionDraft> = {}): SmartFunctionDraft {
	return {
		label: "A rule",
		environmentId: null,
		enabled: true,
		trigger: { type: "session.started" },
		conditions: [],
		actions: [{ type: "timer", mode: "start" }],
		...overrides,
	};
}

describe("the vocabulary the form offers", () => {
	// Every choice must produce a value the form can actually render and the
	// engine can actually store -- a choice with no blank value is a dropdown
	// entry that breaks the editor the moment it is picked.
	it("has a blank value for every trigger choice", () => {
		for (const choice of TRIGGER_CHOICES) {
			expect(blankTrigger(choice.value).type, choice.value).toBe(choice.value);
		}
	});

	it("has a blank value for every condition choice", () => {
		for (const choice of CONDITION_CHOICES) {
			expect(blankCondition(choice.value).type, choice.value).toBe(choice.value);
		}
	});

	it("has a blank value for every action choice", () => {
		for (const choice of ACTION_CHOICES) {
			expect(blankAction(choice.value).type, choice.value).toBe(choice.value);
		}
	});

	it("starts a time trigger and a time window on valid times, not blanks the user must fix", () => {
		const trigger = blankTrigger("time.of_day");
		expect(trigger.type === "time.of_day" && isValidTime(trigger.time)).toBe(true);

		const condition = blankCondition("time_window");
		expect(condition.type === "time_window" && isValidTime(condition.start) && isValidTime(condition.end)).toBe(true);
	});
});

describe("describeGaps", () => {
	it("says nothing about a complete draft", () => {
		expect(describeGaps(draft())).toEqual([]);
		expect(canSave(draft())).toBe(true);
	});

	it("asks for at least one thing to do", () => {
		const gaps = describeGaps(draft({ actions: [] }));
		expect(gaps).toContain("Add at least one thing for this to do.");
		expect(canSave(draft({ actions: [] }))).toBe(false);
	});

	// Each of these is a case where the engine's normalizer returns null and
	// drops the step entirely.
	it("names an action missing the one field it needs, per type", () => {
		expect(describeGaps(draft({ actions: [{ type: "launchApp", command: "  " }] }))).toEqual([
			"Step 1 needs an app to open.",
		]);
		expect(describeGaps(draft({ actions: [{ type: "openUrl", url: "" }] }))).toEqual([
			"Step 1 needs a link to open.",
		]);
		expect(describeGaps(draft({ actions: [{ type: "switchEnvironment", environmentId: "" }] }))).toEqual([
			"Step 1 needs an environment to switch to.",
		]);
		expect(describeGaps(draft({ actions: [{ type: "createTask", title: "", column: null }] }))).toEqual([
			"Step 1 needs a task title.",
		]);
	});

	it("names a condition missing the one field it needs, per type", () => {
		expect(describeGaps(draft({ conditions: [{ type: "environment", environmentId: "" }] }))).toEqual([
			"Condition 1 needs an environment.",
		]);
		expect(describeGaps(draft({ conditions: [{ type: "app_running", processName: " " }] }))).toEqual([
			"Condition 1 needs an app name.",
		]);
		expect(describeGaps(draft({ conditions: [{ type: "time_window", start: "9am", end: "17:00" }] }))).toEqual([
			"Condition 1 needs both times in 24-hour HH:MM form.",
		]);
	});

	it("names a malformed trigger time", () => {
		expect(describeGaps(draft({ trigger: { type: "time.of_day", time: "25:00" } }))).toEqual([
			"The trigger needs a time in 24-hour HH:MM form.",
		]);
	});

	it("numbers each gap so the user knows which row to fix", () => {
		const gaps = describeGaps(
			draft({
				actions: [
					{ type: "timer", mode: "start" },
					{ type: "openUrl", url: "" },
					{ type: "createTask", title: "", column: null },
				],
			}),
		);
		expect(gaps).toEqual(["Step 2 needs a link to open.", "Step 3 needs a task title."]);
	});

	it("accepts a timer action, which needs nothing else filled in", () => {
		expect(describeGaps(draft({ actions: [{ type: "timer", mode: "stop" }] }))).toEqual([]);
	});

	it("accepts the optional fields being blank, which the engine treats as 'any'", () => {
		// A blank processName on an app.launched trigger means "any app", and a
		// blank task column means "the default column" -- neither is a gap.
		expect(describeGaps(draft({ trigger: { type: "app.launched", processName: null } }))).toEqual([]);
		expect(describeGaps(draft({ actions: [{ type: "createTask", title: "Do it", column: null }] }))).toEqual([]);
	});
});

describe("isValidTime", () => {
	it("accepts zero-padded 24-hour times", () => {
		expect(isValidTime("00:00")).toBe(true);
		expect(isValidTime("09:05")).toBe(true);
		expect(isValidTime("23:59")).toBe(true);
	});

	it("rejects everything the engine would reject", () => {
		expect(isValidTime("24:00")).toBe(false);
		expect(isValidTime("9:00")).toBe(false);
		expect(isValidTime("09:60")).toBe(false);
		expect(isValidTime("")).toBe(false);
		expect(isValidTime(null)).toBe(false);
	});
});

describe("draftFromRule / draftToInput", () => {
	it("starts a new rule as a manual, empty, enabled draft", () => {
		const blank = draftFromRule(null);
		expect(blank.trigger).toEqual({ type: "manual" });
		expect(blank.conditions).toEqual([]);
		expect(blank.actions).toEqual([]);
		expect(blank.enabled).toBe(true);
	});

	it("round-trips an existing rule without changing any of it", () => {
		const rule = {
			id: "rule-1",
			environmentId: "env-a",
			label: "Focus setup",
			enabled: false,
			trigger: { type: "app.launched", processName: "Figma" },
			conditions: [{ type: "app_running", processName: "Figma" }],
			actions: [{ type: "timer", mode: "start" }],
			source: "user",
			migratedFrom: null,
			createdAt: null,
			updatedAt: null,
			description: "When I switch to Figma, start the timer.",
		} as SmartFunction;

		const input = draftToInput(draftFromRule(rule));
		expect(input).toEqual({
			label: "Focus setup",
			environmentId: "env-a",
			enabled: false,
			trigger: rule.trigger,
			conditions: rule.conditions,
			actions: rule.actions,
		});
	});

	it("copies the arrays rather than aliasing the rule's own", () => {
		const rule = {
			conditions: [{ type: "app_running", processName: "Figma" }],
			actions: [{ type: "timer", mode: "start" }],
		} as SmartFunction;

		const copy = draftFromRule(rule);
		copy.actions.push({ type: "timer", mode: "stop" });

		expect(rule.actions).toHaveLength(1);
	});

	it("falls back to a name rather than saving a blank label", () => {
		expect(draftToInput(draft({ label: "   " })).label).toBe("Untitled smart function");
	});
});

describe("describeDryRunReason", () => {
	it("translates every verdict decide() can return", () => {
		for (const reason of [
			"matched",
			"disabled",
			"condition_failed",
			"rate_limited",
			"loop_prevented",
			"no_trigger_match",
		]) {
			expect(describeDryRunReason(reason), reason).toBeTruthy();
		}
	});

	it("says plainly that a matched rule would run", () => {
		expect(describeDryRunReason("matched")).toBe("It would run right now.");
	});

	it("does not blame the rule for a rate limit -- the engine really would hold it back", () => {
		expect(describeDryRunReason("rate_limited")).toContain("held back");
	});

	it("has a safe fallback for a verdict this build doesn't know", () => {
		expect(describeDryRunReason("something_new")).toBeTruthy();
		expect(describeDryRunReason(undefined)).toBeTruthy();
	});
});
