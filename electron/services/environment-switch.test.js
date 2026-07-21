import { describe, expect, it, vi } from "vitest";
import {
	resolveEnvironmentBundle,
	resolveEffectiveTheme,
	startAutoSession,
	launchStartupApps,
	applyStartupBehaviour,
} from "./environment-switch.cjs";

function createFakeDb(configsByEnvironment) {
	return {
		getEnvironmentConfig: (environmentId) => configsByEnvironment[environmentId] ?? null,
	};
}

describe("resolveEnvironmentBundle (WP-1.4) -- atomic switch resolution", () => {
	it("resolves appearance/ai/startupBehaviour straight from the target environment's config", () => {
		const db = createFakeDb({
			"env-a": {
				appearance: { accent: "#111111", theme: "dark" },
				ai: { defaultProvider: "google", systemPrompt: "a" },
				startupBehaviour: { autoStartSession: true, launchApps: ["notepad.exe"] },
			},
		});

		expect(resolveEnvironmentBundle(db, "env-a")).toEqual({
			environmentId: "env-a",
			appearance: { accent: "#111111", theme: "dark" },
			ai: { defaultProvider: "google", systemPrompt: "a" },
			startupBehaviour: { autoStartSession: true, launchApps: ["notepad.exe"] },
		});
	});

	// The core atomicity guarantee: resolving environment B never carries
	// forward anything from environment A, because this function has no
	// shared mutable state to leak through -- each call is independent.
	it("never leaks a previous environment's values into the next resolution", () => {
		const db = createFakeDb({
			"env-a": {
				appearance: { accent: "#111111", theme: "dark" },
				ai: { defaultProvider: "google", systemPrompt: "a" },
				startupBehaviour: { autoStartSession: true, launchApps: ["a.exe"] },
			},
			"env-b": {
				appearance: { accent: "#222222", theme: "light" },
				ai: { defaultProvider: null, systemPrompt: "" },
				startupBehaviour: { autoStartSession: false, launchApps: [] },
			},
		});

		const bundleA = resolveEnvironmentBundle(db, "env-a");
		const bundleB = resolveEnvironmentBundle(db, "env-b");

		expect(bundleA.appearance.accent).toBe("#111111");
		expect(bundleB.appearance.accent).toBe("#222222");
		expect(bundleB.appearance.theme).toBe("light");
		expect(bundleB.ai.defaultProvider).toBeNull();
		expect(bundleB.startupBehaviour.autoStartSession).toBe(false);

		// Re-resolving A again (as a real switch back would) still gets A's own
		// values, not anything B's resolution might have touched.
		expect(resolveEnvironmentBundle(db, "env-a")).toEqual(bundleA);
	});

	it("resolves to neutral defaults for an environment with no config document yet", () => {
		const db = createFakeDb({});
		expect(resolveEnvironmentBundle(db, "env-fresh")).toEqual({
			environmentId: "env-fresh",
			appearance: { accent: null, theme: "system" },
			ai: { defaultProvider: null, systemPrompt: "" },
			startupBehaviour: { autoStartSession: false, launchApps: [] },
		});
	});

	it("resolves to neutral defaults with no environment id at all (e.g. at boot)", () => {
		expect(resolveEnvironmentBundle(createFakeDb({}), null)).toEqual({
			environmentId: null,
			appearance: { accent: null, theme: "system" },
			ai: { defaultProvider: null, systemPrompt: "" },
			startupBehaviour: { autoStartSession: false, launchApps: [] },
		});
	});
});

describe("resolveEffectiveTheme (WP-1.4)", () => {
	it("an explicit environment override always wins", () => {
		expect(resolveEffectiveTheme("dark", "light")).toBe("dark");
		expect(resolveEffectiveTheme("light", "dark")).toBe("light");
	});

	it("'system' (no opinion) falls back to the remembered global preference", () => {
		expect(resolveEffectiveTheme("system", "dark")).toBe("dark");
		expect(resolveEffectiveTheme("system", "light")).toBe("light");
	});

	it("never leaks a previous environment's override as the new fallback", () => {
		// Simulates: env A overrides to "dark", user switches to env B which has
		// no opinion ("system") -- B must resolve to the GLOBAL preference, not
		// silently stay on A's "dark".
		const globalPreference = "light";
		expect(resolveEffectiveTheme("dark", globalPreference)).toBe("dark");
		expect(resolveEffectiveTheme("system", globalPreference)).toBe("light");
	});

	it("falls back to 'system' when the global preference itself is unset/invalid", () => {
		expect(resolveEffectiveTheme("system", undefined)).toBe("system");
		expect(resolveEffectiveTheme("system", "garbage")).toBe("system");
	});
});

describe("startAutoSession (WP-1.4)", () => {
	function createFakeSessionDb({ active = null } = {}) {
		return {
			getActiveSession: vi.fn(() => active),
			startSession: vi.fn((environmentId) => ({ id: "session-1", environment_id: environmentId })),
		};
	}

	it("starts a session and wires the tracker + event log when nothing else is active", () => {
		const db = createFakeSessionDb();
		const tracker = { setCurrentSession: vi.fn() };
		const eventLog = { record: vi.fn() };

		const session = startAutoSession({
			db,
			environmentId: "env-a",
			getTracker: () => tracker,
			getEventLog: () => eventLog,
		});

		expect(session).toEqual({ id: "session-1", environment_id: "env-a" });
		expect(db.startSession).toHaveBeenCalledWith("env-a");
		expect(tracker.setCurrentSession).toHaveBeenCalledWith("session-1");
		expect(eventLog.record).toHaveBeenCalledWith("session.start", { environmentId: "env-a", sessionId: "session-1" });
	});

	it("never starts (or fights) a session when one is already active anywhere", () => {
		const db = createFakeSessionDb({ active: { id: "existing", environment_id: "some-other-env" } });

		const session = startAutoSession({ db, environmentId: "env-a", getTracker: () => null, getEventLog: () => null });

		expect(session).toBeNull();
		expect(db.startSession).not.toHaveBeenCalled();
	});

	it("never throws when db.startSession itself throws", () => {
		const db = createFakeSessionDb();
		db.startSession = vi.fn(() => {
			throw new Error("boom");
		});

		expect(() => startAutoSession({ db, environmentId: "env-a" })).not.toThrow();
	});
});

describe("launchStartupApps (WP-1.4)", () => {
	it("launches every configured command through the platform adapter", async () => {
		const platform = { launch: vi.fn(async () => ({ supported: true, launched: true })) };

		await launchStartupApps({ platform, launchApps: ["notepad.exe", "calc.exe"] });

		expect(platform.launch).toHaveBeenCalledTimes(2);
		expect(platform.launch).toHaveBeenNthCalledWith(1, "notepad.exe");
		expect(platform.launch).toHaveBeenNthCalledWith(2, "calc.exe");
	});

	it("one failing command never stops the rest", async () => {
		const platform = {
			launch: vi
				.fn()
				.mockRejectedValueOnce(new Error("nope"))
				.mockResolvedValueOnce({ supported: true, launched: true }),
		};

		await expect(launchStartupApps({ platform, launchApps: ["bad.exe", "good.exe"] })).resolves.toBeUndefined();
		expect(platform.launch).toHaveBeenCalledTimes(2);
	});

	it("does nothing for an empty list", async () => {
		const platform = { launch: vi.fn() };
		await launchStartupApps({ platform, launchApps: [] });
		expect(platform.launch).not.toHaveBeenCalled();
	});
});

describe("applyStartupBehaviour (WP-1.4) -- off by default", () => {
	it("does absolutely nothing when startupBehaviour is the untouched default", async () => {
		const db = { getActiveSession: vi.fn(), startSession: vi.fn() };
		const platform = { launch: vi.fn() };

		await applyStartupBehaviour({
			db,
			environmentId: "env-a",
			startupBehaviour: { autoStartSession: false, launchApps: [] },
			platform,
			getTracker: () => ({ setCurrentSession: vi.fn() }),
			getEventLog: () => ({ record: vi.fn() }),
		});

		expect(db.getActiveSession).not.toHaveBeenCalled();
		expect(db.startSession).not.toHaveBeenCalled();
		expect(platform.launch).not.toHaveBeenCalled();
	});

	it("does nothing when startupBehaviour itself is missing/undefined", async () => {
		const platform = { launch: vi.fn() };
		await applyStartupBehaviour({ environmentId: "env-a", startupBehaviour: undefined, platform });
		expect(platform.launch).not.toHaveBeenCalled();
	});

	it("runs only autoStartSession when just that one is opted in", async () => {
		const db = { getActiveSession: vi.fn(() => null), startSession: vi.fn(() => ({ id: "s1", environment_id: "env-a" })) };
		const platform = { launch: vi.fn() };

		await applyStartupBehaviour({
			db,
			environmentId: "env-a",
			startupBehaviour: { autoStartSession: true, launchApps: [] },
			platform,
			getTracker: () => ({ setCurrentSession: vi.fn() }),
			getEventLog: () => ({ record: vi.fn() }),
		});

		expect(db.startSession).toHaveBeenCalledWith("env-a");
		expect(platform.launch).not.toHaveBeenCalled();
	});

	it("runs only launchApps when just that one is opted in", async () => {
		const db = { getActiveSession: vi.fn(), startSession: vi.fn() };
		const platform = { launch: vi.fn(async () => ({ supported: true, launched: true })) };

		await applyStartupBehaviour({
			db,
			environmentId: "env-a",
			startupBehaviour: { autoStartSession: false, launchApps: ["notepad.exe"] },
			platform,
		});

		expect(db.startSession).not.toHaveBeenCalled();
		expect(platform.launch).toHaveBeenCalledWith("notepad.exe");
	});
});
