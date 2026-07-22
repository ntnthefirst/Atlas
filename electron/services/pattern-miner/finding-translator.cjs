"use strict";

// ---------------------------------------------------------------------------
// Turns a `findings` row (electron/services/pattern-miner/store.cjs's
// rowToFinding shape: `{ environmentId, trigger: {type, subject}, follow:
// {type, subject}, ... }`) into the exact rule-input shape electron/services/
// smart-functions/model.cjs's normalizeRuleInput() accepts -- `{ trigger,
// actions }` (plus a human-readable `label`) -- or `null` when this
// particular pattern can't become an automatic trigger/action pair at all.
// Pure: no db, no Electron. finding-lifecycle-service.cjs is the only caller,
// inside acceptFinding().
//
// -- Why this can't cover every possible finding -----------------------------
// A finding's trigger/follow `type` is one of the RAW event-log type strings
// (electron/services/event-log.cjs's `record()` vocabulary -- "app.focus",
// "session.start", "task.create", ...), not a smart-functions TRIGGER_TYPE --
// those are two independently-evolved vocabularies (see evaluate.cjs's own
// TRIGGER_EVENT_TYPE table, which maps the smart-functions side back to the
// event-log side for the exact four trigger types that have a live wire-up
// today). TRIGGER_BUILDERS below is deliberately the INVERSE of that same
// table, so "can this finding's trigger fire a rule" and "does the engine
// actually listen for this" can never quietly drift apart. Any event type
// with no entry here (task.create, note.create, launcher.*, environment.
// archived, ...) has no corresponding smart-functions trigger at all --
// translateFindingTrigger() returns null for it, not a guess.
//
// -- Why `environment.switch` is a valid TRIGGER but never a valid ACTION ---
// A finding is always mined from ONE environment's own event bucket (migration
// 012's `environment_id NOT NULL`; see mine-worker.cjs's isolation argument),
// so trigger and follow both happened while `finding.environmentId` was the
// active environment. As a TRIGGER, "environment.switch" is meaningful: it
// means "switching INTO this bucket's own environment" (see below), a real,
// nameable moment. As an ACTION, though, "switch to environment X" would have
// to mean "switch to `finding.environmentId`" -- the environment the rule
// itself already runs in -- which is a switch to the environment you are
// ALREADY in: a no-op. ACTION_BUILDERS has no entry for it for exactly this
// reason, not an oversight.
//
// -- Why `environment.switch`'s trigger doesn't read `trigger.subject` ------
// electron/ipc/environments.cjs's own `environment.switch` event-log write
// never sets `subject` at all (only `environmentId`, the destination) -- so
// `finding.trigger.subject` is always null for this event type; the ONLY
// environment identity available is the bucket's own `finding.environmentId`,
// which -- since a bucket only ever contains ONE environment's events -- is
// necessarily "the environment that was switched into" for every
// `environment.switch` event inside it. Reading `finding.environmentId`
// directly (not `trigger.subject`) is therefore not an approximation, it's
// the exact and only correct value.
// ---------------------------------------------------------------------------

const TRIGGER_BUILDERS = {
	"environment.switch": (finding) => ({ type: "environment.switched", environmentId: finding.environmentId || null }),
	"session.start": () => ({ type: "session.started" }),
	"session.stop": () => ({ type: "session.stopped" }),
	"app.focus": (finding) => ({ type: "app.launched", processName: finding.trigger?.subject || null }),
	"display.connected": () => ({ type: "display.connected" }),
};

// Deliberately a SMALLER set of keys than TRIGGER_BUILDERS -- see this file's
// header for why `environment.switch` (and anything else absent here, e.g.
// `task.create` -- its own event only ever carries the created task's id as
// `subject`, never a title, so there is no text to build a meaningful
// `createTask` action from) has no legal action-side mapping at all.
const ACTION_BUILDERS = {
	"session.start": () => ({ type: "timer", mode: "start" }),
	"session.stop": () => ({ type: "timer", mode: "stop" }),
	"app.focus": (finding) => {
		const command = finding.follow?.subject;
		return command ? { type: "launchApp", command } : null;
	},
};

function translateFindingTrigger(finding) {
	const eventType = finding?.trigger?.type;
	const builder = typeof eventType === "string" ? TRIGGER_BUILDERS[eventType] : null;
	return builder ? builder(finding) : null;
}

function translateFindingAction(finding) {
	const eventType = finding?.follow?.type;
	const builder = typeof eventType === "string" ? ACTION_BUILDERS[eventType] : null;
	return builder ? builder(finding) : null;
}

function describeEventSide(side) {
	if (!side || typeof side.type !== "string") {
		return "something happens";
	}
	switch (side.type) {
		case "environment.switch":
			return "you switch into this environment";
		case "session.start":
			return "a session starts";
		case "session.stop":
			return "a session stops";
		case "app.focus":
			return side.subject ? `"${side.subject}" is focused` : "an app is focused";
		case "display.connected":
			return "a display connects";
		default:
			return side.type;
	}
}

// A plain-language default label -- WP-3.2's editor lets the user rename this
// like any other rule's `label`, so this only ever needs to be a reasonable
// starting point, not a permanent identity.
function buildFindingRuleLabel(finding) {
	return `When ${describeEventSide(finding?.trigger)}, then ${describeEventSide(finding?.follow)}`;
}

// The one entry point: `null` means "this finding's pattern can't be turned
// into a smart function yet" -- acceptFinding() must never fall back to
// inventing a placeholder trigger/action when this happens, it must refuse
// the accept outright (see finding-lifecycle-service.cjs).
function translateFindingToRuleInput(finding) {
	const trigger = translateFindingTrigger(finding);
	const action = translateFindingAction(finding);
	if (!trigger || !action) {
		return null;
	}
	return { trigger, actions: [action], label: buildFindingRuleLabel(finding) };
}

module.exports = {
	translateFindingTrigger,
	translateFindingAction,
	buildFindingRuleLabel,
	translateFindingToRuleInput,
};
