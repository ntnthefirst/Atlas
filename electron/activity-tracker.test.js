import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "./db.cjs";
import { ActivityTracker } from "./activity-tracker.cjs";

// This suite is ESM (the package is `type: module`) even though the modules
// under test are CommonJS -- same reasoning as db.test.js.

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-tracker-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Overrides the instance method rather than mocking child_process -- tick()
// calls `this.getForegroundAppInfo()`, so an own-property override on the
// instance shadows the prototype method the same way a real subclass would.
function stubForegroundApp(tracker, processName, label = processName) {
	tracker.getForegroundAppInfo = vi.fn().mockResolvedValue({ processName, label });
}

async function createSessionContext() {
	const db = await AtlasDatabase.create(createTempDbPath());
	const environment = db.createEnvironment("Test env");
	const session = db.startSession(environment.id);
	return { db, environment, session };
}

describe("ActivityTracker — app.focus event recording (WP-0.5)", () => {
	it("records the coarse process name as subject, never the title-preferring label", async () => {
		const { db, environment, session } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		tracker.setCurrentSession(session.id);
		// `label` here stands in for what a real window title would look like --
		// this must never reach the event log.
		stubForegroundApp(tracker, "chrome", "My Bank Statement - Chrome");

		await tracker.tick();

		expect(eventLog.record).toHaveBeenCalledTimes(1);
		expect(eventLog.record).toHaveBeenCalledWith("app.focus", {
			environmentId: environment.id,
			sessionId: session.id,
			subject: "chrome",
		});
	});

	it("does not record a second app.focus while the same process stays foregrounded, even if the title changes", async () => {
		const { db, session } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		tracker.setCurrentSession(session.id);

		stubForegroundApp(tracker, "chrome", "Tab 1 - Chrome");
		await tracker.tick();
		stubForegroundApp(tracker, "chrome", "Tab 2 - Chrome"); // title changed, process didn't
		await tracker.tick();

		expect(eventLog.record).toHaveBeenCalledTimes(1);
	});

	it("records a new app.focus when the foreground process actually changes", async () => {
		const { db, environment, session } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		tracker.setCurrentSession(session.id);

		stubForegroundApp(tracker, "chrome");
		await tracker.tick();
		stubForegroundApp(tracker, "code");
		await tracker.tick();

		expect(eventLog.record).toHaveBeenCalledTimes(2);
		expect(eventLog.record).toHaveBeenNthCalledWith(2, "app.focus", {
			environmentId: environment.id,
			sessionId: session.id,
			subject: "code",
		});
	});

	it("does not record app.focus while an ignored shell process is foregrounded", async () => {
		const { db, session } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		tracker.setCurrentSession(session.id);
		stubForegroundApp(tracker, "powershell");

		await tracker.tick();

		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("resets its dedup state on a new session, so the same app re-fires a focus event", async () => {
		const { db, environment, session } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		tracker.setCurrentSession(session.id);
		stubForegroundApp(tracker, "chrome");
		await tracker.tick();

		db.stopSession(session.id);
		tracker.clearCurrentSession();
		const session2 = db.startSession(environment.id);
		tracker.setCurrentSession(session2.id); // same app still foregrounded

		await tracker.tick();

		expect(eventLog.record).toHaveBeenCalledTimes(2);
		expect(eventLog.record).toHaveBeenNthCalledWith(2, "app.focus", {
			environmentId: environment.id,
			sessionId: session2.id,
			subject: "chrome",
		});
	});

	it("never throws when constructed without an event log", async () => {
		const { db, session } = await createSessionContext();
		const tracker = new ActivityTracker(db); // no eventLog argument at all
		tracker.setCurrentSession(session.id);
		stubForegroundApp(tracker, "chrome");

		await expect(tracker.tick()).resolves.not.toThrow();
	});

	it("does not record while there is no active session, matching the pre-existing tracking gate", async () => {
		const { db } = await createSessionContext();
		const eventLog = { record: vi.fn() };
		const tracker = new ActivityTracker(db, eventLog);
		stubForegroundApp(tracker, "chrome");
		// setCurrentSession() was never called -- tick() must no-op entirely.

		await tracker.tick();

		expect(eventLog.record).not.toHaveBeenCalled();
	});
});
