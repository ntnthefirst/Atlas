"use strict";

// ---------------------------------------------------------------------------
// Smart Functions (WP-3.2) -- the plain-language preview: one rule, rendered
// as the sentence the plan asks for ("When I open Figma, in Design, start the
// timer"). Pure, no db, no Electron, same split as ./evaluate.cjs.
//
// -- "Matches actual behaviour" is a real constraint, not a hope -------------
// A preview that quietly disagrees with the engine is worse than no preview:
// the user builds a rule against the sentence, and the sentence is a lie. So
// every phrase below is written against ./evaluate.cjs's ACTUAL predicate,
// including the three places where the honest wording is not the obvious one:
//
//   - An `app.launched` trigger with no process name matches EVERY app
//     becoming the foreground app (evaluate.cjs only compares `processName`
//     when the trigger actually has one), so it reads "I switch to any app" --
//     never a vaguer "an app launches" that hides the breadth.
//   - A `time_window` condition whose start equals its end is ALWAYS true
//     (withinTimeWindow's own "a zero-width window is 'always', not 'never'"),
//     so it reads "at any time of day" rather than naming an empty window the
//     engine does not actually enforce.
//   - A rule with an `environmentId` only reacts to real events while that
//     environment is active (decide's `environment_mismatch`), but a MANUAL
//     run ignores that scoping entirely -- so the environment clause is worded
//     as a condition on automatic firing, which is exactly what it is.
//
// describe.test.js pins each of those down, and asserts that every trigger,
// condition and action type in ./model.cjs's closed vocabulary has a phrase --
// so adding a type without describing it fails the suite rather than shipping
// a preview that silently omits half a rule.
//
// -- Names, not ids -----------------------------------------------------------
// `options.environmentNames` is an optional `{ [id]: name }` map. Given one, an
// environment reads by name; without one it falls back to a short form of the
// id rather than pretending to know a name it wasn't given.
// ---------------------------------------------------------------------------

function environmentLabel(environmentId, options = {}) {
	if (!environmentId) {
		return "any environment";
	}
	const name = options.environmentNames?.[environmentId];
	return name ? `"${name}"` : "another environment";
}

function describeTrigger(trigger, options = {}) {
	switch (trigger?.type) {
		case "manual":
			return "I run this myself";
		case "environment.switched":
			return trigger.environmentId
				? `I switch into ${environmentLabel(trigger.environmentId, options)}`
				: "I switch environment";
		case "session.started":
			return "a session starts";
		case "session.stopped":
			return "a session stops";
		case "app.launched":
			// See this file's header: no process name means EVERY foreground
			// change, and the sentence has to say so.
			return trigger.processName ? `I switch to ${trigger.processName}` : "I switch to any app";
		case "time.of_day":
			return `the clock reaches ${trigger.time}`;
		case "display.connected":
			return "a display is connected";
		case "file.changed": {
			const what = trigger.pattern ? `a file matching "${trigger.pattern}"` : "any watched file";
			switch (trigger.kind) {
				case "created":
					return `${what} is created`;
				case "removed":
					return `${what} is deleted`;
				case "modified":
					return `${what} is changed`;
				default:
					return `${what} is created, changed or deleted`;
			}
		}
		default:
			// A trigger type this build doesn't understand -- evaluate.cjs fails
			// closed on exactly the same input (matchesTrigger returns false), so
			// the sentence says the same thing rather than inventing a meaning.
			return "something this version doesn't recognise happens";
	}
}

function describeCondition(condition, options = {}) {
	switch (condition?.type) {
		case "environment":
			return `${environmentLabel(condition.environmentId, options)} is the active environment`;
		case "time_window":
			// See this file's header: start === end is "always" in the engine.
			return condition.start === condition.end
				? "at any time of day"
				: `the time is between ${condition.start} and ${condition.end}`;
		case "app_running":
			return `${condition.processName} is the app in front`;
		default:
			return "a condition this version doesn't recognise holds";
	}
}

function describeAction(action, options = {}) {
	switch (action?.type) {
		case "launchApp":
			return `open ${action.command}`;
		case "openUrl":
			return `open ${action.url}`;
		case "timer":
			return action.mode === "start" ? "start the timer" : "stop the timer";
		case "switchEnvironment":
			return `switch to ${environmentLabel(action.environmentId, options)}`;
		case "createTask":
			return action.column ? `add a task "${action.title}" to ${action.column}` : `add a task "${action.title}"`;
		default:
			return "do something this version doesn't recognise";
	}
}

function joinPhrases(phrases) {
	if (phrases.length === 0) {
		return "";
	}
	if (phrases.length === 1) {
		return phrases[0];
	}
	return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * The whole sentence. Deliberately one string rather than a template the
 * renderer assembles: a preview split across two layers is a preview that can
 * drift on one side without the other noticing.
 */
function describeRule(rule, options = {}) {
	if (!rule) {
		return "";
	}
	const when = describeTrigger(rule.trigger, options);
	const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
	const actions = Array.isArray(rule.actions) ? rule.actions : [];

	const clauses = conditions.map((condition) => describeCondition(condition, options));
	// The rule's own environment scoping is a real gate on automatic firing
	// (decide's environment_mismatch), so it belongs in the sentence -- but it
	// does NOT apply to a manual run, which is why it is phrased as being about
	// this happening on its own.
	if (rule.environmentId && rule.trigger?.type !== "manual") {
		clauses.unshift(`${environmentLabel(rule.environmentId, options)} is the active environment`);
	}

	const then =
		actions.length === 0
			? "do nothing (no actions yet)"
			: joinPhrases(actions.map((action) => describeAction(action, options)));

	// The comma after the "when" clause belongs to the sentence, not to the
	// condition clause -- without conditions it is still needed, which is
	// exactly the join that reads fine in code and wrong on screen.
	const conditionPart = clauses.length > 0 ? `, as long as ${joinPhrases(clauses)}` : "";
	return `When ${when}${conditionPart}, ${then}.`;
}

module.exports = {
	describeTrigger,
	describeCondition,
	describeAction,
	describeRule,
};
