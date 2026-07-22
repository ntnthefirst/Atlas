import { describe, expect, it } from "vitest";
import {
	TRIGGER_TYPES,
	CONDITION_TYPES,
	ACTION_TYPES,
	normalizeTrigger,
	normalizeConditions,
	normalizeActions,
	normalizeRuleInput,
	rowToRule,
	parseJsonColumn,
} from "./model.cjs";

describe("normalizeTrigger", () => {
	it("falls back to manual for a missing/unrecognized type", () => {
		expect(normalizeTrigger(null)).toEqual({ type: "manual" });
		expect(normalizeTrigger({ type: "not-a-real-trigger" })).toEqual({ type: "manual" });
	});

	it("keeps every documented trigger type intact with its own fields", () => {
		expect(normalizeTrigger({ type: "environment.switched", environmentId: "env-a" })).toEqual({
			type: "environment.switched",
			environmentId: "env-a",
		});
		expect(normalizeTrigger({ type: "environment.switched" })).toEqual({
			type: "environment.switched",
			environmentId: null,
		});
		expect(normalizeTrigger({ type: "app.launched", processName: "chrome" })).toEqual({
			type: "app.launched",
			processName: "chrome",
		});
		expect(normalizeTrigger({ type: "session.started" })).toEqual({ type: "session.started" });
		expect(normalizeTrigger({ type: "session.stopped" })).toEqual({ type: "session.stopped" });
		expect(normalizeTrigger({ type: "display.connected" })).toEqual({ type: "display.connected" });
	});

	it("clamps time.of_day to a valid HH:MM, defaulting an invalid one", () => {
		expect(normalizeTrigger({ type: "time.of_day", time: "08:30" })).toEqual({ type: "time.of_day", time: "08:30" });
		expect(normalizeTrigger({ type: "time.of_day", time: "not-a-time" })).toEqual({
			type: "time.of_day",
			time: "09:00",
		});
		expect(normalizeTrigger({ type: "time.of_day", time: "25:00" })).toEqual({ type: "time.of_day", time: "09:00" });
	});

	it("normalizes file.changed's pattern/kind, both optional", () => {
		expect(normalizeTrigger({ type: "file.changed", pattern: "*.psd", kind: "created" })).toEqual({
			type: "file.changed",
			pattern: "*.psd",
			kind: "created",
		});
		expect(normalizeTrigger({ type: "file.changed" })).toEqual({ type: "file.changed", pattern: null, kind: null });
		expect(normalizeTrigger({ type: "file.changed", kind: "bogus" })).toEqual({
			type: "file.changed",
			pattern: null,
			kind: null,
		});
	});

	it("every documented trigger type is reachable", () => {
		for (const type of TRIGGER_TYPES) {
			expect(normalizeTrigger({ type }).type).toBe(type);
		}
	});
});

describe("normalizeConditions", () => {
	it("drops a condition with an unrecognized type or missing required field", () => {
		expect(normalizeConditions([{ type: "not-real" }])).toEqual([]);
		expect(normalizeConditions([{ type: "environment" }])).toEqual([]); // no environmentId
		expect(normalizeConditions([{ type: "time_window", start: "09:00" }])).toEqual([]); // no end
		expect(normalizeConditions([{ type: "app_running" }])).toEqual([]); // no processName
	});

	it("keeps every documented condition type intact", () => {
		expect(normalizeConditions([{ type: "environment", environmentId: "env-a" }])).toEqual([
			{ type: "environment", environmentId: "env-a" },
		]);
		expect(normalizeConditions([{ type: "time_window", start: "09:00", end: "17:00" }])).toEqual([
			{ type: "time_window", start: "09:00", end: "17:00" },
		]);
		expect(normalizeConditions([{ type: "app_running", processName: "chrome" }])).toEqual([
			{ type: "app_running", processName: "chrome" },
		]);
	});

	it("every documented condition type is reachable", () => {
		expect(CONDITION_TYPES).toEqual(["environment", "time_window", "app_running"]);
	});

	it("is not an array -> empty, never throws", () => {
		expect(normalizeConditions(null)).toEqual([]);
		expect(normalizeConditions("not-an-array")).toEqual([]);
	});
});

describe("normalizeActions", () => {
	it("drops an action with an unrecognized type or missing required field", () => {
		expect(normalizeActions([{ type: "not-real" }])).toEqual([]);
		expect(normalizeActions([{ type: "launchApp" }])).toEqual([]); // no command
		expect(normalizeActions([{ type: "openUrl" }])).toEqual([]); // no url
		expect(normalizeActions([{ type: "timer", mode: "pause" }])).toEqual([]); // invalid mode
		expect(normalizeActions([{ type: "switchEnvironment" }])).toEqual([]); // no environmentId
		expect(normalizeActions([{ type: "createTask" }])).toEqual([]); // no title
	});

	it("keeps every documented action type intact", () => {
		expect(normalizeActions([{ type: "launchApp", command: "notepad.exe" }])).toEqual([
			{ type: "launchApp", command: "notepad.exe" },
		]);
		expect(normalizeActions([{ type: "openUrl", url: "https://example.com" }])).toEqual([
			{ type: "openUrl", url: "https://example.com" },
		]);
		expect(normalizeActions([{ type: "timer", mode: "start" }])).toEqual([{ type: "timer", mode: "start" }]);
		expect(normalizeActions([{ type: "timer", mode: "stop" }])).toEqual([{ type: "timer", mode: "stop" }]);
		expect(normalizeActions([{ type: "switchEnvironment", environmentId: "env-a" }])).toEqual([
			{ type: "switchEnvironment", environmentId: "env-a" },
		]);
		expect(normalizeActions([{ type: "createTask", title: "Buy milk", column: "todo" }])).toEqual([
			{ type: "createTask", title: "Buy milk", column: "todo" },
		]);
	});

	it("every documented action type is reachable", () => {
		expect(ACTION_TYPES).toEqual(["launchApp", "openUrl", "timer", "switchEnvironment", "createTask"]);
	});
});

describe("rowToRule / normalizeRuleInput round-trip", () => {
	it("parses a well-formed row into the in-memory rule shape", () => {
		const row = {
			id: "sf-1",
			environment_id: "env-a",
			label: "Start focus",
			enabled: 1,
			trigger: JSON.stringify({ type: "app.launched", processName: "Code" }),
			conditions: JSON.stringify([{ type: "environment", environmentId: "env-a" }]),
			actions: JSON.stringify([{ type: "timer", mode: "start" }]),
			source: "user",
			migrated_from: null,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		expect(rowToRule(row)).toEqual({
			id: "sf-1",
			environmentId: "env-a",
			label: "Start focus",
			enabled: true,
			trigger: { type: "app.launched", processName: "Code" },
			conditions: [{ type: "environment", environmentId: "env-a" }],
			actions: [{ type: "timer", mode: "start" }],
			source: "user",
			migratedFrom: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("a corrupted JSON column degrades to a safe default instead of throwing", () => {
		const row = {
			id: "sf-2",
			label: "Broken",
			enabled: 0,
			trigger: "{not json",
			conditions: "{not json",
			actions: "{not json",
		};
		const rule = rowToRule(row);
		expect(rule.trigger).toEqual({ type: "manual" });
		expect(rule.conditions).toEqual([]);
		expect(rule.actions).toEqual([]);
		expect(rule.enabled).toBe(false);
	});

	it("returns null for a null row (not found)", () => {
		expect(rowToRule(null)).toBeNull();
	});

	it("normalizeRuleInput defaults enabled to true and label to a placeholder", () => {
		const normalized = normalizeRuleInput({});
		expect(normalized.enabled).toBe(true);
		expect(normalized.label).toBe("Untitled smart function");
		expect(normalized.trigger).toEqual({ type: "manual" });
		expect(normalized.conditions).toEqual([]);
		expect(normalized.actions).toEqual([]);
		expect(normalized.environmentId).toBeNull();
	});
});

describe("parseJsonColumn", () => {
	it("falls back on null/undefined/malformed input, never throws", () => {
		expect(parseJsonColumn(null, [])).toEqual([]);
		expect(parseJsonColumn(undefined, [])).toEqual([]);
		expect(parseJsonColumn("not json", [])).toEqual([]);
		expect(parseJsonColumn("", [])).toEqual([]);
	});

	it("parses valid JSON", () => {
		expect(parseJsonColumn('{"a":1}', {})).toEqual({ a: 1 });
	});
});
