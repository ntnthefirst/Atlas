import { describe, expect, it } from "vitest";
import { matchesTrigger, matchesFilePattern, evaluateConditions, withinTimeWindow, decide } from "./evaluate.cjs";

// ---------------------------------------------------------------------------
// Pure evaluation (WP-3.1): trigger matching, condition checking, and the
// loop-prevention decision, as a function of (rule, event, ctx) with no I/O.
// No timers, no db, no platform anywhere in this file -- every fixture is a
// plain object.
// ---------------------------------------------------------------------------

function baseCtx(overrides = {}) {
	return {
		currentEnvironmentId: null,
		foregroundProcessName: null,
		now: Date.now(),
		dispatchDepth: 0,
		maxDispatchDepth: 5,
		recentFires: () => [],
		maxFiresPerWindow: 5,
		rateWindowMs: 10_000,
		...overrides,
	};
}

function baseRule(overrides = {}) {
	return {
		id: "rule-1",
		environmentId: null,
		label: "Test rule",
		enabled: true,
		trigger: { type: "manual" },
		conditions: [],
		actions: [],
		source: "user",
		...overrides,
	};
}

describe("matchesTrigger", () => {
	it("manual never matches an incoming event (only engine.runManually bypasses it)", () => {
		expect(matchesTrigger({ type: "manual" }, { type: "manual" })).toBe(false);
	});

	it("environment.switched matches environment.switch, optionally narrowed to one environment", () => {
		const anyEnv = { type: "environment.switched", environmentId: null };
		expect(matchesTrigger(anyEnv, { type: "environment.switch", environmentId: "env-a" })).toBe(true);
		expect(matchesTrigger(anyEnv, { type: "environment.switch", environmentId: "env-b" })).toBe(true);

		const narrowed = { type: "environment.switched", environmentId: "env-a" };
		expect(matchesTrigger(narrowed, { type: "environment.switch", environmentId: "env-a" })).toBe(true);
		expect(matchesTrigger(narrowed, { type: "environment.switch", environmentId: "env-b" })).toBe(false);

		expect(matchesTrigger(anyEnv, { type: "session.start" })).toBe(false);
	});

	it("session.started/stopped match exactly session.start/session.stop", () => {
		expect(matchesTrigger({ type: "session.started" }, { type: "session.start" })).toBe(true);
		expect(matchesTrigger({ type: "session.started" }, { type: "session.stop" })).toBe(false);
		expect(matchesTrigger({ type: "session.stopped" }, { type: "session.stop" })).toBe(true);
	});

	it("app.launched matches app.focus, optionally narrowed to one process name (case-insensitive)", () => {
		const any = { type: "app.launched", processName: null };
		expect(matchesTrigger(any, { type: "app.focus", subject: "chrome" })).toBe(true);

		const narrowed = { type: "app.launched", processName: "Code" };
		expect(matchesTrigger(narrowed, { type: "app.focus", subject: "code" })).toBe(true);
		expect(matchesTrigger(narrowed, { type: "app.focus", subject: "chrome" })).toBe(false);
	});

	it("time.of_day matches only the synthetic time.tick event, on the exact minute", () => {
		const trigger = { type: "time.of_day", time: "09:00" };
		expect(matchesTrigger(trigger, { type: "time.tick", payload: { hhmm: "09:00" } })).toBe(true);
		expect(matchesTrigger(trigger, { type: "time.tick", payload: { hhmm: "09:01" } })).toBe(false);
		expect(matchesTrigger(trigger, { type: "session.start" })).toBe(false);
	});

	it("display.connected matches only display.connected", () => {
		expect(matchesTrigger({ type: "display.connected" }, { type: "display.connected" })).toBe(true);
		expect(matchesTrigger({ type: "display.connected" }, { type: "display.disconnected" })).toBe(false);
	});

	it("file.changed matches on pattern and kind", () => {
		const trigger = { type: "file.changed", pattern: "*.psd", kind: null };
		expect(matchesTrigger(trigger, { type: "file.changed", payload: { path: "C:\\art\\banner.psd", kind: "changed" } })).toBe(
			true,
		);
		expect(matchesTrigger(trigger, { type: "file.changed", payload: { path: "C:\\art\\banner.png", kind: "changed" } })).toBe(
			false,
		);

		const kindTrigger = { type: "file.changed", pattern: null, kind: "removed" };
		expect(matchesTrigger(kindTrigger, { type: "file.changed", payload: { path: "x.txt", kind: "changed" } })).toBe(false);
		expect(matchesTrigger(kindTrigger, { type: "file.changed", payload: { path: "x.txt", kind: "removed" } })).toBe(true);
	});
});

describe("matchesFilePattern", () => {
	it("a blank pattern matches everything", () => {
		expect(matchesFilePattern("C:\\anything.txt", null)).toBe(true);
		expect(matchesFilePattern("C:\\anything.txt", "")).toBe(true);
	});

	it("supports leading/trailing wildcard and plain substring, case-insensitively", () => {
		expect(matchesFilePattern("C:\\Art\\Banner.PSD", "*.psd")).toBe(true);
		expect(matchesFilePattern("C:\\Art\\Banner.png", "*.psd")).toBe(false);
		expect(matchesFilePattern("C:\\Projects\\atlas\\readme.md", "atlas*")).toBe(false);
		expect(matchesFilePattern("atlas\\readme.md", "atlas*")).toBe(true);
		expect(matchesFilePattern("C:\\Projects\\atlas\\readme.md", "*atlas*")).toBe(true);
		expect(matchesFilePattern("C:\\Projects\\atlas\\readme.md", "PROJECTS")).toBe(true);
	});
});

describe("evaluateConditions", () => {
	it("an empty condition list always passes", () => {
		expect(evaluateConditions([], baseCtx())).toBe(true);
	});

	it("environment condition requires an exact match against ctx.currentEnvironmentId", () => {
		const conditions = [{ type: "environment", environmentId: "env-a" }];
		expect(evaluateConditions(conditions, baseCtx({ currentEnvironmentId: "env-a" }))).toBe(true);
		expect(evaluateConditions(conditions, baseCtx({ currentEnvironmentId: "env-b" }))).toBe(false);
		expect(evaluateConditions(conditions, baseCtx({ currentEnvironmentId: null }))).toBe(false);
	});

	it("app_running condition matches the last observed foreground process, case-insensitively", () => {
		const conditions = [{ type: "app_running", processName: "chrome" }];
		expect(evaluateConditions(conditions, baseCtx({ foregroundProcessName: "Chrome" }))).toBe(true);
		expect(evaluateConditions(conditions, baseCtx({ foregroundProcessName: "code" }))).toBe(false);
		expect(evaluateConditions(conditions, baseCtx({ foregroundProcessName: null }))).toBe(false);
	});

	it("ALL conditions must pass (AND), not any", () => {
		const conditions = [
			{ type: "environment", environmentId: "env-a" },
			{ type: "app_running", processName: "chrome" },
		];
		expect(evaluateConditions(conditions, baseCtx({ currentEnvironmentId: "env-a", foregroundProcessName: "chrome" }))).toBe(
			true,
		);
		// Environment matches but the app doesn't -- must fail, proving this
		// isn't accidentally an OR (a fixture that actively opposes the answer
		// a buggy `.some` implementation would produce).
		expect(evaluateConditions(conditions, baseCtx({ currentEnvironmentId: "env-a", foregroundProcessName: "code" }))).toBe(
			false,
		);
	});
});

describe("withinTimeWindow", () => {
	const at = (hh, mm) => new Date(2026, 0, 1, hh, mm).getTime();

	it("a same-day window (start < end)", () => {
		const condition = { start: "09:00", end: "17:00" };
		expect(withinTimeWindow(condition, at(12, 0))).toBe(true);
		expect(withinTimeWindow(condition, at(8, 59))).toBe(false);
		expect(withinTimeWindow(condition, at(17, 0))).toBe(false); // end is exclusive
	});

	it("an overnight window (start > end) wraps across midnight", () => {
		const condition = { start: "22:00", end: "06:00" };
		expect(withinTimeWindow(condition, at(23, 0))).toBe(true);
		expect(withinTimeWindow(condition, at(2, 0))).toBe(true);
		expect(withinTimeWindow(condition, at(12, 0))).toBe(false);
	});

	it("a zero-width window (start === end) is always true", () => {
		expect(withinTimeWindow({ start: "09:00", end: "09:00" }, at(3, 0))).toBe(true);
	});
});

describe("decide()", () => {
	it("refuses a disabled rule regardless of trigger/conditions", () => {
		const rule = baseRule({ enabled: false, trigger: { type: "session.started" } });
		const decision = decide(rule, { type: "session.start" }, baseCtx());
		expect(decision).toEqual({ fire: false, reason: "disabled" });
	});

	it("fires when the trigger matches and there are no conditions", () => {
		const rule = baseRule({ trigger: { type: "session.started" } });
		const decision = decide(rule, { type: "session.start" }, baseCtx());
		expect(decision.fire).toBe(true);
	});

	it("does not fire when the trigger does not match", () => {
		const rule = baseRule({ trigger: { type: "session.started" } });
		expect(decide(rule, { type: "session.stop" }, baseCtx()).reason).toBe("no_trigger_match");
	});

	it("an environment-scoped rule only fires while ITS OWN environment is active", () => {
		const rule = baseRule({ environmentId: "env-a", trigger: { type: "session.started" } });
		expect(decide(rule, { type: "session.start" }, baseCtx({ currentEnvironmentId: "env-a" })).fire).toBe(true);
		const rejected = decide(rule, { type: "session.start" }, baseCtx({ currentEnvironmentId: "env-b" }));
		expect(rejected).toEqual({ fire: false, reason: "environment_mismatch" });
	});

	it("environment scoping does not apply when there is no current environment at all (fail-open, matching db.cjs's own convention)", () => {
		const rule = baseRule({ environmentId: "env-a", trigger: { type: "session.started" } });
		expect(decide(rule, { type: "session.start" }, baseCtx({ currentEnvironmentId: null })).fire).toBe(true);
	});

	it("a manual event bypasses trigger AND environment scoping", () => {
		const rule = baseRule({ environmentId: "env-a", trigger: { type: "session.started" } });
		const decision = decide(rule, { type: "manual" }, baseCtx({ currentEnvironmentId: "env-b" }));
		expect(decision.fire).toBe(true);
	});

	it("conditions must pass even when the trigger matches", () => {
		const rule = baseRule({
			trigger: { type: "session.started" },
			conditions: [{ type: "app_running", processName: "chrome" }],
		});
		expect(decide(rule, { type: "session.start" }, baseCtx({ foregroundProcessName: "chrome" })).fire).toBe(true);
		expect(decide(rule, { type: "session.start" }, baseCtx({ foregroundProcessName: "code" })).reason).toBe(
			"condition_failed",
		);
	});

	describe("loop prevention -- depth guard", () => {
		it("refuses every rule once dispatchDepth exceeds maxDispatchDepth, regardless of trigger match", () => {
			const rule = baseRule({ trigger: { type: "environment.switched", environmentId: null } });
			const event = { type: "environment.switch", environmentId: "env-a" };

			// At the budget's edge, it still fires...
			expect(decide(rule, event, baseCtx({ dispatchDepth: 5, maxDispatchDepth: 5 })).fire).toBe(true);
			// ...but one past it, it is refused outright, not merely rate-limited --
			// proving this is a DISTINCT reason from rate_limited, not the same
			// check wearing two names.
			const decision = decide(rule, event, baseCtx({ dispatchDepth: 6, maxDispatchDepth: 5 }));
			expect(decision).toEqual({ fire: false, reason: "loop_prevented" });
		});
	});

	describe("loop prevention -- per-rule rate cap", () => {
		it("refuses a rule that has already fired maxFiresPerWindow times within rateWindowMs", () => {
			const rule = baseRule({ trigger: { type: "session.started" } });
			const now = Date.now();
			const recentFires = () => [now - 1000, now - 2000, now - 3000]; // 3 fires, cap is 3

			const atCap = decide(rule, { type: "session.start" }, baseCtx({ now, recentFires, maxFiresPerWindow: 3 }));
			expect(atCap).toEqual({ fire: false, reason: "rate_limited" });

			// A generous cap (5) with the SAME fire history still allows it --
			// proving the cap number itself is what's being checked, not merely
			// "any history at all" (a fixture that actively opposes a wrong,
			// tie-break-y implementation).
			const underCap = decide(rule, { type: "session.start" }, baseCtx({ now, recentFires, maxFiresPerWindow: 5 }));
			expect(underCap.fire).toBe(true);
		});

		it("fires older than rateWindowMs do not count against the cap", () => {
			const rule = baseRule({ trigger: { type: "session.started" } });
			const now = Date.now();
			const recentFires = () => [now - 20_000, now - 30_000]; // both outside a 10s window
			const decision = decide(
				rule,
				{ type: "session.start" },
				baseCtx({ now, recentFires, rateWindowMs: 10_000, maxFiresPerWindow: 1 }),
			);
			expect(decision.fire).toBe(true);
		});
	});
});
