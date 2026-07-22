"use strict";

// ---------------------------------------------------------------------------
// Launcher result provider REGISTRY (WP-2.2).
//
// This package is what electron/main.cjs requires in place of the old,
// single-file electron/services/launcher-providers.cjs stub (WP-2.1) --
// same two-function public shape (`search(query, context)` and
// `execute(resultId, options)`), so electron/ipc/launcher.cjs, the preload
// bridge, and every renderer file downstream of it (LauncherWindowApp.tsx,
// launcherResults.ts) needed NO changes at all. Only main.cjs's require path
// and one new boot-time `init()` call (handing this registry a way to reach
// the database and event log lazily) changed.
//
// -- The provider interface -------------------------------------------------
//
// Every provider is a plain object:
//
//   /**
//    * @typedef {Object} LauncherProviderResult
//    * @property {string} id        Unique WITHIN this provider only -- the
//    *   registry namespaces it (`${provider.name}::${id}`) before it ever
//    *   reaches ipc/launcher.cjs, so two providers can both use "1" and
//    *   never collide.
//    * @property {string} kind      "action" | "task" | "note" | "app" |
//    *   "file" | ... -- deliberately open-ended; src/types.ts's
//    *   LauncherResult.kind is a plain `string` for exactly this reason.
//    * @property {string} title
//    * @property {string} [subtitle]
//    * @property {string} [icon]    Optional icon identifier for the renderer.
//    *
//    * @typedef {Object} LauncherProviderExecuteResult
//    * @property {boolean} ok
//    * @property {*} [...]          Any provider-specific extra fields (e.g.
//    *   `title`) -- the registry always overlays its own `resultId` and
//    *   `modifier` on top before returning, so a provider can't accidentally
//    *   desync those from what was actually requested.
//    *
//    * @typedef {Object} LauncherSearchContext
//    * @property {string|null} environmentId  Threaded straight from
//    *   ipc/launcher.cjs's `getCurrentEnvironmentId()` -- every provider
//    *   MUST scope its own search by this (through electron/data/scoped.cjs
//    *   for anything backed by the database), and frecency below is scoped
//    *   by it too, so a result hammered in one environment is never
//    *   promoted in another.
//    * @property {number} now                 `Date.now()`, captured once per
//    *   search() call so every provider (and the ranking pass) agrees on
//    *   "the current moment" instead of drifting across async awaits.
//    * @property {(() => import("../../db.cjs").AtlasDatabase|null)} getDb
//    *   Getter, not a value -- mirrors every ipc/*.cjs module's `getDb`
//    *   convention, since the db handle is created after this module is
//    *   required (see init() below).
//    * @property {(() => import("../event-log.cjs").EventLog|null)} getEventLog
//    *
//    * @typedef {Object} LauncherProvider
//    * @property {string} name      Stable, unique registry key -- also what
//    *   `execute()` dispatches results back to.
//    * @property {(query: string, context: LauncherSearchContext) =>
//    *   (LauncherProviderResult[] | Promise<LauncherProviderResult[]>)} search
//    * @property {(result: LauncherProviderResult, options: {environmentId:
//    *   string|null, modifier: string|null}) =>
//    *   (LauncherProviderExecuteResult | Promise<LauncherProviderExecuteResult>)} execute
//    * @property {number} [timeoutMs]  Per-provider override of
//    *   DEFAULT_PROVIDER_TIMEOUT_MS below.
//    */
//
// -- Adding a provider (WP-2.3+) ---------------------------------------------
//
// ONE new file (e.g. tasks-provider.cjs) implementing the shape above, plus
// ONE line at the bottom of this file (`registerProvider(require("./tasks-
// provider.cjs"))`). Nothing in electron/ipc/launcher.cjs, electron/main.cjs,
// the preload bridge, or any renderer file changes -- that is the whole
// point of this package existing as the seam it is.
//
// -- Parallel search with per-provider timeout -------------------------------
//
// `search()` runs every registered provider concurrently via
// `Promise.allSettled` (never `Promise.all`, which would let one rejection
// abort every other still-pending provider) with each wrapped in its own
// timeout race. A provider that throws, rejects, or simply takes longer than
// its budget is DROPPED -- logged, not retried, not allowed to delay or
// break the rest of the list. DEFAULT_PROVIDER_TIMEOUT_MS (200ms) sits in the
// WP's own suggested 150-250ms range; a provider can override it per-instance
// via its own `timeoutMs` field for something it knows is slower (e.g. a
// cold-cache file index).
//
// -- Execute routing ----------------------------------------------------------
//
// ipc/launcher.cjs's `execute(resultId, options)` only ever gets a bare
// string id back from the renderer (whatever `search()` returned it earlier)
// -- there is no "full result object" available at that point unless
// something remembers it. This registry does exactly that: every result
// `search()` returns is stashed (by its namespaced id) in a small bounded
// cache as it's produced, so a same-session `execute()` call can hand the
// owning provider back its own original, unprefixed result object. If the
// cache has already evicted it (capacity) or a stale/foreign id arrives, the
// registry falls back to parsing the provider name out of the id's own
// `name::` prefix and calls execute() with a minimal `{ id }` stub instead of
// failing outright -- "routes back correctly" degrades gracefully rather
// than throwing.
// ---------------------------------------------------------------------------

const { rankResults } = require("./ranking.cjs");
const { countEventsBySubject } = require("../event-log.cjs");

const DEFAULT_PROVIDER_TIMEOUT_MS = 200;
const FRECENCY_EVENT_TYPE = "launcher.execute";
// Bounded so a long session issuing thousands of keystroke-driven queries
// can't grow this into an unbounded memory leak -- old entries are evicted
// in insertion order (a plain Map's iteration order) once the cap is hit,
// which is enough for "resolve a result from the last few queries", the only
// thing this cache exists for.
const MAX_CACHED_RESULTS = 500;

function splitCompositeId(id) {
	if (typeof id !== "string") {
		return null;
	}
	const separatorIndex = id.indexOf("::");
	if (separatorIndex <= 0) {
		return null;
	}
	return { providerName: id.slice(0, separatorIndex), localId: id.slice(separatorIndex + 2) };
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		if (timer && typeof timer.unref === "function") {
			timer.unref();
		}
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A fresh, independent registry -- the production singleton below is exactly
// one instance of this; tests build their own so registering a fake provider
// in one test can never leak into another.
function createLauncherProviderRegistry() {
	const providers = [];
	const resultCache = new Map();
	let getDb = () => null;
	let getEventLog = () => null;

	// Called once at boot (electron/main.cjs, after `db`/`eventLog` exist) --
	// see this file's header for why these are getters, not values: both are
	// `let`s reassigned after this module is first required.
	function init(deps = {}) {
		if (typeof deps.getDb === "function") {
			getDb = deps.getDb;
		}
		if (typeof deps.getEventLog === "function") {
			getEventLog = deps.getEventLog;
		}
	}

	function registerProvider(provider) {
		if (!provider || typeof provider.name !== "string" || !provider.name.trim()) {
			throw new Error("registerProvider() requires a provider object with a non-empty string `name`.");
		}
		if (typeof provider.search !== "function" || typeof provider.execute !== "function") {
			throw new Error(`Provider "${provider.name}" must implement both search() and execute().`);
		}
		if (providers.some((existing) => existing.name === provider.name)) {
			throw new Error(`A provider named "${provider.name}" is already registered.`);
		}
		providers.push(provider);
	}

	// Test/inspection seam -- never used for routing decisions.
	function listProviders() {
		return providers.slice();
	}

	function cacheResult(providerName, namespacedId, localResult) {
		resultCache.set(namespacedId, { providerName, localResult });
		if (resultCache.size > MAX_CACHED_RESULTS) {
			const oldestKey = resultCache.keys().next().value;
			resultCache.delete(oldestKey);
		}
	}

	// One indexed GROUP BY query (see event-log.cjs#countEventsBySubject),
	// never a per-result query in a loop. Scoped to `environmentId` so
	// frecency is strictly per-environment, per the WP-0.8 isolation model --
	// an id hammered in one environment never leaks a promotion into another.
	// Any failure here (a missing db, a query error) degrades to "rank by
	// match quality only" rather than breaking the search.
	function loadFrecency(environmentId) {
		const db = getDb();
		if (!db || !environmentId) {
			return new Map();
		}
		try {
			const rows = countEventsBySubject(db, FRECENCY_EVENT_TYPE, environmentId);
			return new Map(rows.map((row) => [row.subject, { count: row.count, lastTs: row.lastTs }]));
		} catch (error) {
			console.error("[Atlas] launcher frecency lookup failed (ranking by match quality only):", error);
			return new Map();
		}
	}

	async function search(query, context = {}) {
		const environmentId = context.environmentId ?? null;
		const richContext = {
			environmentId,
			now: Date.now(),
			getDb,
			getEventLog,
		};

		const settled = await Promise.allSettled(
			providers.map((provider) => {
				const timeoutMs = Number.isFinite(provider.timeoutMs) ? provider.timeoutMs : DEFAULT_PROVIDER_TIMEOUT_MS;
				return withTimeout(
					Promise.resolve().then(() => provider.search(query, richContext)),
					timeoutMs,
					`launcher provider "${provider.name}"`,
				);
			}),
		);

		const merged = [];
		settled.forEach((outcome, index) => {
			const provider = providers[index];
			if (outcome.status !== "fulfilled") {
				// Dropped, not rethrown: one hung/broken provider must never take
				// the rest of the list down with it.
				console.error(`[Atlas] launcher provider "${provider.name}" dropped:`, outcome.reason);
				return;
			}
			const rawResults = Array.isArray(outcome.value) ? outcome.value : [];
			for (const raw of rawResults) {
				if (!raw || typeof raw.id !== "string" || !raw.id) {
					continue; // malformed result from a provider -- drop it, not the whole list
				}
				const namespacedId = `${provider.name}::${raw.id}`;
				const result = { ...raw, id: namespacedId, providerName: provider.name };
				cacheResult(provider.name, namespacedId, raw);
				merged.push(result);
			}
		});

		const frecencyByResultId = loadFrecency(environmentId);
		return rankResults(merged, { query, frecencyByResultId, now: richContext.now });
	}

	async function execute(resultId, options = {}) {
		const modifier = options.modifier ?? null;
		const cached = resultCache.get(resultId);
		const split = splitCompositeId(resultId);
		const providerName = cached?.providerName ?? split?.providerName ?? null;
		const provider = providers.find((entry) => entry.name === providerName);

		if (!provider) {
			return { ok: false, resultId, modifier, error: "Unknown launcher result (no owning provider)." };
		}

		const target = cached?.localResult ?? { id: split?.localId ?? resultId };

		try {
			const outcome = (await provider.execute(target, options)) ?? {};
			return { ...outcome, ok: Boolean(outcome.ok), resultId, modifier };
		} catch (error) {
			console.error(`[Atlas] launcher provider "${provider.name}" execute() failed:`, error);
			return { ok: false, resultId, modifier, error: "Provider execute() failed." };
		}
	}

	return { init, registerProvider, listProviders, search, execute };
}

// The production singleton -- everything electron/main.cjs and
// electron/ipc/launcher.cjs actually use.
const registry = createLauncherProviderRegistry();
registry.registerProvider(require("./actions-provider.cjs"));

module.exports = {
	// Exposed so tests (and, if ever needed, a future WP) can build an
	// isolated registry instead of sharing the production singleton's state.
	createLauncherProviderRegistry,
	init: registry.init,
	registerProvider: registry.registerProvider,
	listProviders: registry.listProviders,
	search: registry.search,
	execute: registry.execute,
	DEFAULT_PROVIDER_TIMEOUT_MS,
};
