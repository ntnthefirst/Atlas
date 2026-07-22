import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { ACTION_RUNNERS } from "./actions.cjs";

// ---------------------------------------------------------------------------
// Smart Functions action executors (WP-3.1). Uses a REAL AtlasDatabase (temp
// file, never %APPDATA%/Atlas) for anything that touches tasks/sessions --
// same reasoning as commands-provider.test.js: proving these go through
// electron/data/scoped.cjs for real. `platform`/`getTracker`/`switchEnvironment`
// are fakes -- this suite must never spawn a real process or touch a real
// environment switch.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sf-actions-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createFakeTracker() {
	return {
		currentSessionId: null,
		setCurrentSession: vi.fn(function setCurrentSession(id) {
			this.currentSessionId = id;
		}),
		closeOpenBlockNow: vi.fn(),
	};
}

function createExecCtx(overrides = {}) {
	const events = [];
	const eventLog = { record: vi.fn((type, options) => events.push({ type, ...options })) };
	const dispatched = [];
	return {
		db: null,
		environmentId: null,
		getEventLog: () => eventLog,
		getTracker: () => createFakeTracker(),
		platform: { launch: vi.fn().mockResolvedValue({ supported: true, launched: true }) },
		switchEnvironment: vi.fn(),
		dispatchNext: vi.fn((event) => dispatched.push(event)),
		_events: events,
		_dispatched: dispatched,
		...overrides,
	};
}

const rule = { id: "rule-1", label: "Test rule" };

describe("launchApp", () => {
	it("calls platform.launch with the exact command", async () => {
		const execCtx = createExecCtx();
		const detail = await ACTION_RUNNERS.launchApp({ type: "launchApp", command: 'notepad.exe "C:\\file.txt"' }, execCtx, rule);
		expect(execCtx.platform.launch).toHaveBeenCalledWith('notepad.exe "C:\\file.txt"');
		expect(detail).toContain("notepad.exe");
	});
});

describe("openUrl", () => {
	it("uses the same start \"\" \"<url>\" shell trick NotchApp.tsx#runScene uses", async () => {
		const execCtx = createExecCtx();
		await ACTION_RUNNERS.openUrl({ type: "openUrl", url: "https://example.com" }, execCtx, rule);
		expect(execCtx.platform.launch).toHaveBeenCalledWith('start "" "https://example.com"');
	});
});

describe("timer", () => {
	it("start: creates a session, sets the tracker's current session, logs session.start, and re-dispatches", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env A");
		const execCtx = createExecCtx({ db, environmentId: environment.id });

		await ACTION_RUNNERS.timer({ type: "timer", mode: "start" }, execCtx, rule);

		const active = db.getActiveSession();
		expect(active).toBeTruthy();
		expect(active.environment_id).toBe(environment.id);
		expect(execCtx._events).toHaveLength(1);
		expect(execCtx._events[0].type).toBe("session.start");
		expect(execCtx._events[0].payload).toEqual({ smartFunctionOrigin: "rule-1" });
		expect(execCtx._dispatched).toEqual([{ type: "session.start", environmentId: environment.id, sessionId: active.id }]);
	});

	it("start: throws when there is no environment to start a timer in", async () => {
		const execCtx = createExecCtx({ db: {}, environmentId: null });
		await expect(ACTION_RUNNERS.timer({ type: "timer", mode: "start" }, execCtx, rule)).rejects.toThrow(/no environment/i);
	});

	it("stop: stops the active session and re-dispatches session.stop", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env A");
		const started = db.startSession(environment.id);
		const execCtx = createExecCtx({ db, environmentId: environment.id });

		await ACTION_RUNNERS.timer({ type: "timer", mode: "stop" }, execCtx, rule);

		expect(db.getActiveSession()).toBeNull();
		expect(execCtx._events[0]).toMatchObject({ type: "session.stop", sessionId: started.id });
		expect(execCtx._dispatched).toEqual([
			{ type: "session.stop", environmentId: environment.id, sessionId: started.id },
		]);
	});

	it("stop: throws when there is no active timer", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const execCtx = createExecCtx({ db, environmentId: null });
		await expect(ACTION_RUNNERS.timer({ type: "timer", mode: "stop" }, execCtx, rule)).rejects.toThrow(/no active timer/i);
	});
});

describe("switchEnvironment", () => {
	it("calls switchEnvironment, tags+logs environment.switch, and re-dispatches it", async () => {
		const execCtx = createExecCtx();
		await ACTION_RUNNERS.switchEnvironment({ type: "switchEnvironment", environmentId: "env-b" }, execCtx, rule);

		expect(execCtx.switchEnvironment).toHaveBeenCalledWith("env-b");
		expect(execCtx._events).toEqual([
			{ type: "environment.switch", environmentId: "env-b", payload: { smartFunctionOrigin: "rule-1" } },
		]);
		expect(execCtx._dispatched).toEqual([{ type: "environment.switch", environmentId: "env-b" }]);
	});
});

describe("createTask", () => {
	it("creates a task, optionally moves it to a column, and logs task.create (untagged)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Env A");
		const execCtx = createExecCtx({ db, environmentId: environment.id });

		await ACTION_RUNNERS.createTask({ type: "createTask", title: "Buy milk", column: "done" }, execCtx, rule);

		const tasks = db.listTasksByEnvironment(environment.id);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe("Buy milk");
		expect(tasks[0].status).toBe("done");
		expect(execCtx._events).toEqual([{ type: "task.create", environmentId: environment.id, subject: tasks[0].id }]);
		// task.create is never tagged/re-dispatched -- no trigger type reacts to
		// it (see model.cjs's TRIGGER_TYPES), so there is nothing to feed back.
		expect(execCtx._dispatched).toEqual([]);
	});

	it("throws when there is no environment to create a task in", async () => {
		const execCtx = createExecCtx({ db: {}, environmentId: null });
		await expect(ACTION_RUNNERS.createTask({ type: "createTask", title: "x" }, execCtx, rule)).rejects.toThrow(
			/no environment/i,
		);
	});
});
