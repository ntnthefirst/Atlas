import type {
	SmartFunction,
	SmartFunctionAction,
	SmartFunctionCondition,
	SmartFunctionInput,
	SmartFunctionTrigger,
} from "../../types";

// ---------------------------------------------------------------------------
// The Smart Function editor's PURE half (WP-3.2): the vocabulary the form
// offers, the blank value for each choice, and the check for whether a draft
// is complete enough to save. No React, no `window.atlas` -- same split as
// ./findingActions.ts and src/components/launcher/launcherResults.ts.
//
// -- "Users build rules without a manual" ------------------------------------
// The whole reason this file exists separately is that the editor's job is to
// make an INVALID rule hard to build in the first place. The engine's own
// normalizer (electron/services/smart-functions/model.cjs) silently DROPS a
// malformed condition or action -- exactly right for a corrupted database row,
// and exactly wrong as a user's first experience, because a rule you saved
// would come back missing a step with no explanation. So `describeGaps()`
// below names, in advance, every part that model.cjs would discard, and the
// editor refuses to save until there are none. The two are deliberately kept
// in step: every `null` return in model.cjs's normalizeCondition/
// normalizeAction has a matching gap message here, and smartFunctionForm.test.ts
// walks the whole vocabulary to keep it that way.
// ---------------------------------------------------------------------------

export const TRIGGER_CHOICES: Array<{ value: SmartFunctionTrigger["type"]; label: string }> = [
	{ value: "manual", label: "I run it myself" },
	{ value: "app.launched", label: "I switch to an app" },
	{ value: "environment.switched", label: "I switch environment" },
	{ value: "session.started", label: "A session starts" },
	{ value: "session.stopped", label: "A session stops" },
	{ value: "time.of_day", label: "A time of day" },
	{ value: "display.connected", label: "A display is connected" },
	{ value: "file.changed", label: "A watched file changes" },
];

export const CONDITION_CHOICES: Array<{ value: SmartFunctionCondition["type"]; label: string }> = [
	{ value: "environment", label: "Only in one environment" },
	{ value: "time_window", label: "Only between two times" },
	{ value: "app_running", label: "Only while an app is in front" },
];

export const ACTION_CHOICES: Array<{ value: SmartFunctionAction["type"]; label: string }> = [
	{ value: "launchApp", label: "Open an app" },
	{ value: "openUrl", label: "Open a link" },
	{ value: "timer", label: "Start or stop the timer" },
	{ value: "switchEnvironment", label: "Switch environment" },
	{ value: "createTask", label: "Add a task" },
];

/** The blank value for each trigger type, matching model.cjs's own defaults. */
export function blankTrigger(type: SmartFunctionTrigger["type"]): SmartFunctionTrigger {
	switch (type) {
		case "environment.switched":
			return { type, environmentId: null };
		case "app.launched":
			return { type, processName: null };
		case "time.of_day":
			return { type, time: "09:00" };
		case "file.changed":
			return { type, pattern: null, kind: null };
		default:
			return { type } as SmartFunctionTrigger;
	}
}

export function blankCondition(type: SmartFunctionCondition["type"]): SmartFunctionCondition {
	switch (type) {
		case "environment":
			return { type, environmentId: "" };
		case "time_window":
			return { type, start: "09:00", end: "17:00" };
		default:
			return { type: "app_running", processName: "" };
	}
}

export function blankAction(type: SmartFunctionAction["type"]): SmartFunctionAction {
	switch (type) {
		case "launchApp":
			return { type, command: "" };
		case "openUrl":
			return { type, url: "" };
		case "timer":
			return { type, mode: "start" };
		case "switchEnvironment":
			return { type, environmentId: "" };
		default:
			return { type: "createTask", title: "", column: null };
	}
}

/** "HH:MM", 24-hour, zero-padded -- model.cjs's TIME_OF_DAY_PATTERN. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: string | null | undefined): boolean {
	return typeof value === "string" && TIME_PATTERN.test(value);
}

export type SmartFunctionDraft = {
	label: string;
	environmentId: string | null;
	enabled: boolean;
	trigger: SmartFunctionTrigger;
	conditions: SmartFunctionCondition[];
	actions: SmartFunctionAction[];
};

export function draftFromRule(rule: SmartFunction | null): SmartFunctionDraft {
	if (!rule) {
		return {
			label: "",
			environmentId: null,
			enabled: true,
			trigger: { type: "manual" },
			conditions: [],
			actions: [],
		};
	}
	return {
		label: rule.label,
		environmentId: rule.environmentId,
		enabled: rule.enabled,
		trigger: rule.trigger,
		conditions: [...rule.conditions],
		actions: [...rule.actions],
	};
}

export function draftToInput(draft: SmartFunctionDraft): SmartFunctionInput {
	return {
		label: draft.label.trim() || "Untitled smart function",
		environmentId: draft.environmentId,
		enabled: draft.enabled,
		trigger: draft.trigger,
		conditions: draft.conditions,
		actions: draft.actions,
	};
}

/**
 * Everything about this draft that the engine's normalizer would silently
 * discard, in the user's words and in the order they appear on the form.
 * Empty means the rule will survive a save exactly as it looks here.
 */
export function describeGaps(draft: SmartFunctionDraft): string[] {
	const gaps: string[] = [];

	if (draft.trigger.type === "time.of_day" && !isValidTime(draft.trigger.time)) {
		gaps.push("The trigger needs a time in 24-hour HH:MM form.");
	}

	draft.conditions.forEach((condition, index) => {
		const which = `Condition ${index + 1}`;
		if (condition.type === "environment" && !condition.environmentId) {
			gaps.push(`${which} needs an environment.`);
		}
		if (condition.type === "time_window" && (!isValidTime(condition.start) || !isValidTime(condition.end))) {
			gaps.push(`${which} needs both times in 24-hour HH:MM form.`);
		}
		if (condition.type === "app_running" && !condition.processName.trim()) {
			gaps.push(`${which} needs an app name.`);
		}
	});

	if (draft.actions.length === 0) {
		// Not something normalizeActions drops -- a rule with no actions saves
		// perfectly well. It just does nothing, which is never what someone
		// building their first rule meant, so it is worth saying.
		gaps.push("Add at least one thing for this to do.");
	}

	draft.actions.forEach((action, index) => {
		const which = `Step ${index + 1}`;
		if (action.type === "launchApp" && !action.command.trim()) {
			gaps.push(`${which} needs an app to open.`);
		}
		if (action.type === "openUrl" && !action.url.trim()) {
			gaps.push(`${which} needs a link to open.`);
		}
		if (action.type === "switchEnvironment" && !action.environmentId) {
			gaps.push(`${which} needs an environment to switch to.`);
		}
		if (action.type === "createTask" && !action.title.trim()) {
			gaps.push(`${which} needs a task title.`);
		}
	});

	return gaps;
}

export function canSave(draft: SmartFunctionDraft): boolean {
	return describeGaps(draft).length === 0;
}

/**
 * A dry-run verdict, in words. `reason` is evaluate.cjs#decide's own, so this
 * is the one place the renderer translates the engine's vocabulary -- and it
 * translates rather than reinterprets: "rate_limited" means the engine really
 * would refuse right now, not that the rule is broken.
 */
export function describeDryRunReason(reason: string | undefined): string {
	switch (reason) {
		case "matched":
			return "It would run right now.";
		case "disabled":
			return "It's turned off, so it wouldn't run.";
		case "condition_failed":
			return "Its conditions aren't met right now, so it wouldn't run.";
		case "rate_limited":
			return "It has fired too often in the last few seconds, so it would be held back.";
		case "loop_prevented":
			return "It's too deep in a chain of rules setting each other off, so it would be stopped.";
		case "no_trigger_match":
			return "Its trigger doesn't match what's happening right now.";
		default:
			return "It wouldn't run right now.";
	}
}
