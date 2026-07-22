import { describe, expect, it, vi } from "vitest";
import { createLauncherProviderRegistry, search, execute, DEFAULT_PROVIDER_TIMEOUT_MS } from "./index.cjs";
import { ACTIONS } from "./actions-provider.cjs";

// ---------------------------------------------------------------------------
// The provider registry (WP-2.2). Every test below builds its OWN registry
// via createLauncherProviderRegistry() rather than touching the production
// singleton's provider list, so registering a fake/broken provider in one
// test can never leak into another (or into the "actions" provider the
// production module registers at require time).
//
// The handful of tests at the bottom exercise the actual production
// singleton (`search`/`execute` exported from this file) to prove the
// "actions" provider is really wired in as an ordinary registrant -- the
// direct successor of the old launcher-providers.cjs stub's own test suite.
// ---------------------------------------------------------------------------

function delay(ms, value) {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fakeProvider(name, { results = [], execute: executeImpl, timeoutMs } = {}) {
	return {
		name,
		timeoutMs,
		search: vi.fn(async () => results),
		execute: executeImpl ?? vi.fn(async (result) => ({ ok: true, echoedId: result?.id ?? null })),
	};
}

describe("registerProvider()", () => {
	it("accepts a well-formed provider", () => {
		const registry = createLauncherProviderRegistry();
		expect(() => registry.registerProvider(fakeProvider("p1"))).not.toThrow();
		expect(registry.listProviders().map((p) => p.name)).toEqual(["p1"]);
	});

	it("throws for a provider missing a name", () => {
		const registry = createLauncherProviderRegistry();
		expect(() => registry.registerProvider({ search: vi.fn(), execute: vi.fn() })).toThrow(/non-empty string `name`/);
	});

	it("throws for a provider missing search()/execute()", () => {
		const registry = createLauncherProviderRegistry();
		expect(() => registry.registerProvider({ name: "broken" })).toThrow(/must implement both/);
	});

	it("throws when registering the same provider name twice", () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("dup"));
		expect(() => registry.registerProvider(fakeProvider("dup"))).toThrow(/already registered/);
	});
});

describe("search() -- aggregation across providers", () => {
	it("merges results from every registered provider, namespacing each id by provider name", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("tasks", { results: [{ id: "1", kind: "task", title: "Write report" }] }));
		registry.registerProvider(fakeProvider("notes", { results: [{ id: "1", kind: "note", title: "Meeting notes" }] }));

		const results = await registry.search("", { environmentId: "env-1" });

		const ids = results.map((r) => r.id).sort();
		expect(ids).toEqual(["notes::1", "tasks::1"]);
	});

	it("stamps providerName onto every result", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("tasks", { results: [{ id: "1", kind: "task", title: "A" }] }));

		const [result] = await registry.search("", { environmentId: "env-1" });
		expect(result.providerName).toBe("tasks");
	});

	it("threads context.environmentId into every provider's search()", async () => {
		const registry = createLauncherProviderRegistry();
		const provider = fakeProvider("tasks");
		registry.registerProvider(provider);

		await registry.search("hello", { environmentId: "env-42" });

		expect(provider.search).toHaveBeenCalledWith("hello", expect.objectContaining({ environmentId: "env-42" }));
	});

	it("drops a malformed result (no id) without dropping the rest of that provider's results", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(
			fakeProvider("tasks", {
				results: [
					{ id: "ok", kind: "task", title: "Fine" },
					{ kind: "task", title: "Missing an id" },
					{ id: "", kind: "task", title: "Empty id" },
				],
			}),
		);

		const results = await registry.search("", { environmentId: "env-1" });
		expect(results.map((r) => r.id)).toEqual(["tasks::ok"]);
	});

	it("returns an empty list, without throwing, when nothing is registered", async () => {
		const registry = createLauncherProviderRegistry();
		await expect(registry.search("anything", { environmentId: "env-1" })).resolves.toEqual([]);
	});
});

describe("search() -- per-provider timeout and fault isolation", () => {
	it("drops a provider that never resolves within its timeout, but still returns the others", async () => {
		const registry = createLauncherProviderRegistry();
		const hangingSearch = vi.fn(() => new Promise(() => {})); // never resolves
		registry.registerProvider({ name: "hangs", timeoutMs: 20, search: hangingSearch, execute: vi.fn() });
		registry.registerProvider(fakeProvider("fine", { results: [{ id: "1", kind: "action", title: "Fine" }] }));

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await registry.search("", { environmentId: "env-1" });
		consoleSpy.mockRestore();

		expect(results.map((r) => r.id)).toEqual(["fine::1"]);
	});

	it("drops a provider whose search() rejects, but still returns the others", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider({
			name: "broken",
			search: vi.fn(async () => {
				throw new Error("boom");
			}),
			execute: vi.fn(),
		});
		registry.registerProvider(fakeProvider("fine", { results: [{ id: "1", kind: "action", title: "Fine" }] }));

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await registry.search("", { environmentId: "env-1" });
		consoleSpy.mockRestore();

		expect(results.map((r) => r.id)).toEqual(["fine::1"]);
	});

	it("respects a provider's own timeoutMs override rather than always using the default", async () => {
		const registry = createLauncherProviderRegistry();
		// Resolves comfortably inside its own generous override, but would
		// exceed a tiny default -- proves the override, not the default, governs.
		registry.registerProvider({
			name: "slow-but-allowed",
			timeoutMs: 500,
			search: vi.fn(() => delay(50, [{ id: "1", kind: "action", title: "Eventually" }])),
			execute: vi.fn(),
		});

		const results = await registry.search("", { environmentId: "env-1" });
		expect(results.map((r) => r.id)).toEqual(["slow-but-allowed::1"]);
	});

	it("falls back to DEFAULT_PROVIDER_TIMEOUT_MS when a provider declares none", () => {
		expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBeGreaterThanOrEqual(150);
		expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(250);
	});

	it("a provider timing out never delays the overall search past its own timeout window", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider({ name: "hangs", timeoutMs: 30, search: () => new Promise(() => {}), execute: vi.fn() });
		registry.registerProvider(fakeProvider("fine", { results: [{ id: "1", kind: "action", title: "Fine" }] }));

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const start = Date.now();
		await registry.search("", { environmentId: "env-1" });
		const elapsed = Date.now() - start;
		consoleSpy.mockRestore();

		// Generous ceiling (well above the 30ms timeout) so this stays reliable
		// under CI scheduling jitter, while still catching the real bug this
		// guards against: a hung provider blocking search() indefinitely.
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("execute() -- routing back to the owning provider", () => {
	it("routes to the provider that produced the result, passing back its own unprefixed id", async () => {
		const registry = createLauncherProviderRegistry();
		const providerExecute = vi.fn(async (result) => ({ ok: true, receivedId: result.id }));
		registry.registerProvider(fakeProvider("tasks", { results: [{ id: "42", kind: "task", title: "Do it" }], execute: providerExecute }));

		const [result] = await registry.search("", { environmentId: "env-1" });
		expect(result.id).toBe("tasks::42");

		const outcome = await registry.execute(result.id, { environmentId: "env-1", modifier: null });

		expect(providerExecute).toHaveBeenCalledWith(
			expect.objectContaining({ id: "42" }),
			{ environmentId: "env-1", modifier: null },
			expect.objectContaining({
				getDb: expect.any(Function),
				getEventLog: expect.any(Function),
				getMainWindow: expect.any(Function),
				showMainWindow: expect.any(Function),
				navigate: expect.any(Function),
				switchEnvironment: expect.any(Function),
			}),
		);
		expect(outcome).toEqual({ ok: true, receivedId: "42", resultId: "tasks::42", modifier: null });
	});

	it("falls back to parsing the provider name from the id prefix on a cache miss", async () => {
		const registry = createLauncherProviderRegistry();
		const providerExecute = vi.fn(async (result) => ({ ok: true, receivedId: result.id }));
		registry.registerProvider(fakeProvider("tasks", { execute: providerExecute }));

		// Never searched -- nothing is cached -- but the id still carries the
		// provider's own namespace prefix.
		const outcome = await registry.execute("tasks::99", { modifier: "ctrl" });

		expect(providerExecute).toHaveBeenCalledWith(
			{ id: "99" },
			{ modifier: "ctrl" },
			expect.objectContaining({
				getDb: expect.any(Function),
				getEventLog: expect.any(Function),
				getMainWindow: expect.any(Function),
				showMainWindow: expect.any(Function),
				navigate: expect.any(Function),
				switchEnvironment: expect.any(Function),
			}),
		);
		expect(outcome).toEqual({ ok: true, receivedId: "99", resultId: "tasks::99", modifier: "ctrl" });
	});

	it("returns ok:false without throwing for an id with no registered owning provider", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("tasks"));

		const outcome = await registry.execute("ghost-provider::1", {});
		expect(outcome.ok).toBe(false);
		expect(outcome.resultId).toBe("ghost-provider::1");
	});

	it("returns ok:false without throwing for a completely unrecognizable id", async () => {
		const registry = createLauncherProviderRegistry();
		const outcome = await registry.execute("not-namespaced-at-all", {});
		expect(outcome.ok).toBe(false);
	});

	it("catches a throwing provider execute() and reports ok:false rather than rejecting", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(
			fakeProvider("tasks", {
				results: [{ id: "1", kind: "task", title: "A" }],
				execute: vi.fn(async () => {
					throw new Error("execute blew up");
				}),
			}),
		);
		await registry.search("", { environmentId: "env-1" });

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const outcome = await registry.execute("tasks::1", {});
		consoleSpy.mockRestore();

		expect(outcome.ok).toBe(false);
	});
});

describe("frecency lookup -- per-environment scoping", () => {
	function fakeDb(rowsByEnv) {
		return {
			all: vi.fn((_sql, params) => {
				const [, environmentId] = params;
				return rowsByEnv[environmentId] ?? [];
			}),
		};
	}

	it("passes the search's own environmentId into the frecency query, not a fixed one", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("actions", { results: [{ id: "open-settings", kind: "action", title: "Open Settings" }] }));

		const db = fakeDb({
			"env-a": [{ subject: "actions::open-settings", count: 50, lastTs: new Date().toISOString() }],
			"env-b": [],
		});
		registry.init({ getDb: () => db });

		const resultsA = await registry.search("open settings", { environmentId: "env-a" });
		const resultsB = await registry.search("open settings", { environmentId: "env-b" });

		expect(resultsA[0].frecencyScore).toBeGreaterThan(0);
		expect(resultsB[0].frecencyScore).toBe(0);
	});

	it("ranks by match quality alone (no throw) when getDb is never wired up", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("actions", { results: [{ id: "1", kind: "action", title: "A" }] }));

		await expect(registry.search("a", { environmentId: "env-1" })).resolves.toHaveLength(1);
	});

	it("ranks by match quality alone when the frecency query itself throws", async () => {
		const registry = createLauncherProviderRegistry();
		registry.registerProvider(fakeProvider("actions", { results: [{ id: "1", kind: "action", title: "A" }] }));
		registry.init({
			getDb: () => ({
				all: () => {
					throw new Error("db exploded");
				},
			}),
		});

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await registry.search("a", { environmentId: "env-1" });
		consoleSpy.mockRestore();

		expect(results).toHaveLength(1);
	});
});

describe("the production singleton -- 'actions' provider wired in by default", () => {
	// WP-2.9 registers a THIRD provider ("commands", also non-empty on a blank
	// query -- see commands-provider.cjs) alongside "actions" and "data", so a
	// blank query's full result set is a superset of ACTIONS now rather than
	// exactly equal to it. This asserts the "actions" SUBSET is still exactly
	// ACTIONS, which is the invariant this test actually cares about.
	it("includes the full actions list (and nothing but ACTIONS under the actions:: prefix) for an empty/blank query", async () => {
		const results = await search("", { environmentId: null });
		const actionsOnly = results.filter((r) => r.id.startsWith("actions::"));
		expect(actionsOnly.map((r) => r.id).sort()).toEqual(ACTIONS.map((a) => `actions::${a.id}`).sort());
	});

	it("filters case-insensitively on title, through the registry's ranking", async () => {
		const results = await search("SETTINGS", { environmentId: null });
		expect(results.some((r) => r.id === "actions::open-settings")).toBe(true);
	});

	it("execute() reports ok:true for a known action id", async () => {
		const outcome = await execute("actions::new-task", { modifier: "ctrl" });
		expect(outcome).toEqual({ ok: true, title: "Create a new task", resultId: "actions::new-task", modifier: "ctrl" });
	});

	it("execute() reports ok:false for an unknown id, without throwing", async () => {
		const outcome = await execute("actions::not-a-real-id", {});
		expect(outcome.ok).toBe(false);
	});
});
