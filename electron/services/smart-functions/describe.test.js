import { describe, expect, it } from "vitest";
import { describeAction, describeCondition, describeRule, describeTrigger } from "./describe.cjs";
import {
	ACTION_TYPES,
	CONDITION_TYPES,
	TRIGGER_TYPES,
	normalizeAction,
	normalizeCondition,
	normalizeTrigger,
} from "./model.cjs";
import { evaluateCondition, matchesTrigger, withinTimeWindow } from "./evaluate.cjs";

// ---------------------------------------------------------------------------
// WP-3.2's acceptance criterion is "plain-language preview matches actual
// behaviour", and a test file that only checked the wording would not test
// that at all. So this suite does two things a wording test can't:
//
//   1. Exhaustiveness -- every type in model.cjs's closed vocabulary gets a
//      real phrase, so adding a trigger/condition/action without describing it
//      fails here instead of shipping a preview that silently omits half a
//      rule.
//   2. Agreement -- for the three cases where the natural wording is a lie,
//      the sentence is checked against what evaluate.cjs ACTUALLY does, using
//      evaluate.cjs itself as the authority rather than a restatement of it.
// ---------------------------------------------------------------------------

const NAMES = { "env-design": "Design", "env-work": "Work" };

describe("exhaustiveness -- nothing in the vocabulary goes undescribed", () => {
	it("describes every trigger type", () => {
		for (const type of TRIGGER_TYPES) {
			const phrase = describeTrigger(normalizeTrigger({ type }), { environmentNames: NAMES });
			expect(phrase, `trigger "${type}"`).toBeTruthy();
			expect(phrase, `trigger "${type}"`).not.toContain("doesn't recognise");
		}
	});

	it("describes every condition type", () => {
		const samples = {
			environment: { type: "environment", environmentId: "env-design" },
			time_window: { type: "time_window", start: "09:00", end: "17:00" },
			app_running: { type: "app_running", processName: "Figma" },
		};
		for (const type of CONDITION_TYPES) {
			const phrase = describeCondition(normalizeCondition(samples[type]), { environmentNames: NAMES });
			expect(phrase, `condition "${type}"`).toBeTruthy();
			expect(phrase, `condition "${type}"`).not.toContain("doesn't recognise");
		}
	});

	it("describes every action type", () => {
		const samples = {
			launchApp: { type: "launchApp", command: "figma.exe" },
			openUrl: { type: "openUrl", url: "https://example.com" },
			timer: { type: "timer", mode: "start" },
			switchEnvironment: { type: "switchEnvironment", environmentId: "env-design" },
			createTask: { type: "createTask", title: "Write it up" },
		};
		for (const type of ACTION_TYPES) {
			const phrase = describeAction(normalizeAction(samples[type]), { environmentNames: NAMES });
			expect(phrase, `action "${type}"`).toBeTruthy();
			expect(phrase, `action "${type}"`).not.toContain("doesn't recognise");
		}
	});
});

describe("agreement with evaluate.cjs -- the three places wording usually lies", () => {
	// 1. An app.launched trigger with no process name matches EVERY foreground
	//    change. evaluate.cjs is the authority here, not a restatement of it.
	it("says 'any app' exactly when the engine matches any app", () => {
		const trigger = normalizeTrigger({ type: "app.launched" });
		const matchesAnything =
			matchesTrigger(trigger, { type: "app.focus", subject: "Figma" }) &&
			matchesTrigger(trigger, { type: "app.focus", subject: "Notepad" });

		expect(matchesAnything).toBe(true);
		expect(describeTrigger(trigger)).toBe("I switch to any app");
	});

	it("names the app exactly when the engine narrows to it", () => {
		const trigger = normalizeTrigger({ type: "app.launched", processName: "Figma" });
		expect(matchesTrigger(trigger, { type: "app.focus", subject: "Figma" })).toBe(true);
		expect(matchesTrigger(trigger, { type: "app.focus", subject: "Notepad" })).toBe(false);
		expect(describeTrigger(trigger)).toBe("I switch to Figma");
	});

	// 2. A zero-width time window is ALWAYS true in the engine.
	it("says 'at any time of day' exactly when a zero-width window is always true", () => {
		const condition = normalizeCondition({ type: "time_window", start: "09:00", end: "09:00" });
		// Two instants on opposite sides of the named time; both must pass, which
		// is what makes "at any time of day" the honest wording.
		const morning = new Date(2026, 5, 1, 3, 0).getTime();
		const evening = new Date(2026, 5, 1, 21, 0).getTime();
		expect(withinTimeWindow(condition, morning)).toBe(true);
		expect(withinTimeWindow(condition, evening)).toBe(true);

		expect(describeCondition(condition)).toBe("at any time of day");
	});

	it("names the window when it really is a window", () => {
		const condition = normalizeCondition({ type: "time_window", start: "09:00", end: "17:00" });
		expect(withinTimeWindow(condition, new Date(2026, 5, 1, 12, 0).getTime())).toBe(true);
		expect(withinTimeWindow(condition, new Date(2026, 5, 1, 20, 0).getTime())).toBe(false);
		expect(describeCondition(condition)).toBe("the time is between 09:00 and 17:00");
	});

	// 3. An environment condition is about the ACTIVE environment.
	it("describes an environment condition as being about the active environment", () => {
		const condition = normalizeCondition({ type: "environment", environmentId: "env-design" });
		expect(evaluateCondition(condition, { currentEnvironmentId: "env-design" })).toBe(true);
		expect(evaluateCondition(condition, { currentEnvironmentId: "env-work" })).toBe(false);
		expect(describeCondition(condition, { environmentNames: NAMES })).toBe('"Design" is the active environment');
	});
});

describe("describeRule", () => {
	it("renders the plan's own example sentence", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "app.launched", processName: "Figma" }),
			conditions: [normalizeCondition({ type: "environment", environmentId: "env-design" })],
			actions: [normalizeAction({ type: "timer", mode: "start" })],
			environmentId: null,
		};

		expect(describeRule(rule, { environmentNames: NAMES })).toBe(
			'When I switch to Figma, as long as "Design" is the active environment, start the timer.',
		);
	});

	it("drops the condition clause entirely when there are no conditions", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "session.started" }),
			conditions: [],
			actions: [normalizeAction({ type: "timer", mode: "stop" })],
			environmentId: null,
		};
		expect(describeRule(rule)).toBe("When a session starts, stop the timer.");
	});

	it("joins several actions readably, in order", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "session.started" }),
			conditions: [],
			actions: [
				normalizeAction({ type: "launchApp", command: "figma.exe" }),
				normalizeAction({ type: "openUrl", url: "https://example.com" }),
				normalizeAction({ type: "timer", mode: "start" }),
			],
			environmentId: null,
		};
		expect(describeRule(rule)).toBe(
			"When a session starts, open figma.exe, open https://example.com and start the timer.",
		);
	});

	// A rule's own environmentId gates automatic firing (decide's
	// environment_mismatch), so it has to appear -- but a manual rule ignores
	// that scoping entirely, so claiming it would be the lie.
	it("mentions the rule's own environment scoping for an automatic trigger", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "session.started" }),
			conditions: [],
			actions: [normalizeAction({ type: "timer", mode: "start" })],
			environmentId: "env-work",
		};
		expect(describeRule(rule, { environmentNames: NAMES })).toContain('"Work" is the active environment');
	});

	it("does NOT claim environment scoping for a manual rule, which ignores it", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "manual" }),
			conditions: [],
			actions: [normalizeAction({ type: "timer", mode: "start" })],
			environmentId: "env-work",
		};
		expect(describeRule(rule, { environmentNames: NAMES })).toBe("When I run this myself, start the timer.");
	});

	it("says plainly that a rule with no actions does nothing", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "session.started" }),
			conditions: [],
			actions: [],
			environmentId: null,
		};
		expect(describeRule(rule)).toBe("When a session starts, do nothing (no actions yet).");
	});

	it("falls back to a neutral phrase when it has no name for an environment", () => {
		const rule = {
			trigger: normalizeTrigger({ type: "environment.switched", environmentId: "env-unknown" }),
			conditions: [],
			actions: [normalizeAction({ type: "timer", mode: "start" })],
			environmentId: null,
		};
		// Never invents a name, and never leaks a raw uuid at the user.
		expect(describeRule(rule)).toBe("When I switch into another environment, start the timer.");
	});

	it("never throws on a missing or malformed rule", () => {
		expect(describeRule(null)).toBe("");
		expect(() => describeRule({})).not.toThrow();
		expect(() => describeRule({ trigger: null, conditions: null, actions: null })).not.toThrow();
	});
});

describe("file.changed wording", () => {
	it("distinguishes the three kinds, and says all three when unfiltered", () => {
		const base = { type: "file.changed", pattern: "*.psd" };
		expect(describeTrigger(normalizeTrigger({ ...base, kind: "created" }))).toContain("is created");
		expect(describeTrigger(normalizeTrigger({ ...base, kind: "modified" }))).toContain("is changed");
		expect(describeTrigger(normalizeTrigger({ ...base, kind: "removed" }))).toContain("is deleted");
		expect(describeTrigger(normalizeTrigger(base))).toContain("is created, changed or deleted");
	});

	it("says 'any watched file' when there is no pattern, matching what the engine does", () => {
		const trigger = normalizeTrigger({ type: "file.changed" });
		// matchesFilePattern treats a blank pattern as matching everything, so
		// the sentence must not imply a filter that isn't there.
		expect(matchesTrigger(trigger, { type: "file.changed", payload: { path: "C:/anything.txt" } })).toBe(true);
		expect(describeTrigger(trigger)).toContain("any watched file");
	});
});
