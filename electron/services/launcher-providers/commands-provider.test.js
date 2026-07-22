import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createLauncherProviderRegistry } from "./index.cjs";
import { search, execute, COMMANDS, decodeResultId } from "./commands-provider.cjs";

// ---------------------------------------------------------------------------
// The "commands" provider (WP-2.9). Uses a REAL AtlasDatabase (a real sqlite
// file in a temp dir, migrated exactly like a real boot) for anything that
// touches tasks/notes/sessions -- same reasoning as data-provider.test.js:
// proving this provider goes through electron/data/scoped.cjs for real,
// rather than reimplementing (and potentially getting wrong) its own ad hoc
// environment filtering.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-commands-provider-test-"));
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
		setCurrentSession(id) {
			this.currentSessionId = id;
		},
		clearCurrentSession() {
			this.currentSessionId = null;
		},
		closeOpenBlockNow: vi.fn(),
	};
}

async function seedTwoEnvironments() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const envA = db.createEnvironment("Environment A");
	const envB = db.createEnvironment("Environment B");
	return { db, envA, envB };
}

// ---------------------------------------------------------------------------

describe("COMMANDS registry -- single source of truth", () => {
	it("has no duplicate command ids", () => {
		const ids = COMMANDS.map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every command is reachable through search() on a blank query", () => {
		const results = search("", {});
		const resultIds = results.map((r) => decodeResultId(r.id)?.commandId).sort();
		expect(resultIds).toEqual(COMMANDS.map((c) => c.id).sort());
	});

	it("every command has an id, a title, keywords, and a run() function", () => {
		for (const command of COMMANDS) {
			expect(typeof command.id).toBe("string");
			expect(command.id.length).toBeGreaterThan(0);
			expect(typeof command.title).toBe("string");
			expect(Array.isArray(command.keywords)).toBe(true);
			expect(typeof command.run).toBe("function");
		}
	});
});

describe("search() -- argument parsing", () => {
	it('parses "task Buy milk" into the task command with arg "Buy milk"', () => {
		const results = search("task Buy milk", {});
		const taskResult = results.find((r) => decodeResultId(r.id)?.commandId === "task");
		expect(taskResult).toBeDefined();
		expect(decodeResultId(taskResult.id)).toEqual({ commandId: "task", arg: "Buy milk" });
		expect(taskResult.title).toBe('Create a new task: "Buy milk"');
	});

	it('parses "note Remember the milk" into the note command with the full remainder as arg', () => {
		const results = search("note Remember the milk", {});
		const noteResult = results.find((r) => decodeResultId(r.id)?.commandId === "note");
		expect(noteResult).toBeDefined();
		expect(decodeResultId(noteResult.id).arg).toBe("Remember the milk");
	});

	it("preserves the argument's original casing and punctuation", () => {
		const results = search("task Meeting 3:00pm w/ Sam", {});
		const taskResult = results.find((r) => decodeResultId(r.id)?.commandId === "task");
		expect(decodeResultId(taskResult.id).arg).toBe("Meeting 3:00pm w/ Sam");
	});

	it('a bare verb with nothing typed after it (e.g. "task") still matches, with an empty arg', () => {
		const results = search("task", {});
		const taskResult = results.find((r) => decodeResultId(r.id)?.commandId === "task");
		expect(taskResult).toBeDefined();
		expect(decodeResultId(taskResult.id)).toEqual({ commandId: "task", arg: "" });
		expect(taskResult.title).toBe("Create a new task"); // unchanged -- nothing typed yet
	});

	it("matches a no-argument command via a plain title/keyword substring", () => {
		const results = search("dash", {});
		expect(results.some((r) => decodeResultId(r.id)?.commandId === "open-dashboard")).toBe(true);
	});

	it("returns every command for a blank query, exactly like actions-provider.cjs", () => {
		const results = search("", {});
		expect(results).toHaveLength(COMMANDS.length);
	});

	it("returns no results for a query that matches nothing", () => {
		const results = search("zzzznonexistentzzzz", {});
		expect(results).toEqual([]);
	});
});

describe("execute() -- task/note creation is environment-scoped", () => {
	it('creates a task titled "Buy milk" in the active environment', async () => {
		const { db, envA } = await seedTwoEnvironments();
		const eventLog = { record: vi.fn() };
		const outcome = await execute(
			{ id: "task:Buy milk" },
			{ environmentId: envA.id },
			{ getDb: () => db, getEventLog: () => eventLog },
		);

		expect(outcome.ok).toBe(true);
		const tasks = db.listTasksByEnvironment(envA.id);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe("Buy milk");
		expect(eventLog.record).toHaveBeenCalledWith("task.create", { environmentId: envA.id, subject: tasks[0].id });
	});

	it("never creates the task in a DIFFERENT environment than the active one", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		await execute({ id: "task:Buy milk" }, { environmentId: envA.id }, { getDb: () => db });

		expect(db.listTasksByEnvironment(envA.id)).toHaveLength(1);
		expect(db.listTasksByEnvironment(envB.id)).toHaveLength(0);
	});

	it("refuses to create a task with a blank title", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const outcome = await execute({ id: "task:" }, { environmentId: envA.id }, { getDb: () => db });

		expect(outcome.ok).toBe(false);
		expect(db.listTasksByEnvironment(envA.id)).toHaveLength(0);
	});

	it("refuses to create a task with no active environment", async () => {
		const { db } = await seedTwoEnvironments();
		const outcome = await execute({ id: "task:Buy milk" }, { environmentId: null }, { getDb: () => db });

		expect(outcome.ok).toBe(false);
	});

	// Unlike tasks, "notes" are not independent rows: db.cjs's `notes` table
	// holds exactly ONE canvas document per environment, and
	// getNotebookByEnvironment lazily CREATES that document (with the default
	// empty content) the first time anything reads it -- so
	// listNotesByEnvironment(envB) would always come back with length 1 the
	// instant this test calls it, seeded row or not, and can't prove
	// isolation by itself. Assert on CONTENT instead: envA's document holds
	// the typed text, envB's was never touched by it.
	it("creates a note in the active environment without touching a different environment's notebook", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		const eventLog = { record: vi.fn() };
		const outcome = await execute(
			{ id: "note:Remember the milk" },
			{ environmentId: envA.id },
			{ getDb: () => db, getEventLog: () => eventLog },
		);

		expect(outcome.ok).toBe(true);
		expect(db.getNotebookByEnvironment(envA.id).content).toBe("Remember the milk");
		expect(db.getNotebookByEnvironment(envB.id).content).not.toContain("Remember the milk");
		expect(eventLog.record).toHaveBeenCalledWith(
			"note.create",
			expect.objectContaining({ environmentId: envA.id }),
		);
	});
});

describe("execute() -- start/stop timer", () => {
	it("starts the timer, tells the tracker, and records session.start", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const tracker = createFakeTracker();
		const eventLog = { record: vi.fn() };
		const outcome = await execute(
			{ id: "start-timer" },
			{ environmentId: envA.id },
			{ getDb: () => db, getTracker: () => tracker, getEventLog: () => eventLog },
		);

		expect(outcome.ok).toBe(true);
		expect(db.getActiveSession()).not.toBeNull();
		expect(tracker.currentSessionId).toBe(db.getActiveSession().id);
		expect(eventLog.record).toHaveBeenCalledWith(
			"session.start",
			expect.objectContaining({ environmentId: envA.id }),
		);
	});

	it("reports ok:false (not a throw) when a session is already active", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const tracker = createFakeTracker();
		await execute({ id: "start-timer" }, { environmentId: envA.id }, { getDb: () => db, getTracker: () => tracker });

		const outcome = await execute(
			{ id: "start-timer" },
			{ environmentId: envA.id },
			{ getDb: () => db, getTracker: () => tracker },
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/already active/i);
	});

	it("stops the active timer, closes the tracker's open block, and clears its current session", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const tracker = createFakeTracker();
		const eventLog = { record: vi.fn() };
		await execute({ id: "start-timer" }, { environmentId: envA.id }, { getDb: () => db, getTracker: () => tracker });
		eventLog.record.mockClear();

		const outcome = await execute(
			{ id: "stop-timer" },
			{ environmentId: envA.id },
			{ getDb: () => db, getTracker: () => tracker, getEventLog: () => eventLog },
		);

		expect(outcome.ok).toBe(true);
		expect(tracker.closeOpenBlockNow).toHaveBeenCalled();
		expect(tracker.currentSessionId).toBeNull();
		expect(db.getActiveSession()).toBeNull();
		expect(eventLog.record).toHaveBeenCalledWith("session.stop", expect.any(Object));
	});

	it("closes the mini window on stop, exactly like session:stop does", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const tracker = createFakeTracker();
		await execute({ id: "start-timer" }, { environmentId: envA.id }, { getDb: () => db, getTracker: () => tracker });

		const miniWindow = { isDestroyed: () => false, close: vi.fn() };
		await execute(
			{ id: "stop-timer" },
			{ environmentId: envA.id },
			{ getDb: () => db, getTracker: () => tracker, getMiniWindow: () => miniWindow },
		);

		expect(miniWindow.close).toHaveBeenCalled();
	});

	it("reports ok:false (not a throw) when there is nothing to stop", async () => {
		const { db } = await seedTwoEnvironments();
		const outcome = await execute({ id: "stop-timer" }, {}, { getDb: () => db });
		expect(outcome.ok).toBe(false);
	});
});

describe("execute() -- switch environment", () => {
	it("resolves the environment by a case-insensitive name match and switches to it", async () => {
		const { db, envB } = await seedTwoEnvironments();
		const switchEnvironment = vi.fn(() => true);
		const navigate = vi.fn(() => true);
		const outcome = await execute(
			{ id: "switch-environment:environment b" },
			{},
			{ getDb: () => db, switchEnvironment, navigate },
		);

		expect(outcome.ok).toBe(true);
		expect(switchEnvironment).toHaveBeenCalledWith(envB.id);
		expect(navigate).toHaveBeenCalledWith("dashboard");
	});

	it("reports ok:false without throwing for a name matching no environment", async () => {
		const { db } = await seedTwoEnvironments();
		const switchEnvironment = vi.fn();
		const outcome = await execute(
			{ id: "switch-environment:not a real place" },
			{},
			{ getDb: () => db, switchEnvironment },
		);

		expect(outcome.ok).toBe(false);
		expect(switchEnvironment).not.toHaveBeenCalled();
	});
});

describe("execute() -- open a view / open Settings", () => {
	it.each([
		["open-tasks", "tasks"],
		["open-notes", "notes"],
		["open-activity", "activity"],
		["open-dashboard", "dashboard"],
	])("%s navigates to %s", async (commandId, view) => {
		const navigate = vi.fn(() => true);
		const outcome = await execute({ id: commandId }, {}, { navigate });
		expect(navigate).toHaveBeenCalledWith(view);
		expect(outcome.ok).toBe(true);
	});

	it("open-settings creates the Settings window with the main window as parent", async () => {
		const mainWindow = { id: "main" };
		const createSettingsWindow = vi.fn(() => ({ id: "settings" }));
		const outcome = await execute(
			{ id: "open-settings" },
			{},
			{ getMainWindow: () => mainWindow, createSettingsWindow },
		);

		expect(createSettingsWindow).toHaveBeenCalledWith(mainWindow);
		expect(outcome.ok).toBe(true);
	});

	it("open-settings falls back to the welcome window when no main window exists yet", async () => {
		const welcomeWindow = { id: "welcome" };
		const createSettingsWindow = vi.fn(() => ({ id: "settings" }));
		await execute(
			{ id: "open-settings" },
			{},
			{ getMainWindow: () => null, getWelcomeWindow: () => welcomeWindow, createSettingsWindow },
		);

		expect(createSettingsWindow).toHaveBeenCalledWith(welcomeWindow);
	});
});

describe("execute() -- unknown ids never throw", () => {
	it("reports ok:false for a completely unknown command id", async () => {
		const outcome = await execute({ id: "not-a-real-command" }, {}, {});
		expect(outcome.ok).toBe(false);
	});
});

describe("decodeResultId()", () => {
	it("splits on the first colon only, keeping later colons as part of the argument", () => {
		expect(decodeResultId("task:Meeting 3:00pm")).toEqual({ commandId: "task", arg: "Meeting 3:00pm" });
	});

	it("returns an id with a null arg when there is no colon at all", () => {
		expect(decodeResultId("open-dashboard")).toEqual({ commandId: "open-dashboard", arg: null });
	});

	it("returns null for a malformed id", () => {
		expect(decodeResultId("")).toBeNull();
		expect(decodeResultId(null)).toBeNull();
		expect(decodeResultId(123)).toBeNull();
	});
});

describe("end-to-end through the registry (namespacing + routing, real db)", () => {
	it("searches, namespaces, and executes a task-creation command through an isolated registry", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const registry = createLauncherProviderRegistry();
		registry.registerProvider({ name: "commands", search, execute });
		registry.init({ getDb: () => db });

		const results = await registry.search("task Buy milk", { environmentId: envA.id });
		const taskResult = results.find((r) => r.providerName === "commands" && r.id.startsWith("commands::task:"));
		expect(taskResult).toBeDefined();

		const outcome = await registry.execute(taskResult.id, { environmentId: envA.id, modifier: null });
		expect(outcome.ok).toBe(true);
		expect(db.listTasksByEnvironment(envA.id).map((t) => t.title)).toEqual(["Buy milk"]);
	});
});
