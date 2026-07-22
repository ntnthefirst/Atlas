import { describe, expect, it } from "vitest";
import {
	translateFindingTrigger,
	translateFindingAction,
	translateFindingToRuleInput,
} from "./finding-translator.cjs";
import { normalizeTrigger, normalizeAction } from "../smart-functions/model.cjs";

function finding(overrides = {}) {
	return {
		id: "finding-1",
		environmentId: "env-a",
		trigger: { type: "app.focus", subject: "Editor" },
		follow: { type: "app.focus", subject: "Server" },
		...overrides,
	};
}

describe("translateFindingTrigger", () => {
	it("maps app.focus to app.launched, carrying the subject as processName", () => {
		const trigger = translateFindingTrigger(finding());
		expect(trigger).toEqual({ type: "app.launched", processName: "Editor" });
		// Must actually be accepted by smart-functions' own vocabulary -- not a
		// parallel shape only this module understands.
		expect(normalizeTrigger(trigger)).toEqual(trigger);
	});

	it("maps session.start / session.stop with no subject narrowing", () => {
		expect(translateFindingTrigger(finding({ trigger: { type: "session.start", subject: null } }))).toEqual({
			type: "session.started",
		});
		expect(translateFindingTrigger(finding({ trigger: { type: "session.stop", subject: null } }))).toEqual({
			type: "session.stopped",
		});
	});

	it("maps display.connected with no fields", () => {
		expect(translateFindingTrigger(finding({ trigger: { type: "display.connected", subject: null } }))).toEqual({
			type: "display.connected",
		});
	});

	it("maps environment.switch using the finding's OWN environmentId, not trigger.subject", () => {
		// Actively opposing fixture: trigger.subject is set to something else
		// entirely, to prove the translator ignores it (environment.switch
		// events never carry a subject in real event-log data -- see this
		// module's header) rather than accidentally reading it.
		const f = finding({
			environmentId: "env-real",
			trigger: { type: "environment.switch", subject: "not-a-real-environment" },
		});
		expect(translateFindingTrigger(f)).toEqual({ type: "environment.switched", environmentId: "env-real" });
	});

	it("returns null for an event type with no smart-functions trigger equivalent", () => {
		expect(translateFindingTrigger(finding({ trigger: { type: "task.create", subject: "task-1" } }))).toBeNull();
		expect(translateFindingTrigger(finding({ trigger: { type: "note.create", subject: "note-1" } }))).toBeNull();
		expect(translateFindingTrigger(finding({ trigger: { type: "launcher.query", subject: "x" } }))).toBeNull();
	});

	it("never throws on a malformed finding", () => {
		expect(translateFindingTrigger(null)).toBeNull();
		expect(translateFindingTrigger({})).toBeNull();
	});
});

describe("translateFindingAction", () => {
	it("maps app.focus to launchApp, carrying the subject as command", () => {
		const action = translateFindingAction(finding());
		expect(action).toEqual({ type: "launchApp", command: "Server" });
		expect(normalizeAction(action)).toEqual(action);
	});

	it("maps session.start / session.stop to timer start/stop", () => {
		expect(translateFindingAction(finding({ follow: { type: "session.start", subject: null } }))).toEqual({
			type: "timer",
			mode: "start",
		});
		expect(translateFindingAction(finding({ follow: { type: "session.stop", subject: null } }))).toEqual({
			type: "timer",
			mode: "stop",
		});
	});

	it("returns null for app.focus with no subject at all (nothing to launch)", () => {
		expect(translateFindingAction(finding({ follow: { type: "app.focus", subject: null } }))).toBeNull();
	});

	it("NEVER maps environment.switch to an action, even though it IS a valid trigger", () => {
		// This is the key opposing case documented in finding-translator.cjs's
		// header: switching to the finding's own bucket environment as a FOLLOW
		// action would always be a switch-to-self no-op, so this must stay
		// unsupported on the action side specifically.
		expect(translateFindingAction(finding({ follow: { type: "environment.switch", subject: null } }))).toBeNull();
	});

	it("returns null for an event type with no action equivalent (e.g. task.create -- no title available)", () => {
		expect(translateFindingAction(finding({ follow: { type: "task.create", subject: "task-1" } }))).toBeNull();
	});

	it("never throws on a malformed finding", () => {
		expect(translateFindingAction(null)).toBeNull();
		expect(translateFindingAction({})).toBeNull();
	});
});

describe("translateFindingToRuleInput", () => {
	it("produces a full { trigger, actions, label } for a fully-supported pattern", () => {
		const result = translateFindingToRuleInput(finding());
		expect(result).toEqual({
			trigger: { type: "app.launched", processName: "Editor" },
			actions: [{ type: "launchApp", command: "Server" }],
			label: expect.any(String),
		});
		expect(result.label.length).toBeGreaterThan(0);
	});

	it("returns null when the trigger side is supported but the action side is not", () => {
		const f = finding({ follow: { type: "task.create", subject: "task-1" } });
		expect(translateFindingToRuleInput(f)).toBeNull();
	});

	it("returns null when the action side is supported but the trigger side is not", () => {
		const f = finding({ trigger: { type: "task.create", subject: "task-1" } });
		expect(translateFindingToRuleInput(f)).toBeNull();
	});

	it("returns null when neither side is supported", () => {
		const f = finding({
			trigger: { type: "launcher.query", subject: "x" },
			follow: { type: "note.create", subject: "y" },
		});
		expect(translateFindingToRuleInput(f)).toBeNull();
	});
});
