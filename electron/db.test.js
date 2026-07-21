import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { AtlasDatabase } from "./db.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing db.cjs across that boundary works, while
// the reverse does not: vitest's CJS entrypoint deliberately throws, so a
// `.cjs` test would need top-level `await import()`, which is not valid
// CommonJS and only survives because the test runner transforms it.

// Every test gets its own throwaway sqlite file under the OS temp dir, never
// anywhere near the user's real Electron userData database. Directories are
// tracked here and wiped in afterEach so a failing test can't leak a temp
// file into a later run.
const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("AtlasDatabase — schema creation", () => {
	it("creates all expected tables in a fresh database", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		for (const table of ["environments", "sessions", "pauses", "activity_blocks", "tasks", "notes"]) {
			expect(db.tableExists(table)).toBe(true);
		}
	});

	it("adds the incremental environment and task columns", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		for (const column of ["icon", "accent", "preset"]) {
			expect(db.columnExists("environments", column)).toBe(true);
		}
		for (const column of ["priority", "tags", "due_date"]) {
			expect(db.columnExists("tasks", column)).toBe(true);
		}
	});

	it("running create twice on the same path does not error or duplicate columns", async () => {
		const dbPath = createTempDbPath();
		const first = await AtlasDatabase.create(dbPath);
		first.createEnvironment("Existing environment");

		const second = await AtlasDatabase.create(dbPath);

		const environmentColumns = second.all("PRAGMA table_info(environments)");
		const taskColumns = second.all("PRAGMA table_info(tasks)");

		for (const column of ["icon", "accent", "preset"]) {
			expect(environmentColumns.filter((c) => c.name === column)).toHaveLength(1);
		}
		for (const column of ["priority", "tags", "due_date"]) {
			expect(taskColumns.filter((c) => c.name === column)).toHaveLength(1);
		}

		// Re-initializing schema didn't touch data that was already there.
		expect(second.listEnvironments()).toHaveLength(1);
	});
});

describe("AtlasDatabase — environment CRUD", () => {
	it("creates an environment with null metadata by default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const environment = db.createEnvironment("Deep Work");

		expect(environment.name).toBe("Deep Work");
		expect(environment.icon).toBeNull();
		expect(environment.accent).toBeNull();
		expect(environment.preset).toBeNull();
		expect(db.getEnvironment(environment.id)).toMatchObject({ id: environment.id, name: "Deep Work" });
	});

	it("creates an environment with icon/accent/preset metadata", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const environment = db.createEnvironment("Study", { icon: "book", accent: "#ff0000", preset: "school" });

		expect(db.getEnvironment(environment.id)).toMatchObject({
			name: "Study",
			icon: "book",
			accent: "#ff0000",
			preset: "school",
		});
	});

	it("lists environments ordered by creation time", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const first = db.createEnvironment("First");
		const second = db.createEnvironment("Second");
		// created_at is millisecond-precision wall-clock time; pin explicit,
		// distinct values so ordering can't tie-break unpredictably on fast CI.
		db.run("UPDATE environments SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE environments SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const environments = db.listEnvironments();
		expect(environments.map((m) => m.id)).toEqual([first.id, second.id]);
	});

	it("renames an environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Old name");

		const renamed = db.renameEnvironment(environment.id, "New name");

		expect(renamed.name).toBe("New name");
		expect(db.getEnvironment(environment.id).name).toBe("New name");
	});

	it("updates environment icon/accent/preset via updateEnvironment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Focus");

		const updated = db.updateEnvironment(environment.id, { icon: "target", accent: "#00ff00", preset: "custom" });

		expect(updated).toMatchObject({ icon: "target", accent: "#00ff00", preset: "custom" });
	});

	// WP-1.4: environments.accent and environments.config.appearance.accent are
	// deliberately the same value living in two places (see
	// environment-config.cjs's header comment) -- the atomic environment-switch
	// bundle reads accent from the config document, so a plain recolor through
	// updateEnvironment must keep that document in sync rather than leaving it
	// stale.
	it("keeps config.appearance.accent in sync when accent changes via updateEnvironment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Focus", { accent: "#00ff00" });
		expect(db.getEnvironmentConfig(environment.id).appearance.accent).toBe("#00ff00");

		db.updateEnvironment(environment.id, { accent: "#ff0000" });

		expect(db.getEnvironmentConfig(environment.id).appearance.accent).toBe("#ff0000");
	});

	it("does not touch config.appearance.accent when accent isn't part of the update", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Focus", { accent: "#00ff00" });

		db.updateEnvironment(environment.id, { icon: "target" });

		expect(db.getEnvironmentConfig(environment.id).appearance.accent).toBe("#00ff00");
	});

	it("ignores fields that aren't in the allowed list", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Focus", { icon: "target" });

		const updated = db.updateEnvironment(environment.id, { unrelatedField: "ignored" });

		expect(updated.icon).toBe("target");
	});

	it("deletes an environment along with its tasks, notes, and sessions", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Temp");
		db.createTask(environment.id, "A task");
		db.createNote(environment.id, "Some content");
		const session = db.startSession(environment.id);
		db.stopSession(session.id);

		expect(db.deleteEnvironment(environment.id)).toBe(true);

		expect(db.getEnvironment(environment.id)).toBeNull();
		expect(db.listTasksByEnvironment(environment.id)).toEqual([]);
		expect(db.listSessionsByEnvironment(environment.id)).toEqual([]);
	});

	it("throws when deleting an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.deleteEnvironment("nonexistent-id")).toThrow(/not found/i);
	});

	it("throws when deleting an environment with an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Active environment");
		db.startSession(environment.id);

		expect(() => db.deleteEnvironment(environment.id)).toThrow(/active session/i);
	});

	it("deletes an environment's events along with everything else (WP-1.5)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Temp");
		const other = db.createEnvironment("Other");
		db.run("INSERT INTO events (ts, environment_id, type) VALUES (?, ?, ?)", [
			new Date().toISOString(),
			environment.id,
			"task.complete",
		]);
		db.run("INSERT INTO events (ts, environment_id, type) VALUES (?, ?, ?)", [
			new Date().toISOString(),
			other.id,
			"task.complete",
		]);

		db.deleteEnvironment(environment.id);

		expect(db.all("SELECT * FROM events WHERE environment_id = ?", [environment.id])).toEqual([]);
		// A different environment's events are never touched by this.
		expect(db.all("SELECT * FROM events WHERE environment_id = ?", [other.id])).toHaveLength(1);
	});
});

describe("AtlasDatabase — environment archiving (WP-1.5)", () => {
	it("hides an archived environment from listEnvironments but keeps every row it owns", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.createEnvironment("Keep visible");
		const environment = db.createEnvironment("To archive");
		db.createTask(environment.id, "A task");
		db.createNote(environment.id, "Some content");
		const session = db.startSession(environment.id);
		db.stopSession(session.id);

		const archived = db.archiveEnvironment(environment.id);

		expect(archived.archived_at).toBeTruthy();
		expect(db.listEnvironments().map((e) => e.id)).not.toContain(environment.id);
		// Retrievable by id, data fully intact.
		expect(db.getEnvironment(environment.id)).toMatchObject({ id: environment.id, archived_at: archived.archived_at });
		expect(db.listTasksByEnvironment(environment.id)).toHaveLength(1);
		expect(db.listSessionsByEnvironment(environment.id)).toHaveLength(1);
	});

	it("lists an archived environment via listArchivedEnvironments, not listEnvironments", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.createEnvironment("Keep visible");
		const environment = db.createEnvironment("To archive");

		db.archiveEnvironment(environment.id);

		expect(db.listEnvironments().map((e) => e.id)).not.toContain(environment.id);
		expect(db.listArchivedEnvironments().map((e) => e.id)).toContain(environment.id);
	});

	it("is idempotent to archive an already-archived environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.createEnvironment("Keep visible");
		const environment = db.createEnvironment("To archive");

		const first = db.archiveEnvironment(environment.id);
		const second = db.archiveEnvironment(environment.id);

		expect(second.archived_at).toBe(first.archived_at);
	});

	it("unarchiveEnvironment reverses archiving and restores it to listEnvironments", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.createEnvironment("Keep visible");
		const environment = db.createEnvironment("To archive");
		db.archiveEnvironment(environment.id);

		const restored = db.unarchiveEnvironment(environment.id);

		expect(restored.archived_at).toBeNull();
		expect(db.listEnvironments().map((e) => e.id)).toContain(environment.id);
		expect(db.listArchivedEnvironments().map((e) => e.id)).not.toContain(environment.id);
	});

	it("throws when archiving or unarchiving an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.archiveEnvironment("nonexistent-id")).toThrow(/not found/i);
		expect(() => db.unarchiveEnvironment("nonexistent-id")).toThrow(/not found/i);
	});

	it("throws when archiving an environment with an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		db.createEnvironment("Keep visible");
		const environment = db.createEnvironment("Active environment");
		db.startSession(environment.id);

		expect(() => db.archiveEnvironment(environment.id)).toThrow(/active session/i);
	});

	it("refuses to archive the only remaining visible environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Only one");

		expect(() => db.archiveEnvironment(environment.id)).toThrow(/only environment/i);
		expect(db.listEnvironments().map((e) => e.id)).toContain(environment.id);
	});

	it("allows archiving down to one, but not past it, and unarchiving frees that up again", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const first = db.createEnvironment("First");
		const second = db.createEnvironment("Second");

		db.archiveEnvironment(first.id);
		expect(db.listEnvironments()).toHaveLength(1);
		expect(() => db.archiveEnvironment(second.id)).toThrow(/only environment/i);

		db.unarchiveEnvironment(first.id);
		expect(() => db.archiveEnvironment(second.id)).not.toThrow();
	});

	it("still allows DELETING the last remaining environment (a different, fully-confirmed action)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Only one");

		expect(() => db.deleteEnvironment(environment.id)).not.toThrow();
		expect(db.listEnvironments()).toHaveLength(0);
	});
});

describe("AtlasDatabase — environment content counts (WP-1.5)", () => {
	it("returns real, non-zero counts across every category", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Busy environment");
		db.createTask(environment.id, "Task 1");
		db.createTask(environment.id, "Task 2");
		const session = db.startSession(environment.id);
		db.createActivityBlock(session.id, "notepad.exe", new Date().toISOString());
		db.stopSession(session.id);
		db.updateNotebookByEnvironment(
			environment.id,
			JSON.stringify({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
		);
		db.run("INSERT INTO events (ts, environment_id, type) VALUES (?, ?, ?)", [
			new Date().toISOString(),
			environment.id,
			"task.complete",
		]);

		const counts = db.getEnvironmentContentCounts(environment.id);

		expect(counts.tasks).toBe(2);
		expect(counts.sessions).toBe(1);
		expect(counts.notes).toBe(3);
		expect(counts.activityBlocks).toBe(1);
		expect(counts.events).toBe(1);
		expect(counts.hasCustomNotchLayout).toBe(false);
	});

	it("returns all zeros for a brand-new, untouched environment (no notebook row created as a side effect)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Empty environment");

		const counts = db.getEnvironmentContentCounts(environment.id);

		expect(counts).toEqual({
			tasks: 0,
			sessions: 0,
			notes: 0,
			activityBlocks: 0,
			events: 0,
			hasCustomNotchLayout: false,
		});
		// Reading the counts must not itself create a notebook row.
		expect(db.all("SELECT id FROM notes WHERE environment_id = ?", [environment.id])).toEqual([]);
	});

	it("never leaks another environment's counts (WP-0.8 isolation)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const busy = db.createEnvironment("Busy");
		const quiet = db.createEnvironment("Quiet");
		db.createTask(busy.id, "Task 1");
		db.createTask(busy.id, "Task 2");
		db.createTask(busy.id, "Task 3");

		expect(db.getEnvironmentContentCounts(quiet.id).tasks).toBe(0);
		expect(db.getEnvironmentContentCounts(busy.id).tasks).toBe(3);
	});

	it("reports hasCustomNotchLayout once an environment has its own override", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Custom layout env");
		db.setEnvironmentNotchLayout(environment.id, { position: "left" });

		expect(db.getEnvironmentContentCounts(environment.id).hasCustomNotchLayout).toBe(true);
	});

	it("throws for an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.getEnvironmentContentCounts("nonexistent-id")).toThrow(/not found/i);
	});
});

describe("AtlasDatabase — duplicateEnvironment (WP-1.5)", () => {
	it("copies icon/accent/preset/isolation_mode into a brand new environment with a distinct id", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding", { icon: "code-bracket", accent: "#7d53de", preset: "coding" });
		db.setEnvironmentIsolationMode(source.id, "enclosed");

		const duplicate = db.duplicateEnvironment(source.id);

		expect(duplicate.id).not.toBe(source.id);
		expect(duplicate.icon).toBe("code-bracket");
		expect(duplicate.accent).toBe("#7d53de");
		expect(duplicate.preset).toBe("coding");
		expect(duplicate.isolation_mode).toBe("enclosed");
	});

	it("defaults the duplicate's name to '<source> copy', deduplicated against existing names", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding");

		const first = db.duplicateEnvironment(source.id);
		expect(first.name).toBe("Coding copy");

		const second = db.duplicateEnvironment(source.id);
		expect(second.name).toBe("Coding copy 2");
	});

	it("honors an explicit requested name", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding");

		const duplicate = db.duplicateEnvironment(source.id, "My custom copy");

		expect(duplicate.name).toBe("My custom copy");
	});

	it("copies the full config document (WP-1.1)", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding", { accent: "#7d53de" });
		db.setEnvironmentConfig(source.id, {
			appearance: { theme: "dark" },
			ai: { defaultProvider: "anthropic", systemPrompt: "Be concise." },
			integrations: { calendar: true },
			startupBehaviour: { autoStartSession: true, launchApps: ["code ."] },
		});

		const duplicate = db.duplicateEnvironment(source.id);
		const duplicateConfig = db.getEnvironmentConfig(duplicate.id);

		expect(duplicateConfig.appearance).toEqual({ accent: "#7d53de", theme: "dark" });
		expect(duplicateConfig.ai).toEqual({ defaultProvider: "anthropic", systemPrompt: "Be concise." });
		expect(duplicateConfig.integrations).toEqual({ calendar: true });
		expect(duplicateConfig.startupBehaviour).toEqual({ autoStartSession: true, launchApps: ["code ."] });
	});

	it("forks the source's own Notch layout into a new, independent row rather than sharing it", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding");
		db.setEnvironmentNotchLayout(source.id, { position: "left" });

		const duplicate = db.duplicateEnvironment(source.id);
		const duplicateConfig = db.getEnvironmentConfig(duplicate.id);

		expect(duplicateConfig.notchLayoutId).toBeTruthy();
		expect(duplicateConfig.notchLayoutId).not.toBe(db.getEnvironmentConfig(source.id).notchLayoutId);
		expect(db.getEffectiveNotchPreferences(duplicate.id).preferences.position).toBe("left");

		// Editing the duplicate's layout must never touch the source's.
		db.setEnvironmentNotchLayout(duplicate.id, { position: "right" });
		expect(db.getEffectiveNotchPreferences(source.id).preferences.position).toBe("left");
	});

	it("leaves notchLayoutId null (shared global default) when the source never had its own override", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding");

		const duplicate = db.duplicateEnvironment(source.id);

		expect(db.getEnvironmentConfig(duplicate.id).notchLayoutId).toBeNull();
	});

	it("copies NO content -- zero tasks, notes, sessions, activity blocks, or events on the duplicate", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const source = db.createEnvironment("Coding");
		db.createTask(source.id, "Task 1");
		db.createTask(source.id, "Task 2");
		const session = db.startSession(source.id);
		db.createActivityBlock(session.id, "code.exe", new Date().toISOString());
		db.stopSession(session.id);
		db.updateNotebookByEnvironment(
			source.id,
			JSON.stringify({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "a" }] }),
		);

		const duplicate = db.duplicateEnvironment(source.id);
		const counts = db.getEnvironmentContentCounts(duplicate.id);

		expect(counts).toEqual({
			tasks: 0,
			sessions: 0,
			notes: 0,
			activityBlocks: 0,
			events: 0,
			hasCustomNotchLayout: false,
		});
		// The source's own content is untouched by duplicating it.
		expect(db.getEnvironmentContentCounts(source.id).tasks).toBe(2);
	});

	it("throws when duplicating an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.duplicateEnvironment("nonexistent-id")).toThrow(/not found/i);
	});
});

describe("AtlasDatabase — environment configuration (WP-1.1)", () => {
	it("returns null for a config lookup on an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(db.getEnvironmentConfig("nonexistent-id")).toBeNull();
	});

	it("seeds defaults from the environment's own accent for a brand-new environment with no config saved yet", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Study", { icon: "book", accent: "#10b981", preset: "school" });

		const config = db.getEnvironmentConfig(environment.id);

		expect(config.version).toBe(1);
		expect(config.appearance).toEqual({ accent: "#10b981", theme: "system" });
		expect(config.notchLayoutId).toBeNull();
		expect(config.ai).toEqual({ defaultProvider: null, systemPrompt: "" });
		expect(config.integrations).toEqual({});
		expect(config.startupBehaviour).toEqual({ autoStartSession: false, launchApps: [] });
	});

	it("does not invent an accent for an environment that never had one", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Deep Work");

		expect(db.getEnvironmentConfig(environment.id).appearance.accent).toBeNull();
	});

	it("throws when setting config on an environment that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.setEnvironmentConfig("nonexistent-id", { notchLayoutId: "layout-1" })).toThrow(/not found/i);
	});

	it("persists a partial patch and returns the fully-resolved config", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Coding", { accent: "#7d53de" });

		const updated = db.setEnvironmentConfig(environment.id, {
			notchLayoutId: "layout-42",
			ai: { defaultProvider: "anthropic", systemPrompt: "Be concise." },
		});

		expect(updated.notchLayoutId).toBe("layout-42");
		expect(updated.ai).toEqual({ defaultProvider: "anthropic", systemPrompt: "Be concise." });
		// Untouched by the patch, and not reset by it.
		expect(updated.appearance.accent).toBe("#7d53de");

		expect(db.getEnvironmentConfig(environment.id)).toEqual(updated);
	});

	it("round-trips a full config through setEnvironmentConfig/getEnvironmentConfig and across a reopen", async () => {
		const dbPath = createTempDbPath();
		const original = await AtlasDatabase.create(dbPath);
		const environment = original.createEnvironment("Full config env", { accent: "#3b82f6" });

		const fullPatch = {
			appearance: { accent: "#f43f5e", theme: "dark" },
			notchLayoutId: "layout-9",
			ai: { defaultProvider: "google", systemPrompt: "Answer briefly." },
			integrations: { calendar: true, email: false },
			startupBehaviour: { autoStartSession: true, launchApps: ["code .", "notepad.exe"] },
		};
		original.setEnvironmentConfig(environment.id, fullPatch);

		const reopened = await AtlasDatabase.create(dbPath);
		const config = reopened.getEnvironmentConfig(environment.id);

		expect(config).toEqual({
			version: 1,
			appearance: { accent: "#f43f5e", theme: "dark" },
			notchLayoutId: "layout-9",
			ai: { defaultProvider: "google", systemPrompt: "Answer briefly." },
			integrations: { calendar: true, email: false },
			startupBehaviour: { autoStartSession: true, launchApps: ["code .", "notepad.exe"] },
		});
	});

	it("never resets icon/accent/preset on the environment row itself -- config is additive, not a replacement", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Writing", { icon: "pencil-square", accent: "#0ea5e9", preset: "writing" });

		db.setEnvironmentConfig(environment.id, { appearance: { theme: "dark" } });

		expect(db.getEnvironment(environment.id)).toMatchObject({
			icon: "pencil-square",
			accent: "#0ea5e9",
			preset: "writing",
		});
	});
});

describe("AtlasDatabase — session lifecycle", () => {
	it("starts a session for an environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const session = db.startSession(environment.id);

		expect(session.environment_id).toBe(environment.id);
		expect(session.is_active).toBe(1);
		expect(session.is_paused).toBe(0);
		expect(session.ended_at).toBeFalsy();
		expect(db.getActiveSession().id).toBe(session.id);
	});

	it("throws when starting a session for a nonexistent environment", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.startSession("missing-environment")).toThrow(/environment not found/i);
	});

	it("throws when a session is already active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		db.startSession(environment.id);

		expect(() => db.startSession(environment.id)).toThrow(/already active/i);
	});

	it("pauses an active session and records a pause entry", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);

		const paused = db.pauseSession(session.id);

		expect(paused.is_paused).toBe(1);
		expect(paused.pause_started_at).toBeTruthy();
		expect(db.all("SELECT * FROM pauses WHERE session_id = ?", [session.id])).toHaveLength(1);
	});

	it("is idempotent when pausing an already-paused session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		db.pauseSession(session.id);

		db.pauseSession(session.id);

		expect(db.all("SELECT * FROM pauses WHERE session_id = ?", [session.id])).toHaveLength(1);
	});

	it("throws when pausing a session that isn't active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.pauseSession("missing-session")).toThrow(/no active session/i);
	});

	it("is a no-op to resume a session that isn't paused", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);

		const resumed = db.resumeSession(session.id);

		expect(resumed.is_paused).toBe(0);
		expect(resumed.paused_duration).toBe(0);
	});

	it("throws when resuming a session that isn't active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.resumeSession("missing-session")).toThrow(/no active session/i);
	});

	it("computes total_duration as elapsed time minus paused time", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);

		// Backdate the session start by 10s so elapsed time is deterministic
		// instead of racing the wall clock during the test run.
		const startedAt = new Date(Date.now() - 10_000).toISOString();
		db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [startedAt, session.id]);

		db.pauseSession(session.id);
		// Backdate the pause start by 4s so the paused window is deterministic too.
		const pauseStartedAt = new Date(Date.now() - 4_000).toISOString();
		db.run("UPDATE sessions SET pause_started_at = ? WHERE id = ?", [pauseStartedAt, session.id]);

		const resumed = db.resumeSession(session.id);
		expect(resumed.is_paused).toBe(0);
		expect(resumed.paused_duration).toBeGreaterThanOrEqual(3_800);
		expect(resumed.paused_duration).toBeLessThanOrEqual(4_800);

		const stopped = db.stopSession(session.id);
		expect(stopped.is_active).toBe(0);
		// ~10s elapsed minus ~4s paused leaves ~6s of active duration.
		expect(stopped.total_duration).toBeGreaterThanOrEqual(5_200);
		expect(stopped.total_duration).toBeLessThanOrEqual(6_800);
	});

	it("closes a trailing pause when a session is stopped while still paused", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		db.pauseSession(session.id);

		const stopped = db.stopSession(session.id);

		expect(stopped.is_active).toBe(0);
		expect(stopped.is_paused).toBe(0);
		expect(stopped.pause_started_at).toBeFalsy();
		const pauses = db.all("SELECT * FROM pauses WHERE session_id = ?", [session.id]);
		expect(pauses[0].ended_at).toBeTruthy();
	});

	it("is idempotent when stopping an already-stopped session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		const stopped = db.stopSession(session.id);

		const stoppedAgain = db.stopSession(session.id);

		expect(stoppedAgain).toEqual(stopped);
	});

	it("throws when stopping a session that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.stopSession("missing-session")).toThrow(/no active session/i);
	});

	it("lists sessions for an environment, most recently created first", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const first = db.startSession(environment.id);
		db.stopSession(first.id);
		const second = db.startSession(environment.id);
		db.stopSession(second.id);
		db.run("UPDATE sessions SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE sessions SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const sessions = db.listSessionsByEnvironment(environment.id);
		expect(sessions.map((s) => s.id)).toEqual([second.id, first.id]);
	});

	it("deletes a stopped session along with its pauses and activity blocks", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		db.createActivityBlock(session.id, "Editor", new Date().toISOString());
		db.stopSession(session.id);

		expect(db.deleteSession(session.id)).toBe(true);

		expect(db.getSessionById(session.id)).toBeNull();
		expect(db.listActivityBlocksBySession(session.id)).toEqual([]);
	});

	it("throws when deleting an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);

		expect(() => db.deleteSession(session.id)).toThrow(/cannot delete an active session/i);
	});
});

describe("AtlasDatabase — activity blocks", () => {
	it("creates an activity block for an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);

		const block = db.createActivityBlock(session.id, "VS Code", new Date().toISOString());

		expect(block).not.toBeNull();
		expect(db.getOpenActivityBlock(session.id).id).toBe(block.id);
	});

	it("returns null when creating a block for a session that is not active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		db.stopSession(session.id);

		const block = db.createActivityBlock(session.id, "VS Code", new Date().toISOString());

		expect(block).toBeNull();
	});

	it("closes the open activity block when the session stops", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const session = db.startSession(environment.id);
		db.createActivityBlock(session.id, "VS Code", new Date().toISOString());

		db.stopSession(session.id);

		expect(db.getOpenActivityBlock(session.id)).toBeNull();
		const blocks = db.listActivityBlocksBySession(session.id);
		expect(blocks[0].ended_at).toBeTruthy();
	});
});

describe("AtlasDatabase — task CRUD", () => {
	it("creates a task with sensible defaults", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const task = db.createTask(environment.id, "Write tests");

		expect(task.status).toBe("todo");
		expect(task.priority).toBe("none");
		expect(task.tags).toEqual([]);
		expect(task.due_date).toBeNull();
	});

	it("round-trips tags through JSON storage as a real array", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const created = db.createTask(environment.id, "Ship it", "", { tags: ["urgent", "backend"] });
		expect(created.tags).toEqual(["urgent", "backend"]);

		// The column itself stores a JSON string, not a native array.
		const raw = db.first("SELECT tags FROM tasks WHERE id = ?", [created.id]);
		expect(typeof raw.tags).toBe("string");
		expect(JSON.parse(raw.tags)).toEqual(["urgent", "backend"]);

		const [listed] = db.listTasksByEnvironment(environment.id);
		expect(listed.tags).toEqual(["urgent", "backend"]);
	});

	it("filters out non-string tags on create", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const task = db.createTask(environment.id, "Odd tags", "", { tags: ["ok", 42, null, "fine"] });

		expect(task.tags).toEqual(["ok", "fine"]);
	});

	it("normalizes a missing priority to none", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const task = db.createTask(environment.id, "No priority given");

		expect(task.priority).toBe("none");
	});

	it("normalizes an invalid priority to none", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const task = db.createTask(environment.id, "Bogus priority", "", { priority: "extremely-critical" });

		expect(task.priority).toBe("none");
	});

	it("accepts a valid priority", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const task = db.createTask(environment.id, "Important", "", { priority: "urgent" });

		expect(task.priority).toBe("urgent");
	});

	it("updates task status via updateTaskStatus", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const task = db.createTask(environment.id, "Do it");

		const updated = db.updateTaskStatus(task.id, "done");

		expect(updated.status).toBe("done");
	});

	it("updates arbitrary fields via updateTask, including a tags round trip", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const task = db.createTask(environment.id, "Do it");

		const updated = db.updateTask(task.id, {
			title: "Do it now",
			priority: "high",
			tags: ["a", "b"],
			due_date: "2026-08-01",
		});

		expect(updated.title).toBe("Do it now");
		expect(updated.priority).toBe("high");
		expect(updated.tags).toEqual(["a", "b"]);
		expect(updated.due_date).toBe("2026-08-01");
	});

	it("normalizes an invalid priority to none on update", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const task = db.createTask(environment.id, "Do it", "", { priority: "high" });

		const updated = db.updateTask(task.id, { priority: "not-a-real-priority" });

		expect(updated.priority).toBe("none");
	});

	it("deletes a task", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const task = db.createTask(environment.id, "Temp task");

		expect(db.deleteTask(task.id)).toBe(true);
		expect(db.listTasksByEnvironment(environment.id)).toEqual([]);
	});

	it("lists tasks for an environment, most recently created first", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const first = db.createTask(environment.id, "First");
		const second = db.createTask(environment.id, "Second");
		db.run("UPDATE tasks SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE tasks SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const tasks = db.listTasksByEnvironment(environment.id);
		expect(tasks.map((t) => t.id)).toEqual([second.id, first.id]);
	});
});

describe("AtlasDatabase — note CRUD", () => {
	it("creates a note with an empty notebook document when no content is given", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const note = db.createNote(environment.id);

		expect(note.environment_id).toBe(environment.id);
		const parsed = JSON.parse(note.content);
		expect(parsed).toMatchObject({ version: 1, nodes: [] });
	});

	it("creates a note with explicit content", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const note = db.createNote(environment.id, "hello world");

		expect(note.content).toBe("hello world");
	});

	it("throws when creating a note without an environment id", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.createNote(null, "x")).toThrow(/environment id is required/i);
	});

	it("reuses the existing note for an environment instead of creating a second row", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const first = db.createNote(environment.id, "first content");

		const second = db.createNote(environment.id, "second content");

		expect(second.id).toBe(first.id);
		expect(second.content).toBe("second content");
		expect(db.all("SELECT * FROM notes WHERE environment_id = ?", [environment.id])).toHaveLength(1);
	});

	it("updates a note's content", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const note = db.createNote(environment.id, "original");

		const updated = db.updateNote(note.id, "changed");

		expect(updated.content).toBe("changed");
	});

	it("deletes a note", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		const note = db.createNote(environment.id, "temp");

		db.deleteNote(note.id);

		expect(db.all("SELECT * FROM notes WHERE id = ?", [note.id])).toEqual([]);
	});

	it("getNotebookByEnvironment creates a notebook on first access and returns the same one after", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");

		const created = db.getNotebookByEnvironment(environment.id);
		const fetchedAgain = db.getNotebookByEnvironment(environment.id);

		expect(fetchedAgain.id).toBe(created.id);
	});

	it("updateNotebookByEnvironment updates the environment's single notebook", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		db.getNotebookByEnvironment(environment.id);

		const updated = db.updateNotebookByEnvironment(environment.id, "notebook content");

		expect(updated.content).toBe("notebook content");
	});

	it("listNotesByEnvironment returns the single notebook for an environment, and an empty array with no environment id", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const environment = db.createEnvironment("Work");
		db.createNote(environment.id, "content");

		expect(db.listNotesByEnvironment(environment.id)).toHaveLength(1);
		expect(db.listNotesByEnvironment(null)).toEqual([]);
	});
});

describe("AtlasDatabase — persistence across reopen", () => {
	it("persists environments, tasks, and notes across reopening the same file", async () => {
		const dbPath = createTempDbPath();
		const original = await AtlasDatabase.create(dbPath);

		const environment = original.createEnvironment("Durable", { icon: "book" });
		const task = original.createTask(environment.id, "Persisted task", "", { priority: "high", tags: ["x"] });
		original.createNote(environment.id, "persisted content");

		const reopened = await AtlasDatabase.create(dbPath);

		expect(reopened.getEnvironment(environment.id)).toMatchObject({ name: "Durable", icon: "book" });
		const [reopenedTask] = reopened.listTasksByEnvironment(environment.id);
		expect(reopenedTask).toMatchObject({ id: task.id, title: "Persisted task", priority: "high", tags: ["x"] });
		expect(reopened.getNotebookByEnvironment(environment.id).content).toBe("persisted content");
	});

	it("persists a session's final state after stopping", async () => {
		const dbPath = createTempDbPath();
		const original = await AtlasDatabase.create(dbPath);
		const environment = original.createEnvironment("Durable");
		const session = original.startSession(environment.id);
		original.stopSession(session.id);

		const reopened = await AtlasDatabase.create(dbPath);

		expect(reopened.getSessionById(session.id)).toMatchObject({ is_active: 0 });
	});
});
