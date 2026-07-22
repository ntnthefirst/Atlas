// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- the rule shape, its vocabulary, and the
// defensive parsing that turns a raw (possibly hand-edited, possibly stale)
// database row into a rule the rest of this package can trust.
//
// Pure: no db, no window, no timers, no platform access -- same discipline as
// electron/config/notch-prefs.cjs and environment-config.cjs, and the same
// reason: a `smart_functions` row's trigger/conditions/actions columns are
// open-ended JSON documents (see migration 011's header), and something has
// to be the one place that turns "whatever is actually in the column" into a
// shape the engine can rely on without a bad row anywhere ever throwing.
//
// -- The vocabulary is deliberately closed and small ------------------------
// Seven trigger types, three condition types, five action types -- exactly
// what IMPLEMENTATION-PLAN.md's WP-3.1 section names, no more. "manual" is
// the trigger every migrated scene gets (see migrate-scenes.cjs): a smart
// function that only ever runs when explicitly invoked, exactly like a scene
// button today. The five action types are the exact five scene capabilities
// (src/scenes.ts's NotchSceneConfig) this WP's first acceptance criterion
// requires: launch apps, open URLs, control the timer, switch environment,
// create tasks -- see actions.cjs for the executors themselves.
// ---------------------------------------------------------------------------

"use strict";

const TRIGGER_TYPES = [
	"manual",
	"environment.switched",
	"session.started",
	"session.stopped",
	"app.launched",
	"time.of_day",
	"display.connected",
	"file.changed",
];

const CONDITION_TYPES = ["environment", "time_window", "app_running"];

const ACTION_TYPES = ["launchApp", "openUrl", "timer", "switchEnvironment", "createTask"];

const asString = (value) => (typeof value === "string" ? value : "");
const asTrimmedString = (value) => asString(value).trim();
const asOptionalTrimmedString = (value) => {
	const trimmed = asTrimmedString(value);
	return trimmed || null;
};
const asBoolean = (value, fallback) => (typeof value === "boolean" ? value : fallback);

// "HH:MM", 24-hour, zero-padded -- the one time format this whole package
// uses (time_window's start/end, time.of_day's own `time` field, and the
// engine's synthetic per-minute tick -- see engine.cjs).
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimeOfDay(value) {
	return typeof value === "string" && TIME_OF_DAY_PATTERN.test(value);
}

// -- Trigger -----------------------------------------------------------------

function normalizeTrigger(raw) {
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const type = TRIGGER_TYPES.includes(value.type) ? value.type : "manual";
	switch (type) {
		case "environment.switched":
			// `environmentId` optionally narrows the trigger to one specific
			// environment being switched INTO; omitted/blank means "any switch".
			return { type, environmentId: asOptionalTrimmedString(value.environmentId) };
		case "app.launched":
			// `processName` optionally narrows to one process; blank means "any
			// app becoming the foreground app" -- see evaluate.cjs.
			return { type, processName: asOptionalTrimmedString(value.processName) };
		case "time.of_day":
			return { type, time: isValidTimeOfDay(value.time) ? value.time : "09:00" };
		case "file.changed":
			return {
				type,
				// Simple case-insensitive substring/suffix match against the
				// changed path -- deliberately not a full glob engine (see
				// evaluate.cjs's matchesFilePattern for why this is enough for v1).
				pattern: asOptionalTrimmedString(value.pattern),
				kind: value.kind === "created" || value.kind === "modified" || value.kind === "removed" ? value.kind : null,
			};
		case "session.started":
		case "session.stopped":
		case "display.connected":
		case "manual":
		default:
			return { type };
	}
}

// -- Conditions ---------------------------------------------------------------

function normalizeCondition(raw) {
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	if (!CONDITION_TYPES.includes(value.type)) {
		return null;
	}
	switch (value.type) {
		case "environment":
			return asTrimmedString(value.environmentId) ? { type: "environment", environmentId: asTrimmedString(value.environmentId) } : null;
		case "time_window":
			return isValidTimeOfDay(value.start) && isValidTimeOfDay(value.end)
				? { type: "time_window", start: value.start, end: value.end }
				: null;
		case "app_running":
			return asTrimmedString(value.processName) ? { type: "app_running", processName: asTrimmedString(value.processName) } : null;
		default:
			return null;
	}
}

function normalizeConditions(raw) {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(normalizeCondition).filter((condition) => condition !== null);
}

// -- Actions -------------------------------------------------------------------

function normalizeAction(raw) {
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	if (!ACTION_TYPES.includes(value.type)) {
		return null;
	}
	switch (value.type) {
		case "launchApp":
			return asTrimmedString(value.command) ? { type: "launchApp", command: asTrimmedString(value.command) } : null;
		case "openUrl":
			return asTrimmedString(value.url) ? { type: "openUrl", url: asTrimmedString(value.url) } : null;
		case "timer":
			return value.mode === "start" || value.mode === "stop" ? { type: "timer", mode: value.mode } : null;
		case "switchEnvironment":
			return asTrimmedString(value.environmentId)
				? { type: "switchEnvironment", environmentId: asTrimmedString(value.environmentId) }
				: null;
		case "createTask":
			return asTrimmedString(value.title)
				? { type: "createTask", title: asTrimmedString(value.title), column: asOptionalTrimmedString(value.column) }
				: null;
		default:
			return null;
	}
}

function normalizeActions(raw) {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(normalizeAction).filter((action) => action !== null);
}

// -- Whole rule ----------------------------------------------------------------

// Tolerant JSON.parse -- never throws, falls back to `fallback` (an already-
// parsed default, e.g. `[]`) for anything malformed, exactly like
// src/scenes.ts's parseSceneConfig treats a corrupted config string.
function parseJsonColumn(raw, fallback) {
	if (raw === null || raw === undefined) {
		return fallback;
	}
	if (typeof raw !== "string") {
		return raw;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return fallback;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return fallback;
	}
}

// Turns a raw `smart_functions` row (trigger/conditions/actions as JSON
// strings, enabled as 0/1) into the in-memory rule shape the engine and
// evaluate.cjs both use. Never throws: a corrupted row degrades to a disabled
// manual-trigger rule with no actions, rather than crashing the whole engine.
function rowToRule(row) {
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		environmentId: row.environment_id ?? null,
		label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : "Untitled smart function",
		enabled: Number(row.enabled) === 1,
		trigger: normalizeTrigger(parseJsonColumn(row.trigger, { type: "manual" })),
		conditions: normalizeConditions(parseJsonColumn(row.conditions, [])),
		actions: normalizeActions(parseJsonColumn(row.actions, [])),
		source: row.source === "migrated-scene" ? "migrated-scene" : "user",
		migratedFrom: row.migrated_from ?? null,
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
	};
}

// The inverse direction: a plain-object input (from an IPC call, or a
// migration) into the exact JSON strings `smart_functions` stores. Applies
// the SAME normalization as rowToRule's read path, so a rule round-trips
// (write, then read back) to an identical in-memory shape -- no separate,
// potentially-drifting validation on the write side.
function normalizeRuleInput(input = {}) {
	return {
		label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : "Untitled smart function",
		environmentId: asOptionalTrimmedString(input.environmentId),
		enabled: asBoolean(input.enabled, true),
		trigger: normalizeTrigger(input.trigger),
		conditions: normalizeConditions(input.conditions),
		actions: normalizeActions(input.actions),
		source: input.source === "migrated-scene" ? "migrated-scene" : "user",
		migratedFrom: asOptionalTrimmedString(input.migratedFrom),
	};
}

module.exports = {
	TRIGGER_TYPES,
	CONDITION_TYPES,
	ACTION_TYPES,
	isValidTimeOfDay,
	normalizeTrigger,
	normalizeCondition,
	normalizeConditions,
	normalizeAction,
	normalizeActions,
	normalizeRuleInput,
	parseJsonColumn,
	rowToRule,
};
