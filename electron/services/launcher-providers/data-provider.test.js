import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createLauncherProviderRegistry } from "./index.cjs";
import { search, execute, parseLocalId } from "./data-provider.cjs";

// ---------------------------------------------------------------------------
// The "data" provider (WP-2.3). Uses a REAL AtlasDatabase (a real sqlite file
// in a temp dir, migrated exactly like a real boot), not a mock -- the whole
// point of these tests is proving the provider goes through
// electron/data/scoped.cjs (WP-0.8) for real, the same seam every IPC handler
// in electron/ipc/*.cjs is scoped through, rather than reimplementing (and
// potentially getting wrong) its own ad hoc filtering.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-data-provider-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function notebookDocument(nodeId, text) {
	return JSON.stringify({
		version: 1,
		viewport: { x: 0, y: 0, zoom: 1 },
		nodes: [{ id: nodeId, type: "postit", text }],
	});
}

// Two environments, each with a task, a note, and a session that use the SAME
// wording -- so a test that finds env B's content while searching env A can't
// be passed off as "different text just happened not to match".
async function seedTwoEnvironments() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const envA = db.createEnvironment("Environment A");
	const envB = db.createEnvironment("Environment B");

	db.createTask(envA.id, "Write quarterly report", "Draft the Q3 numbers");
	db.createTask(envB.id, "Write quarterly report", "Draft the Q3 numbers");

	db.updateNotebookByEnvironment(envA.id, notebookDocument("node-a", "Buy groceries for the trip"));
	db.updateNotebookByEnvironment(envB.id, notebookDocument("node-b", "Buy groceries for the trip"));

	// Inserted directly (rather than through startSession/stopSession) because
	// only one session may be active app-wide at a time -- these tests only
	// need finished rows to search over, not the full lifecycle.
	db.run(
		`INSERT INTO sessions (id, environment_id, started_at, created_at, is_active, is_paused, paused_duration, total_duration)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
		["session-a", envA.id, "2026-01-01T09:00:00.000Z", "2026-01-01T09:00:00.000Z", 3_600_000],
	);
	db.run(
		`INSERT INTO sessions (id, environment_id, started_at, created_at, is_active, is_paused, paused_duration, total_duration)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
		["session-b", envB.id, "2026-01-02T09:00:00.000Z", "2026-01-02T09:00:00.000Z", 1_800_000],
	);

	return { db, envA, envB };
}

function contextFor(db, environmentId) {
	return { getDb: () => db, environmentId, now: Date.now() };
}

describe("data-provider search() -- entity coverage", () => {
	it("finds a matching task in the active environment", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const [taskRow] = db.listTasksByEnvironment(envA.id);
		const results = search("quarterly", contextFor(db, envA.id));
		expect(results.some((r) => r.kind === "task" && r.id === `task:${envA.id}:${taskRow.id}`)).toBe(true);
	});

	it("finds a matching note node in the active environment", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const results = search("groceries", contextFor(db, envA.id));
		const note = results.find((r) => r.kind === "note");
		expect(note).toBeDefined();
		expect(note.id).toBe(`note:${envA.id}:node-a`);
		expect(note.title).toContain("groceries");
	});

	it("finds a matching session in the active environment (browsed via a blank query)", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const sessionResults = search("", contextFor(db, envA.id)).filter((r) => r.kind === "session");
		expect(sessionResults).toHaveLength(1);
		expect(sessionResults[0].id).toBe(`session:${envA.id}:session-a`);
		expect(sessionResults[0].subtitle).toBe("Duration 1h 0m");
	});

	it("finds an environment by name regardless of which environment is active", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		const results = search("Environment B", contextFor(db, envA.id));
		expect(results.some((r) => r.kind === "environment" && r.id === `environment:${envB.id}`)).toBe(true);
	});

	it("returns [] without throwing when getDb() reports no database", () => {
		expect(search("anything", { getDb: () => null, environmentId: "env-1" })).toEqual([]);
	});

	it("skips task/note/session entirely (but still searches environments) when environmentId is null", async () => {
		const { db } = await seedTwoEnvironments();
		const results = search("quarterly", contextFor(db, null));
		expect(results.some((r) => r.kind === "task" || r.kind === "note" || r.kind === "session")).toBe(false);
	});
});

describe("data-provider search() -- environment scoping (WP-0.8)", () => {
	it("never returns environment B's task while searching environment A", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		// Both environments seed a task with the IDENTICAL title on purpose: if
		// scoping ever leaked, environment B's row would match this same query
		// too and this length would silently become 2 -- the id's own stamped
		// environmentId can't catch that (it's this function's own parameter,
		// not read back off the row), so the count is the real signal.
		const results = search("quarterly report", contextFor(db, envA.id));
		const taskResults = results.filter((r) => r.kind === "task");
		expect(taskResults).toHaveLength(1);
		expect(taskResults[0].id.startsWith(`task:${envA.id}:`)).toBe(true);
		expect(taskResults.some((r) => r.id.includes(envB.id))).toBe(false);
	});

	it("never returns environment B's note node while searching environment A", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		const results = search("groceries", contextFor(db, envA.id));
		const noteResults = results.filter((r) => r.kind === "note");
		expect(noteResults).toEqual([{ id: `note:${envA.id}:node-a`, kind: "note", title: "Buy groceries for the trip", subtitle: "Sticky note" }]);
		expect(noteResults.some((r) => r.id.includes(envB.id))).toBe(false);
	});

	it("never returns environment B's session while searching environment A", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		// Blank query -> "browse" mode: every session in scope is a result, so a
		// leak here would surface as a second (env B's) session in the list.
		const results = search("", contextFor(db, envA.id));
		const sessionResults = results.filter((r) => r.kind === "session");
		expect(sessionResults).toHaveLength(1);
		expect(sessionResults[0].id).toBe(`session:${envA.id}:session-a`);
		expect(sessionResults.some((r) => r.id.includes(envB.id))).toBe(false);
	});

	it("the same query in environment B only ever returns environment B's own rows", async () => {
		const { db, envA, envB } = await seedTwoEnvironments();
		const results = search("quarterly report", contextFor(db, envB.id));
		const taskResults = results.filter((r) => r.kind === "task");
		expect(taskResults).toHaveLength(1);
		expect(taskResults[0].id.startsWith(`task:${envB.id}:`)).toBe(true);
		expect(taskResults.some((r) => r.id.includes(envA.id))).toBe(false);
	});
});

describe("data-provider execute() -- opening a result", () => {
	it("navigates to the tasks view for a task result already in the active environment", async () => {
		const navigate = vi.fn(() => true);
		const switchEnvironment = vi.fn();
		const outcome = await execute(
			{ id: "task:env-1:task-1", kind: "task", title: "Do it" },
			{ environmentId: "env-1", modifier: null },
			{ navigate, switchEnvironment },
		);
		expect(navigate).toHaveBeenCalledWith("tasks");
		expect(switchEnvironment).not.toHaveBeenCalled();
		expect(outcome).toEqual({ ok: true, title: "Do it" });
	});

	it("navigates to the notes view for a note result", async () => {
		const navigate = vi.fn(() => true);
		const outcome = await execute(
			{ id: "note:env-1:node-1", kind: "note", title: "Snippet" },
			{ environmentId: "env-1" },
			{ navigate, switchEnvironment: vi.fn() },
		);
		expect(navigate).toHaveBeenCalledWith("notes");
		expect(outcome.ok).toBe(true);
	});

	it("navigates to the activity view for a session result", async () => {
		const navigate = vi.fn(() => true);
		const outcome = await execute(
			{ id: "session:env-1:session-1", kind: "session", title: "Session" },
			{ environmentId: "env-1" },
			{ navigate, switchEnvironment: vi.fn() },
		);
		expect(navigate).toHaveBeenCalledWith("activity");
		expect(outcome.ok).toBe(true);
	});

	it("switches environment first when the result belongs to a DIFFERENT environment than the one currently active", async () => {
		const navigate = vi.fn(() => true);
		const switchEnvironment = vi.fn();
		await execute(
			{ id: "note:env-2:node-9", kind: "note", title: "Elsewhere" },
			{ environmentId: "env-1" },
			{ navigate, switchEnvironment },
		);
		expect(switchEnvironment).toHaveBeenCalledWith("env-2");
		expect(navigate).toHaveBeenCalledWith("notes");
	});

	it("does not switch environment when the result already belongs to the active one", async () => {
		const switchEnvironment = vi.fn();
		await execute(
			{ id: "task:env-1:task-1", kind: "task", title: "Here" },
			{ environmentId: "env-1" },
			{ navigate: vi.fn(() => true), switchEnvironment },
		);
		expect(switchEnvironment).not.toHaveBeenCalled();
	});

	it("switches environment and navigates to the dashboard for an environment result", async () => {
		const navigate = vi.fn(() => true);
		const switchEnvironment = vi.fn();
		const outcome = await execute(
			{ id: "environment:env-9", kind: "environment", title: "Env 9" },
			{ environmentId: "env-1" },
			{ navigate, switchEnvironment },
		);
		expect(switchEnvironment).toHaveBeenCalledWith("env-9");
		expect(navigate).toHaveBeenCalledWith("dashboard");
		expect(outcome).toEqual({ ok: true, title: "Env 9" });
	});

	it("reports ok:false without throwing for an unrecognized id", async () => {
		const outcome = await execute({ id: "not-a-real-id" }, {}, {});
		expect(outcome.ok).toBe(false);
	});

	it("reports ok:false without throwing when the action context is entirely unwired (registry defaults)", async () => {
		const outcome = await execute({ id: "task:env-1:task-1", title: "X" }, { environmentId: "env-1" }, {});
		expect(outcome.ok).toBe(false);
	});

	it("degrades to ok:false when navigate() itself reports no window was available", async () => {
		const outcome = await execute(
			{ id: "task:env-1:task-1", title: "X" },
			{ environmentId: "env-1" },
			{ navigate: () => false, switchEnvironment: vi.fn() },
		);
		expect(outcome.ok).toBe(false);
	});
});

describe("parseLocalId()", () => {
	it("parses every supported kind", () => {
		expect(parseLocalId("task:env-1:t1")).toEqual({ kind: "task", environmentId: "env-1", entityId: "t1" });
		expect(parseLocalId("note:env-1:n1")).toEqual({ kind: "note", environmentId: "env-1", entityId: "n1" });
		expect(parseLocalId("session:env-1:s1")).toEqual({ kind: "session", environmentId: "env-1", entityId: "s1" });
		expect(parseLocalId("environment:env-1")).toEqual({ kind: "environment", environmentId: "env-1" });
	});

	it("returns null for anything malformed", () => {
		expect(parseLocalId("garbage")).toBeNull();
		expect(parseLocalId("task:only-one-part")).toBeNull();
		expect(parseLocalId(123)).toBeNull();
		expect(parseLocalId(null)).toBeNull();
	});
});

describe("end-to-end through the registry (namespacing + routing, real db)", () => {
	it("searches, namespaces, and executes a task result through an isolated registry", async () => {
		const { db, envA } = await seedTwoEnvironments();
		const registry = createLauncherProviderRegistry();
		registry.registerProvider({ name: "data", search, execute });
		registry.init({ getDb: () => db });

		const results = await registry.search("quarterly", { environmentId: envA.id });
		const taskResult = results.find((r) => r.providerName === "data" && r.id.includes(":task:"));
		expect(taskResult).toBeDefined();
		expect(taskResult.id.startsWith("data::task:")).toBe(true);

		const navigate = vi.fn(() => true);
		registry.init({ getDb: () => db, navigate, switchEnvironment: vi.fn() });
		const outcome = await registry.execute(taskResult.id, { environmentId: envA.id, modifier: null });
		expect(outcome.ok).toBe(true);
		expect(navigate).toHaveBeenCalledWith("tasks");
	});
});
