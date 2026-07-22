import { describe, expect, it, vi } from "vitest";
import { contextLayoutId, createContextService } from "./context-service.cjs";
import { BROWSING, CODING, COMMUNICATION } from "./context-detection.cjs";

// ---------------------------------------------------------------------------
// The stateful context service (WP-2.8). Clock, timers and the platform probe
// are all injected, so nothing here waits on real time or spawns PowerShell.
// ---------------------------------------------------------------------------

const DWELL = 1000;
const GAP = 600;

function createHarness(overrides = {}) {
	const events = [];
	const broadcasts = [];
	const intervals = [];
	const clearIntervalSpy = vi.fn();
	const layoutRows = overrides.layoutRows ?? new Map();

	const service = createContextService({
		getDb: overrides.getDb ?? (() => ({ getNotchLayoutRow: (id) => layoutRows.get(id) ?? null })),
		getEventLog: () => ({
			record: (type, options) => events.push({ type, ...options }),
		}),
		getActiveEnvironmentId: overrides.getActiveEnvironmentId ?? (() => "env-1"),
		platform: overrides.platform ?? { getForegroundWindow: async () => ({ supported: true, processName: "code" }) },
		powerMonitor: overrides.powerMonitor,
		broadcast: (payload) => broadcasts.push(payload),
		setInterval: (callback, ms) => {
			const handle = { callback, ms, unref: vi.fn() };
			intervals.push(handle);
			return handle;
		},
		clearInterval: clearIntervalSpy,
		dwellMs: DWELL,
		candidateGapMs: GAP,
		pollIntervalMs: overrides.pollIntervalMs ?? 4000,
		batteryPollIntervalMs: overrides.batteryPollIntervalMs ?? 15_000,
	});

	// Drives a sustained context to a committed switch.
	function commit(processName, startAt) {
		service.observe(processName, startAt);
		service.observe(processName, startAt + 500);
		service.observe(processName, startAt + DWELL);
	}

	return { service, events, broadcasts, intervals, clearIntervalSpy, layoutRows, commit };
}

describe("createContextService -- detection and events", () => {
	it("commits a context only after a sustained signal, and logs the change", () => {
		const { service, events, commit } = createHarness();
		service.observe("code", 0);
		expect(service.getStatus().context).toBeNull();
		expect(events).toHaveLength(0);

		commit("code", 0);
		expect(service.getStatus().context).toBe(CODING);
		const changes = events.filter((event) => event.type === "context.changed");
		expect(changes).toHaveLength(1);
		expect(changes[0].payload).toEqual({ from: null, to: CODING });
	});

	it("scopes the logged event to the active environment", () => {
		const { service, events, commit } = createHarness({ getActiveEnvironmentId: () => "env-42" });
		commit("slack", 0);
		expect(service.getStatus().context).toBe(COMMUNICATION);
		expect(events[0].environmentId).toBe("env-42");
	});

	// Privacy: the whole point is that a window title cannot reach the log.
	it("logs the derived context only -- never a process name or window title", () => {
		const { events, commit } = createHarness();
		commit("slack", 0);
		const serialized = JSON.stringify(events);
		expect(serialized).toContain(COMMUNICATION);
		expect(serialized).not.toContain("slack");
	});

	it("a brief app switch produces no event at all", () => {
		const { service, events, commit } = createHarness();
		commit("code", 0);
		events.length = 0;
		service.observe("slack", 1100);
		service.observe("slack", 1200);
		service.observe("code", 1300);
		expect(events).toHaveLength(0);
		expect(service.getStatus().context).toBe(CODING);
	});
});

describe("createContextService -- pinning overrides detection entirely", () => {
	it("a pinned context wins over whatever is detected", () => {
		const { service, commit } = createHarness();
		commit("code", 0);
		expect(service.getEffectiveContext()).toBe(CODING);

		service.pin(BROWSING);
		expect(service.getEffectiveContext()).toBe(BROWSING);
		expect(service.getStatus().isPinned).toBe(true);
	});

	it("detection keeps running while pinned but never emits a change event", () => {
		const { service, events, commit } = createHarness();
		service.pin(BROWSING);
		events.length = 0;

		commit("code", 0);
		// Underneath, the detector did its job...
		expect(service.getStatus().context).toBe(CODING);
		// ...but nothing was logged and the effective context never moved.
		expect(events.filter((event) => event.type === "context.changed")).toHaveLength(0);
		expect(service.getEffectiveContext()).toBe(BROWSING);
	});

	it("unpinning falls back to the context detected in the meantime, not a stale one", () => {
		const { service, commit } = createHarness();
		service.pin(BROWSING);
		commit("code", 0);
		service.unpin();
		expect(service.getStatus().isPinned).toBe(false);
		expect(service.getEffectiveContext()).toBe(CODING);
	});

	it("refuses a context that is not one of the known three", () => {
		const { service } = createHarness();
		service.pin("gaming");
		expect(service.getStatus().isPinned).toBe(false);
		service.pin(null);
		expect(service.getStatus().isPinned).toBe(false);
	});
});

describe("createContextService -- layout mapping", () => {
	it("maps a context to its well-known layout row when one exists", () => {
		const layoutRows = new Map([[contextLayoutId(CODING), { id: contextLayoutId(CODING), data: "{}" }]]);
		const { service, commit } = createHarness({ layoutRows });
		commit("code", 0);
		expect(service.resolveLayoutId()).toBe("context:coding");
	});

	// Degrading to the environment's own layout is what makes this feature
	// invisible until the user opts into it.
	it("resolves to null when no layout has been configured for the context", () => {
		const { service, commit } = createHarness({ layoutRows: new Map() });
		commit("code", 0);
		expect(service.resolveLayoutId()).toBeNull();
	});

	it("follows the pin rather than the detected context", () => {
		const layoutRows = new Map([
			[contextLayoutId(CODING), { id: contextLayoutId(CODING), data: "{}" }],
			[contextLayoutId(BROWSING), { id: contextLayoutId(BROWSING), data: "{}" }],
		]);
		const { service, commit } = createHarness({ layoutRows });
		commit("code", 0);
		service.pin(BROWSING);
		expect(service.resolveLayoutId()).toBe("context:browsing");
	});

	it("survives a database that throws", () => {
		const { service, commit } = createHarness({
			getDb: () => ({
				getNotchLayoutRow: () => {
					throw new Error("db exploded");
				},
			}),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		commit("code", 0);
		expect(service.resolveLayoutId()).toBeNull();
	});
});

describe("createContextService -- polling lifecycle", () => {
	it("does not poll until explicitly started", () => {
		const { service, intervals } = createHarness();
		expect(intervals).toHaveLength(0);
		expect(service.getStatus().polling).toBe(false);
	});

	it("start() polls at the configured interval and unrefs the timer", () => {
		const { service, intervals } = createHarness({ pollIntervalMs: 4000 });
		service.start();
		expect(intervals).toHaveLength(1);
		expect(intervals[0].ms).toBe(4000);
		expect(intervals[0].unref).toHaveBeenCalled();
		expect(service.getStatus().polling).toBe(true);
	});

	it("backs off to the battery interval when unplugged", () => {
		const { service, intervals } = createHarness({
			powerMonitor: { isOnBatteryPower: () => true },
			batteryPollIntervalMs: 15_000,
		});
		service.start();
		expect(intervals[0].ms).toBe(15_000);
	});

	it("stop() clears the timer", () => {
		const { service, intervals, clearIntervalSpy } = createHarness();
		service.start();
		service.stop();
		expect(clearIntervalSpy).toHaveBeenCalledWith(intervals[0]);
		expect(service.getStatus().polling).toBe(false);
	});

	it("a poll feeds the detector from the platform adapter", async () => {
		const { service, intervals } = createHarness();
		service.start();
		for (const at of [0, 500, DWELL]) {
			void at;
			intervals[0].callback();
			await service.waitForIdle();
		}
		// Three real observations arrived; with a real clock they are moments
		// apart, so nothing is committed yet -- but the detector is tracking.
		expect(service.getStatus().candidate).toBe(CODING);
	});

	it("ignores an unsupported platform instead of inventing a context", async () => {
		const { service, intervals } = createHarness({
			platform: { getForegroundWindow: async () => ({ supported: false }) },
		});
		service.start();
		intervals[0].callback();
		await service.waitForIdle();
		expect(service.getStatus().context).toBeNull();
		expect(service.getStatus().candidate).toBeNull();
	});

	it("survives a foreground probe that rejects", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { service, intervals } = createHarness({
			platform: {
				getForegroundWindow: async () => {
					throw new Error("powershell died");
				},
			},
		});
		service.start();
		intervals[0].callback();
		await expect(service.waitForIdle()).resolves.not.toThrow();
		expect(service.getStatus().context).toBeNull();
	});
});
