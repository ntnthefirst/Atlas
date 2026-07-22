import { describe, expect, it, vi } from "vitest";
import { register } from "./findings.cjs";

function createFakeIpcMain() {
	const handlers = new Map();
	return {
		handle(channel, fn) {
			handlers.set(channel, fn);
		},
		invoke(channel, ...args) {
			const fn = handlers.get(channel);
			if (!fn) {
				throw new Error(`no handler registered for ${channel}`);
			}
			return fn({}, ...args);
		},
	};
}

function createFakeManager(overrides = {}) {
	return {
		getPreferences: vi.fn(() => ({})),
		setPreferences: vi.fn((patch) => patch),
		markSuggested: vi.fn(() => ({ ok: true })),
		acceptFinding: vi.fn(() => ({ ok: true, rule: { id: "rule-1", environmentId: "env-a" } })),
		ignoreFinding: vi.fn(() => ({
			ok: true,
			finding: { id: "f1", environmentId: "env-a", patternType: "sequential_co_occurrence" },
		})),
		resurfaceDueFindings: vi.fn(() => ({ resurfacedCount: 0, findingIds: [] })),
		sweepExpiredFindings: vi.fn(() => ({ expiredCount: 0, findingIds: [] })),
		...overrides,
	};
}

describe("findings:accept", () => {
	it("refreshes the smart-functions engine's rule cache on success", () => {
		const manager = createFakeManager();
		const engine = { refreshRules: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager, engine });

		ipcMain.invoke("findings:accept", "f1");

		expect(engine.refreshRules).toHaveBeenCalledOnce();
	});

	it("does NOT refresh rules or log anything when the accept itself failed", () => {
		const manager = createFakeManager({ acceptFinding: vi.fn(() => ({ ok: false, error: "nope" })) });
		const engine = { refreshRules: vi.fn() };
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager, engine, getEventLog: () => eventLog });

		ipcMain.invoke("findings:accept", "f1");

		expect(engine.refreshRules).not.toHaveBeenCalled();
		expect(eventLog.record).not.toHaveBeenCalled();
	});

	it("logs suggestion.accepted with the pattern type and environment, never a raw title/path", () => {
		// A minimal fake db -- store.cjs#getFinding only ever calls db.first().
		const getDb = () => ({
			first: () => ({
				id: "f1",
				environment_id: "env-a",
				pattern_type: "sequential_co_occurrence",
				status: "suggested",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			}),
		});
		const manager = createFakeManager();
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();

		register(ipcMain, { manager, getDb, getEventLog: () => eventLog });
		ipcMain.invoke("findings:accept", "f1");

		expect(eventLog.record).toHaveBeenCalledWith("suggestion.accepted", {
			environmentId: "env-a",
			subject: "f1",
			payload: { patternType: "sequential_co_occurrence" },
		});
		expect(JSON.stringify(eventLog.record.mock.calls[0])).not.toMatch(/title|filePath/i);
	});

	it("works fine with no getEventLog dependency at all (optional)", () => {
		const manager = createFakeManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		expect(() => ipcMain.invoke("findings:accept", "f1")).not.toThrow();
	});
});

describe("findings:ignore", () => {
	it("logs suggestion.dismissed with the finding's own environment/pattern type on success", () => {
		const manager = createFakeManager();
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager, getEventLog: () => eventLog });

		ipcMain.invoke("findings:ignore", "f1");

		expect(eventLog.record).toHaveBeenCalledWith("suggestion.dismissed", {
			environmentId: "env-a",
			subject: "f1",
			payload: { patternType: "sequential_co_occurrence" },
		});
	});

	it("logs nothing when the ignore itself failed", () => {
		const manager = createFakeManager({ ignoreFinding: vi.fn(() => ({ ok: false, error: "nope" })) });
		const eventLog = { record: vi.fn() };
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager, getEventLog: () => eventLog });

		ipcMain.invoke("findings:ignore", "f1");

		expect(eventLog.record).not.toHaveBeenCalled();
	});
});

describe("findings:* bulk sweeps and preferences -- unchanged delegation", () => {
	it("still delegates every existing channel to the manager", () => {
		const manager = createFakeManager();
		const ipcMain = createFakeIpcMain();
		register(ipcMain, { manager });

		ipcMain.invoke("findings:getLifecyclePreferences");
		ipcMain.invoke("findings:setLifecyclePreferences", { expiryDays: 5 });
		ipcMain.invoke("findings:markSuggested", "f1");
		ipcMain.invoke("findings:resurfaceDue");
		ipcMain.invoke("findings:sweepExpired");

		expect(manager.getPreferences).toHaveBeenCalledOnce();
		expect(manager.setPreferences).toHaveBeenCalledWith({ expiryDays: 5 });
		expect(manager.markSuggested).toHaveBeenCalledWith("f1");
		expect(manager.resurfaceDueFindings).toHaveBeenCalledOnce();
		expect(manager.sweepExpiredFindings).toHaveBeenCalledOnce();
	});
});
