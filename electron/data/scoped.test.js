import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../db.cjs";
import { scoped } from "./scoped.cjs";

// ---------------------------------------------------------------------------
// The scoped accessor (WP-0.8) -- this is the leak-proof test suite the WP
// asks for, expressed as vitest assertions rather than a throwaway script:
// for every domain (tasks, notes, sessions, activity, events) and every
// method exposed on a bound scope, prove an enclosed environment's rows are
// unreachable from any other environment's scope, prove a connected
// environment only ever gets the one allowlisted derived signal cross-
// environment (never raw rows), and prove flipping a mode takes effect
// immediately with no restart.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-scoped-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

// Seeds one task, one note, one completed session (with one activity block)
// and one event inside `environmentId`, and returns their ids for later
// leak-attempt assertions. `label` makes each environment's content
// distinguishable from every other seeded environment's, so a cross-
// environment leak test can assert on more than just emptiness.
function seedEnvironmentData(db, environmentId, label = "Secret") {
	const task = db.createTask(environmentId, `${label} task title`, `${label} task body`);
	const note = db.createNote(environmentId, `${label} note content`);

	const session = db.startSession(environmentId);
	const block = db.createActivityBlock(session.id, `${label}App.exe`, session.started_at);
	db.closeOpenActivityBlock(session.id, new Date(new Date(session.started_at).getTime() + 60000).toISOString());
	db.stopSession(session.id);

	db.run(`INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, ?)`, [
		new Date().toISOString(),
		environmentId,
		"task.create",
		task.id,
		null,
		session.id,
	]);

	return { task, note, session, block };
}

describe("scoped() -- own-environment access is unaffected", () => {
	it("a connected environment's own scope can list, read, and mutate its own rows exactly as before", async () => {
		const db = await createDb();
		const env = db.createEnvironment("Mine");
		const seeded = seedEnvironmentData(db, env.id);
		const scope = scoped(db, env.id);

		expect(scope.tasks.list().map((t) => t.id)).toEqual([seeded.task.id]);
		expect(scope.tasks.get(seeded.task.id)?.id).toBe(seeded.task.id);
		expect(scope.tasks.updateStatus(seeded.task.id, "done")?.status).toBe("done");

		expect(scope.notes.list()).toHaveLength(1);
		expect(scope.notes.update(seeded.note.id, "edited")?.content).toBe("edited");

		expect(scope.sessions.list().map((s) => s.id)).toEqual([seeded.session.id]);
		expect(scope.sessions.get(seeded.session.id)?.id).toBe(seeded.session.id);
		expect(scope.sessions.listActivityBlocks(seeded.session.id)).toHaveLength(1);

		expect(scope.events.query().map((e) => e.subject)).toEqual([seeded.task.id]);

		// And the delete paths actually work for legitimate, in-scope ids.
		expect(scope.tasks.delete(seeded.task.id)).toBe(true);
		expect(scope.sessions.delete(seeded.session.id)).toBe(true);
	});

	it("requires a truthy environment id -- refuses to build an unscoped accessor", async () => {
		const db = await createDb();
		expect(() => scoped(db, null)).toThrow();
		expect(() => scoped(db, undefined)).toThrow();
		expect(() => scoped(db, "")).toThrow();
	});
});

describe("scoped() -- an enclosed environment is unreachable from another environment, through every code path", () => {
	async function setupEnclosedAndOutsider() {
		const db = await createDb();
		const enclosed = db.createEnvironment("Client Project");
		db.setEnvironmentIsolationMode(enclosed.id, "enclosed");
		const seeded = seedEnvironmentData(db, enclosed.id);

		const outsider = db.createEnvironment("Personal");
		const outsiderScope = scoped(db, outsider.id);

		return { db, enclosed, outsider, outsiderScope, seeded };
	}

	it("tasks: list/get/updateStatus/update/delete all fail closed", async () => {
		const { outsiderScope, seeded } = await setupEnclosedAndOutsider();

		expect(outsiderScope.tasks.list()).toEqual([]);
		expect(outsiderScope.tasks.get(seeded.task.id)).toBeNull();
		expect(outsiderScope.tasks.updateStatus(seeded.task.id, "done")).toBeNull();
		expect(outsiderScope.tasks.update(seeded.task.id, { title: "hacked" })).toBeNull();
		expect(outsiderScope.tasks.delete(seeded.task.id)).toBe(false);
	});

	it("tasks: a denied mutation never actually touches the row", async () => {
		const { db, outsiderScope, seeded } = await setupEnclosedAndOutsider();

		outsiderScope.tasks.updateStatus(seeded.task.id, "done");
		outsiderScope.tasks.update(seeded.task.id, { title: "hacked" });
		outsiderScope.tasks.delete(seeded.task.id);

		const stillThere = db.getTaskById(seeded.task.id);
		expect(stillThere).not.toBeNull();
		expect(stillThere.title).toBe("Secret task title");
		expect(stillThere.status).not.toBe("done");
	});

	it("notes: list/update/delete all fail closed, and content is never touched", async () => {
		const { db, outsiderScope, seeded } = await setupEnclosedAndOutsider();

		// notes.list() auto-provisions the CALLER's own (empty) notebook if it
		// doesn't have one yet (see db.cjs#getNotebookByEnvironment) -- that is
		// the outsider's own data, not a leak, so the real assertion is that
		// the enclosed environment's note id/content is absent, not that the
		// list is empty.
		const listedIds = outsiderScope.notes.list().map((n) => n.id);
		expect(listedIds).not.toContain(seeded.note.id);
		expect(JSON.stringify(outsiderScope.notes.list())).not.toContain("Secret note content");

		expect(outsiderScope.notes.update(seeded.note.id, "hacked")).toBeNull();
		outsiderScope.notes.delete(seeded.note.id);

		const stillThere = db.getNoteById(seeded.note.id);
		expect(stillThere).not.toBeNull();
		expect(stillThere.content).toBe("Secret note content");
	});

	it("sessions: list/get/pause/resume/stop/delete/listActivityBlocks all fail closed", async () => {
		const { db, enclosed, outsiderScope } = await setupEnclosedAndOutsider();
		// A live (not-yet-stopped) session this time, so pause/resume/stop are
		// meaningfully exercised rather than hitting the already-stopped case.
		const liveSession = db.startSession(enclosed.id);

		expect(outsiderScope.sessions.list()).toEqual([]);
		expect(outsiderScope.sessions.get(liveSession.id)).toBeNull();
		expect(() => outsiderScope.sessions.pause(liveSession.id)).toThrow(/no active session/i);
		expect(() => outsiderScope.sessions.resume(liveSession.id)).toThrow(/no active session/i);
		expect(() => outsiderScope.sessions.stop(liveSession.id)).toThrow(/no active session/i);
		expect(() => outsiderScope.sessions.delete(liveSession.id)).toThrow(/session not found/i);
		expect(outsiderScope.sessions.listActivityBlocks(liveSession.id)).toEqual([]);

		// None of those attempts actually changed the enclosed session's state.
		const stillActive = db.getSessionById(liveSession.id);
		expect(stillActive.is_active).toBe(1);
		expect(stillActive.is_paused).toBe(0);
	});

	it("activity blocks: unreachable via the session they belong to", async () => {
		const { outsiderScope, seeded } = await setupEnclosedAndOutsider();
		expect(outsiderScope.sessions.listActivityBlocks(seeded.session.id)).toEqual([]);
	});

	it("events: query() never returns the enclosed environment's events", async () => {
		const { outsiderScope } = await setupEnclosedAndOutsider();
		expect(outsiderScope.events.query()).toEqual([]);
	});

	it("dashboardOverview: the enclosed environment's time never appears in another environment's breakdown", async () => {
		const { outsiderScope, enclosed } = await setupEnclosedAndOutsider();
		const overview = outsiderScope.dashboardOverview();
		const names = overview.timePerEnvironment.map((row) => row.environmentName);
		expect(names).not.toContain(enclosed.name);
	});

	it("dashboardOverview: the enclosed environment itself sees nothing global, only its own row", async () => {
		const { db, enclosed, outsider } = await setupEnclosedAndOutsider();
		// Give the outsider (connected) environment some time today too, so
		// there's something global to wrongly leak if the gate were broken.
		const outsiderSession = db.startSession(outsider.id);
		db.stopSession(outsiderSession.id);

		const enclosedScope = scoped(db, enclosed.id);
		const overview = enclosedScope.dashboardOverview();
		const names = overview.timePerEnvironment.map((row) => row.environmentName);

		expect(names).not.toContain(outsider.name);
		// Its own row (if present at all) is the only thing that may appear.
		expect(names.every((name) => name === enclosed.name)).toBe(true);
	});

	it("forTask/forNote/forSession resolve scope from the row's OWN environment, not the caller's -- and still deny an outsider by construction", async () => {
		const { db, enclosed, seeded } = await setupEnclosedAndOutsider();

		// Calling scoped.forTask with an enclosed environment's task id yields
		// a scope bound to the enclosed environment (its only meaningful
		// scope) -- not a backdoor for some other caller to widen access.
		const taskScope = scoped.forTask(db, seeded.task.id);
		expect(taskScope.environmentId).toBe(enclosed.id);

		const noteScope = scoped.forNote(db, seeded.note.id);
		expect(noteScope.environmentId).toBe(enclosed.id);

		const sessionScope = scoped.forSession(db, seeded.session.id);
		expect(sessionScope.environmentId).toBe(enclosed.id);

		// And resolving against a bogus id fails closed (null), matching the
		// existing "not found" shape rather than throwing into a caller that
		// isn't expecting it.
		expect(scoped.forTask(db, "no-such-task")).toBeNull();
		expect(scoped.forNote(db, "no-such-note")).toBeNull();
		expect(scoped.forSession(db, "no-such-session")).toBeNull();
	});
});

describe("scoped() -- a connected environment reads only the allowlisted signal, and nothing else, cross-environment", () => {
	it("dashboardOverview includes another CONNECTED environment's aggregate time, but no other cross-environment data leaks through any accessor", async () => {
		const db = await createDb();
		const mine = db.createEnvironment("Mine");
		const theirs = db.createEnvironment("Theirs"); // also connected (the default)
		seedEnvironmentData(db, mine.id, "Mine");
		const theirSeed = seedEnvironmentData(db, theirs.id, "Theirs");

		const myScope = scoped(db, mine.id);

		// Allowed: the one derived, aggregate signal.
		const overview = myScope.dashboardOverview();
		const theirRow = overview.timePerEnvironment.find((row) => row.environmentName === theirs.name);
		expect(theirRow).toBeDefined();
		expect(typeof theirRow.duration).toBe("number");

		// Not allowed, and not exposed by any method on this scope: their raw
		// tasks, notes, sessions, or events. `myScope` legitimately sees ITS
		// OWN rows (seeded above too) -- the leak to rule out is "theirs"
		// showing up in any of these lists, not that the lists are empty.
		expect(myScope.tasks.list().map((t) => t.id)).not.toContain(theirSeed.task.id);
		expect(myScope.notes.list().map((n) => n.id)).not.toContain(theirSeed.note.id);
		expect(myScope.sessions.list().map((s) => s.id)).not.toContain(theirSeed.session.id);
		expect(myScope.events.query().map((e) => e.subject)).not.toContain(theirSeed.task.id);
		expect(myScope.tasks.get(theirSeed.task.id)).toBeNull();
		expect(myScope.sessions.listActivityBlocks(theirSeed.session.id)).toEqual([]);

		// And the aggregate itself carries only a name and a number -- never
		// their task title, note content, or anything else recognizable as
		// content. (Belt and braces: the seed data uses distinctive strings so
		// an accidental leak into the JSON blob would show up here.)
		const serialized = JSON.stringify(overview);
		expect(serialized).not.toContain("Theirs task title");
		expect(serialized).not.toContain("Theirs note content");
		expect(serialized).not.toContain("TheirsApp.exe");
	});

	it("logs the cross-environment read: to the console always, and to an injected event log when one is provided", async () => {
		const db = await createDb();
		const mine = db.createEnvironment("Mine");
		const theirs = db.createEnvironment("Theirs");
		seedEnvironmentData(db, mine.id);
		seedEnvironmentData(db, theirs.id);

		const eventLog = { record: vi.fn() };
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		scoped(db, mine.id, { eventLog }).dashboardOverview();

		expect(eventLog.record).toHaveBeenCalledWith(
			"data.cross_environment_read",
			expect.objectContaining({ environmentId: mine.id, subject: "environment_time_totals" }),
		);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cross-environment read"));

		consoleSpy.mockRestore();
	});

	it("never throws when no event log is supplied", async () => {
		const db = await createDb();
		const mine = db.createEnvironment("Mine");
		db.createEnvironment("Theirs");
		expect(() => scoped(db, mine.id).dashboardOverview()).not.toThrow();
	});
});

describe("scoped() -- switching an environment to enclosed immediately stops cross-environment reads", () => {
	it("no restart or reconnect needed -- the very next call reflects the new mode", async () => {
		const db = await createDb();
		const mine = db.createEnvironment("Mine");
		const other = db.createEnvironment("Other"); // starts connected (the default)
		seedEnvironmentData(db, mine.id);
		seedEnvironmentData(db, other.id);

		const myScope = scoped(db, mine.id);

		// Before: "other" is connected, so its aggregate time is visible.
		const before = myScope.dashboardOverview();
		expect(before.timePerEnvironment.map((r) => r.environmentName)).toContain(other.name);

		// Flip it.
		db.setEnvironmentIsolationMode(other.id, "enclosed");

		// After, same db connection, same scope object, no re-creation: gone.
		const after = myScope.dashboardOverview();
		expect(after.timePerEnvironment.map((r) => r.environmentName)).not.toContain(other.name);
	});
});

describe("scoped() -- existing data defaults to connected with no behaviour change", () => {
	it("an environment created the normal way (no isolation_mode argument) is connected, and its cross-environment aggregate is visible exactly as before WP-0.8", async () => {
		const db = await createDb();
		const legacyLookingEnv = db.createEnvironment("Existing User's Environment");
		const other = db.createEnvironment("Other");
		expect(db.getEnvironmentIsolationMode(legacyLookingEnv.id)).toBe("connected");

		const session = db.startSession(legacyLookingEnv.id);
		db.stopSession(session.id);

		const otherScope = scoped(db, other.id);
		const overview = otherScope.dashboardOverview();
		expect(overview.timePerEnvironment.map((r) => r.environmentName)).toContain(legacyLookingEnv.name);
	});
});
