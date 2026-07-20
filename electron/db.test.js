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

		for (const table of ["maps", "sessions", "pauses", "activity_blocks", "tasks", "notes"]) {
			expect(db.tableExists(table)).toBe(true);
		}
	});

	it("adds the incremental map and task columns", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		for (const column of ["icon", "accent", "preset"]) {
			expect(db.columnExists("maps", column)).toBe(true);
		}
		for (const column of ["priority", "tags", "due_date"]) {
			expect(db.columnExists("tasks", column)).toBe(true);
		}
	});

	it("running create twice on the same path does not error or duplicate columns", async () => {
		const dbPath = createTempDbPath();
		const first = await AtlasDatabase.create(dbPath);
		first.createMap("Existing map");

		const second = await AtlasDatabase.create(dbPath);

		const mapColumns = second.all("PRAGMA table_info(maps)");
		const taskColumns = second.all("PRAGMA table_info(tasks)");

		for (const column of ["icon", "accent", "preset"]) {
			expect(mapColumns.filter((c) => c.name === column)).toHaveLength(1);
		}
		for (const column of ["priority", "tags", "due_date"]) {
			expect(taskColumns.filter((c) => c.name === column)).toHaveLength(1);
		}

		// Re-initializing schema didn't touch data that was already there.
		expect(second.listMaps()).toHaveLength(1);
	});
});

describe("AtlasDatabase — environment (map) CRUD", () => {
	it("creates a map with null metadata by default", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const map = db.createMap("Deep Work");

		expect(map.name).toBe("Deep Work");
		expect(map.icon).toBeNull();
		expect(map.accent).toBeNull();
		expect(map.preset).toBeNull();
		expect(db.getMap(map.id)).toMatchObject({ id: map.id, name: "Deep Work" });
	});

	it("creates a map with icon/accent/preset metadata", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const map = db.createMap("Study", { icon: "book", accent: "#ff0000", preset: "school" });

		expect(db.getMap(map.id)).toMatchObject({
			name: "Study",
			icon: "book",
			accent: "#ff0000",
			preset: "school",
		});
	});

	it("lists maps ordered by creation time", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		const first = db.createMap("First");
		const second = db.createMap("Second");
		// created_at is millisecond-precision wall-clock time; pin explicit,
		// distinct values so ordering can't tie-break unpredictably on fast CI.
		db.run("UPDATE maps SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE maps SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const maps = db.listMaps();
		expect(maps.map((m) => m.id)).toEqual([first.id, second.id]);
	});

	it("renames a map", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Old name");

		const renamed = db.renameMap(map.id, "New name");

		expect(renamed.name).toBe("New name");
		expect(db.getMap(map.id).name).toBe("New name");
	});

	it("updates map icon/accent/preset via updateMap", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Focus");

		const updated = db.updateMap(map.id, { icon: "target", accent: "#00ff00", preset: "custom" });

		expect(updated).toMatchObject({ icon: "target", accent: "#00ff00", preset: "custom" });
	});

	it("ignores fields that aren't in the allowed list", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Focus", { icon: "target" });

		const updated = db.updateMap(map.id, { unrelatedField: "ignored" });

		expect(updated.icon).toBe("target");
	});

	it("deletes a map along with its tasks, notes, and sessions", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Temp");
		db.createTask(map.id, "A task");
		db.createNote(map.id, "Some content");
		const session = db.startSession(map.id);
		db.stopSession(session.id);

		expect(db.deleteMap(map.id)).toBe(true);

		expect(db.getMap(map.id)).toBeNull();
		expect(db.listTasksByMap(map.id)).toEqual([]);
		expect(db.listSessionsByMap(map.id)).toEqual([]);
	});

	it("throws when deleting a map that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.deleteMap("nonexistent-id")).toThrow(/not found/i);
	});

	it("throws when deleting a map with an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Active map");
		db.startSession(map.id);

		expect(() => db.deleteMap(map.id)).toThrow(/active session/i);
	});
});

describe("AtlasDatabase — session lifecycle", () => {
	it("starts a session for a map", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const session = db.startSession(map.id);

		expect(session.map_id).toBe(map.id);
		expect(session.is_active).toBe(1);
		expect(session.is_paused).toBe(0);
		expect(session.ended_at).toBeFalsy();
		expect(db.getActiveSession().id).toBe(session.id);
	});

	it("throws when starting a session for a nonexistent map", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.startSession("missing-map")).toThrow(/map not found/i);
	});

	it("throws when a session is already active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		db.startSession(map.id);

		expect(() => db.startSession(map.id)).toThrow(/already active/i);
	});

	it("pauses an active session and records a pause entry", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);

		const paused = db.pauseSession(session.id);

		expect(paused.is_paused).toBe(1);
		expect(paused.pause_started_at).toBeTruthy();
		expect(db.all("SELECT * FROM pauses WHERE session_id = ?", [session.id])).toHaveLength(1);
	});

	it("is idempotent when pausing an already-paused session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
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
		const map = db.createMap("Work");
		const session = db.startSession(map.id);

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
		const map = db.createMap("Work");
		const session = db.startSession(map.id);

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
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
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
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
		const stopped = db.stopSession(session.id);

		const stoppedAgain = db.stopSession(session.id);

		expect(stoppedAgain).toEqual(stopped);
	});

	it("throws when stopping a session that does not exist", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.stopSession("missing-session")).toThrow(/no active session/i);
	});

	it("lists sessions for a map, most recently created first", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const first = db.startSession(map.id);
		db.stopSession(first.id);
		const second = db.startSession(map.id);
		db.stopSession(second.id);
		db.run("UPDATE sessions SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE sessions SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const sessions = db.listSessionsByMap(map.id);
		expect(sessions.map((s) => s.id)).toEqual([second.id, first.id]);
	});

	it("deletes a stopped session along with its pauses and activity blocks", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
		db.createActivityBlock(session.id, "Editor", new Date().toISOString());
		db.stopSession(session.id);

		expect(db.deleteSession(session.id)).toBe(true);

		expect(db.getSessionById(session.id)).toBeNull();
		expect(db.listActivityBlocksBySession(session.id)).toEqual([]);
	});

	it("throws when deleting an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);

		expect(() => db.deleteSession(session.id)).toThrow(/cannot delete an active session/i);
	});
});

describe("AtlasDatabase — activity blocks", () => {
	it("creates an activity block for an active session", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);

		const block = db.createActivityBlock(session.id, "VS Code", new Date().toISOString());

		expect(block).not.toBeNull();
		expect(db.getOpenActivityBlock(session.id).id).toBe(block.id);
	});

	it("returns null when creating a block for a session that is not active", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
		db.stopSession(session.id);

		const block = db.createActivityBlock(session.id, "VS Code", new Date().toISOString());

		expect(block).toBeNull();
	});

	it("closes the open activity block when the session stops", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const session = db.startSession(map.id);
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
		const map = db.createMap("Work");

		const task = db.createTask(map.id, "Write tests");

		expect(task.status).toBe("todo");
		expect(task.priority).toBe("none");
		expect(task.tags).toEqual([]);
		expect(task.due_date).toBeNull();
	});

	it("round-trips tags through JSON storage as a real array", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const created = db.createTask(map.id, "Ship it", "", { tags: ["urgent", "backend"] });
		expect(created.tags).toEqual(["urgent", "backend"]);

		// The column itself stores a JSON string, not a native array.
		const raw = db.first("SELECT tags FROM tasks WHERE id = ?", [created.id]);
		expect(typeof raw.tags).toBe("string");
		expect(JSON.parse(raw.tags)).toEqual(["urgent", "backend"]);

		const [listed] = db.listTasksByMap(map.id);
		expect(listed.tags).toEqual(["urgent", "backend"]);
	});

	it("filters out non-string tags on create", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const task = db.createTask(map.id, "Odd tags", "", { tags: ["ok", 42, null, "fine"] });

		expect(task.tags).toEqual(["ok", "fine"]);
	});

	it("normalizes a missing priority to none", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const task = db.createTask(map.id, "No priority given");

		expect(task.priority).toBe("none");
	});

	it("normalizes an invalid priority to none", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const task = db.createTask(map.id, "Bogus priority", "", { priority: "extremely-critical" });

		expect(task.priority).toBe("none");
	});

	it("accepts a valid priority", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const task = db.createTask(map.id, "Important", "", { priority: "urgent" });

		expect(task.priority).toBe("urgent");
	});

	it("updates task status via updateTaskStatus", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const task = db.createTask(map.id, "Do it");

		const updated = db.updateTaskStatus(task.id, "done");

		expect(updated.status).toBe("done");
	});

	it("updates arbitrary fields via updateTask, including a tags round trip", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const task = db.createTask(map.id, "Do it");

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
		const map = db.createMap("Work");
		const task = db.createTask(map.id, "Do it", "", { priority: "high" });

		const updated = db.updateTask(task.id, { priority: "not-a-real-priority" });

		expect(updated.priority).toBe("none");
	});

	it("deletes a task", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const task = db.createTask(map.id, "Temp task");

		expect(db.deleteTask(task.id)).toBe(true);
		expect(db.listTasksByMap(map.id)).toEqual([]);
	});

	it("lists tasks for a map, most recently created first", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const first = db.createTask(map.id, "First");
		const second = db.createTask(map.id, "Second");
		db.run("UPDATE tasks SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", first.id]);
		db.run("UPDATE tasks SET created_at = ? WHERE id = ?", ["2020-01-02T00:00:00.000Z", second.id]);

		const tasks = db.listTasksByMap(map.id);
		expect(tasks.map((t) => t.id)).toEqual([second.id, first.id]);
	});
});

describe("AtlasDatabase — note CRUD", () => {
	it("creates a note with an empty notebook document when no content is given", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const note = db.createNote(map.id);

		expect(note.map_id).toBe(map.id);
		const parsed = JSON.parse(note.content);
		expect(parsed).toMatchObject({ version: 1, nodes: [] });
	});

	it("creates a note with explicit content", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const note = db.createNote(map.id, "hello world");

		expect(note.content).toBe("hello world");
	});

	it("throws when creating a note without a map id", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());

		expect(() => db.createNote(null, "x")).toThrow(/map id is required/i);
	});

	it("reuses the existing note for a map instead of creating a second row", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const first = db.createNote(map.id, "first content");

		const second = db.createNote(map.id, "second content");

		expect(second.id).toBe(first.id);
		expect(second.content).toBe("second content");
		expect(db.all("SELECT * FROM notes WHERE map_id = ?", [map.id])).toHaveLength(1);
	});

	it("updates a note's content", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const note = db.createNote(map.id, "original");

		const updated = db.updateNote(note.id, "changed");

		expect(updated.content).toBe("changed");
	});

	it("deletes a note", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		const note = db.createNote(map.id, "temp");

		db.deleteNote(note.id);

		expect(db.all("SELECT * FROM notes WHERE id = ?", [note.id])).toEqual([]);
	});

	it("getNotebookByMap creates a notebook on first access and returns the same one after", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");

		const created = db.getNotebookByMap(map.id);
		const fetchedAgain = db.getNotebookByMap(map.id);

		expect(fetchedAgain.id).toBe(created.id);
	});

	it("updateNotebookByMap updates the map's single notebook", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		db.getNotebookByMap(map.id);

		const updated = db.updateNotebookByMap(map.id, "notebook content");

		expect(updated.content).toBe("notebook content");
	});

	it("listNotesByMap returns the single notebook for a map, and an empty array with no map id", async () => {
		const db = await AtlasDatabase.create(createTempDbPath());
		const map = db.createMap("Work");
		db.createNote(map.id, "content");

		expect(db.listNotesByMap(map.id)).toHaveLength(1);
		expect(db.listNotesByMap(null)).toEqual([]);
	});
});

describe("AtlasDatabase — persistence across reopen", () => {
	it("persists maps, tasks, and notes across reopening the same file", async () => {
		const dbPath = createTempDbPath();
		const original = await AtlasDatabase.create(dbPath);

		const map = original.createMap("Durable", { icon: "book" });
		const task = original.createTask(map.id, "Persisted task", "", { priority: "high", tags: ["x"] });
		original.createNote(map.id, "persisted content");

		const reopened = await AtlasDatabase.create(dbPath);

		expect(reopened.getMap(map.id)).toMatchObject({ name: "Durable", icon: "book" });
		const [reopenedTask] = reopened.listTasksByMap(map.id);
		expect(reopenedTask).toMatchObject({ id: task.id, title: "Persisted task", priority: "high", tags: ["x"] });
		expect(reopened.getNotebookByMap(map.id).content).toBe("persisted content");
	});

	it("persists a session's final state after stopping", async () => {
		const dbPath = createTempDbPath();
		const original = await AtlasDatabase.create(dbPath);
		const map = original.createMap("Durable");
		const session = original.startSession(map.id);
		original.stopSession(session.id);

		const reopened = await AtlasDatabase.create(dbPath);

		expect(reopened.getSessionById(session.id)).toMatchObject({ is_active: 0 });
	});
});
