import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { runActions } from "./runner.cjs";

// ---------------------------------------------------------------------------
// Smart Functions action runner (WP-3.1) -- "a failing action does not abort
// the remaining actions". Uses a real AtlasDatabase for the createTask
// actions so a genuine throw (timer stop with no active session) sits
// between two genuine successes, never a hand-rolled mock of scoped.cjs.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sf-runner-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function createExecCtx(overrides = {}) {
	const events = [];
	const eventLog = { record: vi.fn((type, options) => events.push({ type, ...options })) };
	return {
		db: null,
		environmentId: null,
		getEventLog: () => eventLog,
		getTracker: () => null,
		platform: { launch: vi.fn().mockResolvedValue({ supported: true, launched: true }) },
		switchEnvironment: vi.fn(),
		dispatchNext: vi.fn(),
		_events: events,
		...overrides,
	};
}

describe("runActions -- partial failure isolation", () => {
	it("an action that throws in the middle of the list does not stop the ones after it", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env A");
		const execCtx = createExecCtx({ db, environmentId: environment.id });

		// action #0 succeeds, #1 THROWS (no active session to stop), #2 succeeds
		// -- a fixture that actively puts a real failure in the middle, not at
		// either end, so "continues past a failure" can't pass by accident.
		const rule = {
			id: "rule-1",
			label: "Partial failure rule",
			actions: [
				{ type: "createTask", title: "Task before the failure" },
				{ type: "timer", mode: "stop" }, // no active session -> throws
				{ type: "createTask", title: "Task after the failure" },
			],
		};

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const summary = await runActions(rule, execCtx);
		consoleSpy.mockRestore();

		expect(summary.actionCount).toBe(3);
		expect(summary.failedCount).toBe(1);
		expect(summary.results.map((r) => r.ok)).toEqual([true, false, true]);
		expect(summary.results[1].error).toMatch(/no active timer/i);

		// Both createTask actions genuinely ran -- not skipped, not silently
		// dropped -- proving "continues" means "keeps DOING work", not just
		// "keeps looping without doing anything". listTasksByEnvironment orders
		// newest-first, so sort by title before comparing.
		const tasks = db
			.listTasksByEnvironment(environment.id)
			.map((t) => t.title)
			.sort();
		expect(tasks).toEqual(["Task after the failure", "Task before the failure"]);

		// The failure was logged (event log + console), not silently swallowed.
		expect(execCtx._events.some((e) => e.type === "smart_function.action_failed")).toBe(true);
	});

	it("an unknown action type is recorded as a failed result, never thrown out of runActions", async () => {
		const execCtx = createExecCtx();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const rule = { id: "rule-2", label: "Unknown action", actions: [{ type: "not-a-real-action" }, { type: "launchApp", command: "notepad.exe" }] };

		const summary = await runActions(rule, execCtx);
		consoleSpy.mockRestore();

		expect(summary.failedCount).toBe(1);
		expect(summary.results[0]).toMatchObject({ ok: false, type: "not-a-real-action" });
		expect(summary.results[1]).toMatchObject({ ok: true, type: "launchApp" });
	});

	it("every action succeeding reports failedCount 0 -- a non-vacuous baseline for the tests above", async () => {
		const execCtx = createExecCtx();
		const rule = {
			id: "rule-3",
			label: "All succeed",
			actions: [
				{ type: "launchApp", command: "a.exe" },
				{ type: "launchApp", command: "b.exe" },
			],
		};
		const summary = await runActions(rule, execCtx);
		expect(summary.failedCount).toBe(0);
		expect(summary.actionCount).toBe(2);
	});

	it("an empty action list is a no-op, not an error", async () => {
		const execCtx = createExecCtx();
		const summary = await runActions({ id: "rule-4", label: "Empty", actions: [] }, execCtx);
		expect(summary).toEqual({ results: [], failedCount: 0, actionCount: 0 });
	});
});
