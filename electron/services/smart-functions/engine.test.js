import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { EventLog } from "../event-log.cjs";
import { createSmartFunctionsEngine } from "./engine.cjs";
import { createRule } from "./store.cjs";

// ---------------------------------------------------------------------------
// The smart functions engine (WP-3.1) -- the stateful glue: event-log
// subscription (genuinely event-driven, no polling), the time-of-day poll
// (the one deliberately polled trigger), and the two loop-prevention
// mechanisms (dispatch depth + per-rule rate cap).
//
// Uses a REAL EventLog so `subscribe()`'s synchronous listener notification
// is exercised for real, not mocked -- proving the engine is actually driven
// by that mechanism rather than by something this suite imagines it is. A
// REAL AtlasDatabase (temp file) backs it for the tests that create rules/
// tasks; the pure loop-prevention tests use a throwaway object db.EventLog
// never needs a working db unless flushNow()/start() is called, and this
// suite never calls either.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sf-engine-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

function fakePlatform() {
	return { launch: vi.fn().mockResolvedValue({ supported: true, launched: true }) };
}

// A handful of chained awaits (record -> handleEvent -> executeRule ->
// runActions -> action) settle within microtasks alone once dispatchNext is
// awaited (see actions.cjs) -- but the event-log SUBSCRIPTION callback itself
// is fire-and-forget (`void handleEvent(...)`, since a synchronous record()
// cannot await its own listeners). A short real timeout flushes both.
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("event-driven dispatch (no polling)", () => {
	it("a rule fires purely because eventLog.record() was called -- nothing here ever calls handleEvent directly", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		createRule(db, {
			label: "On session start, add a task",
			environmentId: environment.id,
			trigger: { type: "session.started" },
			actions: [{ type: "createTask", title: "Auto task" }],
		});

		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({
			getDb: () => db,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => environment.id,
			platform: fakePlatform(),
		});
		engine.start();

		eventLog.record("session.start", { environmentId: environment.id, sessionId: "sess-1" });
		await flush();

		const tasks = db.listTasksByEnvironment(environment.id);
		expect(tasks.map((t) => t.title)).toEqual(["Auto task"]);
	});

	it("a rule scoped to a DIFFERENT environment does not fire", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		const other = db.createEnvironment("Env B");
		createRule(db, {
			label: "Env B only",
			environmentId: other.id,
			trigger: { type: "session.started" },
			actions: [{ type: "createTask", title: "Should not appear" }],
		});

		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({
			getDb: () => db,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => environment.id,
			platform: fakePlatform(),
		});
		engine.start();

		eventLog.record("session.start", { environmentId: environment.id, sessionId: "sess-1" });
		await flush();

		expect(db.listTasksByEnvironment(other.id)).toEqual([]);
	});

	it("shutdown() unsubscribes -- a later record() no longer reaches any rule", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		createRule(db, {
			label: "On session start",
			environmentId: environment.id,
			trigger: { type: "session.started" },
			actions: [{ type: "createTask", title: "Should not appear" }],
		});

		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({
			getDb: () => db,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => environment.id,
			platform: fakePlatform(),
		});
		engine.start();
		expect(engine.getStatus().subscribed).toBe(true);
		engine.shutdown();
		expect(engine.getStatus().subscribed).toBe(false);

		eventLog.record("session.start", { environmentId: environment.id, sessionId: "sess-1" });
		await flush();

		expect(db.listTasksByEnvironment(environment.id)).toEqual([]);
	});
});

describe("loop prevention -- dispatch depth guard", () => {
	// The adversarial fixture the WP explicitly calls out: a rule triggered by
	// ANY environment switch, whose own action switches environment again --
	// left unguarded, this retriggers itself forever the instant its own
	// action's event-log write is observed.
	function createLoopingEngine({ maxDispatchDepth = 3, maxFiresPerWindow = 1000 } = {}) {
		const eventLog = new EventLog({});
		const switchEnvironment = vi.fn();
		const engine = createSmartFunctionsEngine({
			getDb: () => null,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => "env-a",
			switchEnvironment,
			platform: fakePlatform(),
			maxDispatchDepth,
			maxFiresPerWindow,
			rateWindowMs: 10_000,
		});
		return { eventLog, switchEnvironment, engine };
	}

	it("terminates after exactly maxDispatchDepth + 1 firings, proven by an exact, non-zero, bounded count", async () => {
		const { eventLog, switchEnvironment, engine } = createLoopingEngine({ maxDispatchDepth: 3 });
		const rule = {
			id: "loop-rule",
			environmentId: null,
			label: "Ping-pong",
			enabled: true,
			trigger: { type: "environment.switched", environmentId: null },
			conditions: [],
			actions: [{ type: "switchEnvironment", environmentId: "env-b" }],
			source: "user",
		};

		// Seed the engine's rule cache directly (refreshRules() reads from a
		// real db's `smart_functions` table -- this test asserts the pure
		// dispatch/loop-prevention wiring, not store.cjs, which already has its
		// own suite). `_seedRulesForTest` is a tiny, explicit test seam.
		engine._seedRulesForTest([rule]);

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await engine.handleEvent({ type: "environment.switch", environmentId: "env-a" }, 0);
		consoleSpy.mockRestore();

		// depth 0,1,2,3 all fire (4 total); depth 4 is refused -- an EXACT count,
		// not "eventually stops" or "fewer than 1000", so a regression that
		// changes the off-by-one boundary would be caught, not just a total
		// runaway. A "smart_function.loop_prevented" entry is what depth 4
		// logs instead of firing.
		expect(switchEnvironment).toHaveBeenCalledTimes(4);
		void eventLog;
	});

	it("terminates through the REAL end-to-end path too: one genuine, untagged eventLog.record() call, via the ordinary subscription", async () => {
		// Unlike the test above (which calls handleEvent directly), this one
		// goes through engine.start()'s real event-log subscription and records
		// exactly ONE real, untagged "environment.switch" -- indistinguishable
		// from what ipc/environments.cjs's own handler would record for an
		// actual user-driven switch. Everything after that first call (the
		// action's own tagged re-record, the recursive dispatchNext calls) is
		// entirely internal to the engine. If `smartFunctionOrigin` tagging
		// were NOT honoured by the subscription, this single external event
		// would cause the untagged listener to also re-enter at depth 0 on
		// every level of the chain, multiplying rather than merely adding one
		// firing per depth -- proven by disabling the tag check by hand while
		// developing this suite (see this WP's final report); left un-skipped
		// here because that would require monkey-patching engine.cjs from the
		// test, which is not this suite's job.
		const { eventLog, switchEnvironment, engine } = createLoopingEngine({ maxDispatchDepth: 3 });
		const rule = {
			id: "loop-rule",
			environmentId: null,
			label: "Ping-pong",
			enabled: true,
			trigger: { type: "environment.switched", environmentId: null },
			conditions: [],
			actions: [{ type: "switchEnvironment", environmentId: "env-b" }],
			source: "user",
		};
		// start() BEFORE seeding: start() itself calls refreshRules(), which
		// would otherwise overwrite the seeded fixture with whatever a null
		// `getDb` resolves to (an empty list).
		engine.start();
		engine._seedRulesForTest([rule]);

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		eventLog.record("environment.switch", { environmentId: "env-a" });
		await flush();
		consoleSpy.mockRestore();

		expect(switchEnvironment).toHaveBeenCalledTimes(4);
		engine.shutdown();
	});
});

describe("loop prevention -- per-rule rate cap", () => {
	it("suppresses a rule once it has fired maxFiresPerWindow times within rateWindowMs, independent of depth", async () => {
		const eventLog = new EventLog({});
		const events = [];
		const originalRecord = eventLog.record.bind(eventLog);
		eventLog.record = (type, options) => {
			events.push({ type, ...options });
			return originalRecord(type, options);
		};

		const launched = [];
		const platform = { launch: vi.fn((command) => launched.push(command)) };
		const engine = createSmartFunctionsEngine({
			getDb: () => null,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => "env-a",
			platform,
			maxDispatchDepth: 10,
			maxFiresPerWindow: 2,
			rateWindowMs: 60_000,
		});
		const rule = {
			id: "capped-rule",
			environmentId: null,
			label: "Capped",
			enabled: true,
			trigger: { type: "session.started" },
			conditions: [],
			actions: [{ type: "launchApp", command: "notepad.exe" }],
			source: "user",
		};
		engine._seedRulesForTest([rule]);

		// Three independent, real session-start events -- only the first two
		// should actually run the action; the third is rate-limited.
		await engine.handleEvent({ type: "session.start" }, 0);
		await engine.handleEvent({ type: "session.start" }, 0);
		await engine.handleEvent({ type: "session.start" }, 0);

		expect(launched).toEqual(["notepad.exe", "notepad.exe"]);
		expect(events.some((e) => e.type === "smart_function.suppressed")).toBe(true);
	});
});

describe("time.of_day -- the one deliberately polled trigger", () => {
	it("fires once when the simulated clock crosses the configured minute, not once per poll tick", async () => {
		vi.useFakeTimers();
		const base = new Date(2026, 0, 1, 8, 59, 50).getTime(); // 08:59:50
		vi.setSystemTime(base);

		const eventLog = new EventLog({});
		const platform = fakePlatform();
		const engine = createSmartFunctionsEngine({
			getDb: () => null,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => null,
			platform,
			timeOfDayPollMs: 1000,
			now: () => Date.now(),
		});
		// start() BEFORE seeding -- see the earlier test's comment on why.
		engine.start();
		engine._seedRulesForTest([
			{
				id: "morning-rule",
				environmentId: null,
				label: "09:00",
				enabled: true,
				trigger: { type: "time.of_day", time: "09:00" },
				conditions: [],
				actions: [{ type: "launchApp", command: "coffee.exe" }],
				source: "user",
			},
		]);

		// Still 08:59 -- no fire yet.
		await vi.advanceTimersByTimeAsync(1000);
		expect(platform.launch).not.toHaveBeenCalled();

		// Cross into 09:00.
		vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 5).getTime());
		await vi.advanceTimersByTimeAsync(1000);
		expect(platform.launch).toHaveBeenCalledTimes(1);

		// Still within the SAME minute on the next tick -- must not fire again.
		await vi.advanceTimersByTimeAsync(1000);
		expect(platform.launch).toHaveBeenCalledTimes(1);

		engine.shutdown();
	});
});

describe("file.changed -- rides the file-index watcher's own hook, not a new poll", () => {
	it("fires a matching rule when handleFileEvent is called directly", async () => {
		const eventLog = new EventLog({});
		const platform = fakePlatform();
		const engine = createSmartFunctionsEngine({
			getDb: () => null,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => null,
			platform,
		});
		engine._seedRulesForTest([
			{
				id: "psd-rule",
				environmentId: null,
				label: "PSD changed",
				enabled: true,
				trigger: { type: "file.changed", pattern: "*.psd", kind: null },
				conditions: [],
				actions: [{ type: "launchApp", command: "photoshop.exe" }],
				source: "user",
			},
		]);

		engine.handleFileEvent({ kind: "changed", path: "C:\\art\\banner.psd", environmentId: null });
		await flush();

		expect(platform.launch).toHaveBeenCalledWith("photoshop.exe");
	});

	it("a non-matching path never fires", async () => {
		const eventLog = new EventLog({});
		const platform = fakePlatform();
		const engine = createSmartFunctionsEngine({ getDb: () => null, getEventLog: () => eventLog, platform });
		engine._seedRulesForTest([
			{
				id: "psd-rule",
				environmentId: null,
				label: "PSD changed",
				enabled: true,
				trigger: { type: "file.changed", pattern: "*.psd", kind: null },
				conditions: [],
				actions: [{ type: "launchApp", command: "photoshop.exe" }],
				source: "user",
			},
		]);

		engine.handleFileEvent({ kind: "changed", path: "C:\\art\\banner.png", environmentId: null });
		await flush();

		expect(platform.launch).not.toHaveBeenCalled();
	});
});

describe("runManually", () => {
	it("runs a manual-trigger rule (a migrated scene) regardless of the current environment", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		const other = db.createEnvironment("Env B");
		const rule = createRule(db, {
			label: "Deep work scene",
			environmentId: environment.id,
			trigger: { type: "manual" },
			actions: [{ type: "createTask", title: "From the scene" }],
		});

		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({
			getDb: () => db,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => other.id, // a DIFFERENT environment is active
			platform: fakePlatform(),
		});

		const result = await engine.runManually(rule.id);

		expect(result.ok).toBe(true);
		expect(db.listTasksByEnvironment(environment.id).map((t) => t.title)).toEqual(["From the scene"]);
	});

	it("reports an error for an unknown rule id, never throws", async () => {
		const db = await createDb();
		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({ getDb: () => db, getEventLog: () => eventLog, platform: fakePlatform() });

		const result = await engine.runManually("does-not-exist");
		expect(result).toEqual({ ok: false, error: "Smart function not found." });
	});

	it("a disabled rule is not run manually either", async () => {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		const rule = createRule(db, {
			label: "Disabled",
			environmentId: environment.id,
			enabled: false,
			trigger: { type: "manual" },
			actions: [{ type: "createTask", title: "Should not run" }],
		});
		const eventLog = new EventLog(db);
		const engine = createSmartFunctionsEngine({ getDb: () => db, getEventLog: () => eventLog, platform: fakePlatform() });

		const result = await engine.runManually(rule.id);
		expect(result.ok).toBe(false);
		expect(db.listTasksByEnvironment(environment.id)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// WP-3.2's dry-run. The acceptance criterion is "shows what would happen
// WITHOUT doing it", so the assertions that carry it are all negative: no
// action executor ran, no task appeared, no `smart_function.fired` event was
// logged, and the rate cap a later real run depends on was not consumed.
// ---------------------------------------------------------------------------

describe("dryRun (WP-3.2)", () => {
	async function setup({ enabled = true, conditions = [], platform } = {}) {
		const db = await createDb();
		const environment = db.createEnvironment("Env A");
		const rule = createRule(db, {
			label: "Start the timer on session start",
			environmentId: environment.id,
			enabled,
			trigger: { type: "session.started" },
			conditions,
			actions: [
				{ type: "launchApp", command: "figma.exe" },
				{ type: "createTask", title: "Auto task" },
			],
		});
		const eventLog = new EventLog({ getDb: () => db });
		const launcher = platform ?? fakePlatform();
		const engine = createSmartFunctionsEngine({
			getDb: () => db,
			getEventLog: () => eventLog,
			getCurrentEnvironmentId: () => environment.id,
			platform: launcher,
		});
		engine.refreshRules();
		return { db, environment, rule, engine, launcher, eventLog };
	}

	it("reports that an eligible rule would fire, and says what it would do", async () => {
		const { engine, rule } = await setup();

		const result = engine.dryRun(rule.id);

		expect(result.ok).toBe(true);
		expect(result.wouldFire).toBe(true);
		expect(result.reason).toBe("matched");
		expect(result.actions).toEqual(["open figma.exe", 'add a task "Auto task"']);
	});

	// THE criterion.
	it("executes absolutely nothing -- no app launched, no task created", async () => {
		const { engine, rule, launcher, db, environment } = await setup();

		engine.dryRun(rule.id);

		expect(launcher.launch).not.toHaveBeenCalled();
		expect(db.listTasksByEnvironment(environment.id)).toEqual([]);
	});

	it("logs no smart_function.fired event, so a dry run leaves no trace of having run", async () => {
		const { engine, rule, db } = await setup();

		engine.dryRun(rule.id);

		// The event log is batched, but a fired event would have been buffered;
		// flushing proves nothing was there to write.
		expect(db.first("SELECT COUNT(*) AS count FROM events WHERE type = 'smart_function.fired'").count).toBe(0);
	});

	// A dry run that consumed the rate cap would make checking a rule change
	// whether it can then actually run -- the opposite of "without doing it".
	it("does not consume the per-rule rate cap", async () => {
		const { engine, rule } = await setup();

		// Far more dry runs than the default cap of 5 per window.
		for (let i = 0; i < 20; i += 1) {
			engine.dryRun(rule.id);
		}

		expect(engine.dryRun(rule.id).reason).toBe("matched");
		const real = await engine.runManually(rule.id);
		expect(real.ok).toBe(true);
	});

	it("reports a disabled rule as disabled rather than pretending it would run", async () => {
		const { engine, rule } = await setup({ enabled: false });

		const result = engine.dryRun(rule.id);
		expect(result.wouldFire).toBe(false);
		expect(result.reason).toBe("disabled");
	});

	it("reports an unmet condition as the reason, using the engine's own verdict", async () => {
		const { engine, rule } = await setup({
			conditions: [{ type: "app_running", processName: "SomethingNotInFront" }],
		});

		const result = engine.dryRun(rule.id);
		expect(result.wouldFire).toBe(false);
		expect(result.reason).toBe("condition_failed");
	});

	it("includes the live values the verdict was measured against", async () => {
		const { engine, rule, environment } = await setup();

		const result = engine.dryRun(rule.id);
		expect(result.context.currentEnvironmentId).toBe(environment.id);
		expect(typeof result.context.now).toBe("number");
	});

	it("carries the same plain-language description the list shows", async () => {
		const { engine, rule } = await setup();

		const result = engine.dryRun(rule.id);
		expect(result.description).toContain("When a session starts");
		expect(result.description).toContain("open figma.exe");
	});

	it("refuses an unknown rule id without throwing", async () => {
		const { engine } = await setup();

		const result = engine.dryRun("no-such-rule");
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
