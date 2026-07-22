"use strict";

// ---------------------------------------------------------------------------
// The "apps" provider (WP-2.4) -- launch any installed Windows application by
// typing its name.
//
// -- Not environment-scoped ---------------------------------------------
// Unlike "data" (per-environment content, WP-2.3) and "commands" (built-in
// Atlas verbs that read/write the active environment's data, WP-2.9),
// installed apps are a SYSTEM resource: the same list exists no matter which
// environment is active. search() below deliberately never reads
// `context.environmentId` -- there is nothing to scope by. Frecency-based
// ranking still applies automatically through the registry's own ranking
// pass (index.cjs's loadFrecency()), which IS scoped per environment there --
// so "apps I launch a lot while in THIS environment rise to the top while
// I'm in THIS environment" falls out of the existing launcher.execute event
// log for free, with no extra bookkeeping needed in this file.
//
// -- All OS access stays behind the platform adapter -------------------
// This file never spawns PowerShell, touches the registry, or shells out
// itself (house rule for this WP) -- every bit of that lives in
// electron/platform/win32.cjs (enumeration: listInstalledApps(); launching:
// launchInstalledApp()), reached only through electron/platform/index.cjs,
// exactly like every other feature module in this codebase.
//
// -- Enumeration is slow and must never block boot -----------------------
// A PowerShell round-trip is several hundred ms (see win32.cjs's own header
// for a measured figure on a different call) -- far too slow to run
// synchronously anywhere near app.whenReady(). init() below kicks off the
// FIRST enumeration in the background (fire-and-forget: `void refresh()`,
// never awaited) and main.cjs only ever calls init() from inside its own
// app.whenReady() handler, same as everything else that boots there. Until
// that first refresh resolves, `cachedApps` is simply `[]` and search()
// returns no "app" results at all for that window -- an empty list is a
// correct, honest answer while nothing has loaded yet (this WP's own
// acceptance criterion), not a bug.
//
// -- Refresh strategy: poll, don't watch --------------------------------
// A periodic re-enumeration (REFRESH_INTERVAL_MS below) rather than an
// fs.watch() on the Start Menu directory trees. Get-StartApps -- the primary
// enumeration source (win32.cjs) -- already covers classic Start Menu
// shortcuts AND installed UWP/Store apps in one call; a filesystem watcher
// would only ever see the FIRST of those two (a newly installed UWP app
// creates no Start Menu .lnk file at all, so nothing to watch would fire for
// it), so it would need its own separate polling/registration path for UWP
// installs regardless -- at which point polling everything on one timer is
// simpler and has no missed-event/debounce-tuning failure mode to get wrong.
// An interval comfortably under a minute satisfies "appears without a
// restart" without the extra moving parts a directory watcher would add.
//
// -- Icons -----------------------------------------------------------------
// Extracted through Electron's own `app.getFileIcon` -- the exact same call
// electron/ipc/app.cjs's `app:getFileIcon` channel makes for the renderer;
// this provider calls it directly since it already runs in the main process
// (see defaultExtractIcon() below), rather than round-tripping through an
// IPC channel that only ever existed for renderer callers. Classic apps
// resolve straight from their real filesystem path (the .lnk or .exe
// Get-StartApps itself points at, which app.getFileIcon reads natively);
// UWP/Store apps have no such path (their AppID is a package identity, not a
// file), so they render with no icon rather than a fabricated one. Icons are
// extracted lazily -- only for whichever apps a query actually matched,
// never the whole cached list up front -- and memoized by path in
// `iconCache` so repeated queries for the same app never re-extract its icon
// twice.
//
// -- What's pure vs. what isn't ------------------------------------------
// matchApps()/toResult()/resolveExecuteTarget() are plain, synchronous, and
// take the app list as a parameter -- unit-tested directly against fixture
// arrays, no real enumeration or Windows shell required. attachIcons() is the
// one seam that reaches outside pure JS (an icon extractor call), and takes
// that extractor as a parameter specifically so a test can inject a fake,
// synchronous stand-in instead of Electron's real app.getFileIcon -- see
// apps-provider.test.js.
// ---------------------------------------------------------------------------

const platform = require("../../platform/index.cjs");

// A "good default suggestions" cap, same reasoning as data-provider.cjs's own
// MAX_RESULTS_PER_KIND -- keeps the merged, ranked, cross-provider list
// readable and keeps icon extraction (the one per-result cost this provider
// has) bounded to a handful of apps per query, never the whole cached list.
const MAX_RESULTS = 8;

// Comfortably under a minute -- see this file's header ("Refresh strategy").
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Module-level cache: the full enumerated list (Array<{ name, kind, appId,
// path }>, exactly win32.cjs#buildInstalledAppList's own shape), refreshed in
// the background by refresh()/init() below. Deliberately NOT behind a
// per-environment key -- see this file's header.
let cachedApps = [];
let refreshTimer = null;
let refreshInFlight = null;
// path -> data URL string | null. Never evicted: the set of installed apps
// with resolvable icons is bounded by "however many apps are installed",
// nowhere near large enough to worry about unbounded growth the way
// index.cjs's own result cache (thousands of keystrokes) has to.
const iconCache = new Map();

function normalize(text) {
	return typeof text === "string" ? text.trim().toLowerCase() : "";
}

// -- Pure matching --------------------------------------------------------
// Exported for tests: takes the app list as a parameter rather than reading
// module-level `cachedApps` directly, so a test can exercise matching logic
// against an injected fixture list with no dependency on refresh()/init()
// ever having run.
function matchApps(apps, query) {
	const needle = normalize(query);
	const list = Array.isArray(apps) ? apps : [];
	const matched = needle ? list.filter((app) => normalize(app.name).includes(needle)) : list;
	return matched.slice(0, MAX_RESULTS);
}

function subtitleFor(app) {
	return app.kind === "uwp" ? "App (Store)" : "App";
}

// Pure: one cached app -> the provider result shape, MINUS icon (see
// attachIcons() for why that part is separate). `id` is the app's own AppID
// -- stable across a refresh as long as the app itself doesn't move/reinstall
// -- namespaced by index.cjs like every other provider's id.
function toResult(app) {
	return {
		id: app.appId,
		kind: "app",
		title: app.name,
		subtitle: subtitleFor(app),
	};
}

// Pure: exactly the shape platform.launchInstalledApp() expects. Kept as its
// own function (rather than inlined into execute()) so a test can assert the
// resolved launch target without going through the registry or spawning
// anything real.
function resolveExecuteTarget(app) {
	if (!app) {
		return null;
	}
	return { kind: app.kind, path: app.path ?? null, appId: app.appId };
}

// -- Icon plumbing (the one part of this file that isn't pure) -------------
// `extractIcon(path) -> Promise<string|null>` is injected (defaulting to
// defaultExtractIcon below) so tests can supply a fake, no-Electron-required
// stand-in. A UWP app (no `path`) always gets `icon: null` -- see this file's
// header.
async function attachIcons(results, apps, extractIcon) {
	const appById = new Map(apps.map((app) => [app.appId, app]));
	return Promise.all(
		results.map(async (result) => {
			const app = appById.get(result.id);
			const path = app?.kind === "classic" ? app.path : null;
			if (!path) {
				return { ...result, icon: null };
			}
			if (iconCache.has(path)) {
				return { ...result, icon: iconCache.get(path) };
			}
			let icon = null;
			try {
				icon = await extractIcon(path);
			} catch {
				icon = null; // a single bad icon extraction must never fail the whole search
			}
			iconCache.set(path, icon ?? null);
			return { ...result, icon: icon ?? null };
		}),
	);
}

// The real extractor -- electron/ipc/app.cjs's app:getFileIcon channel does
// this exact pair of calls for the renderer's own icon requests; this is the
// main-process equivalent, called directly since this provider already runs
// there (no IPC round-trip needed or possible from inside the main process).
async function defaultExtractIcon(path) {
	const { app } = require("electron");
	const icon = await app.getFileIcon(path, { size: "normal" });
	return icon.isEmpty() ? null : icon.toDataURL();
}

// -- search() -----------------------------------------------------------
// The registry (index.cjs) only ever calls this with (query, context) -- the
// third parameter exists purely so tests can inject a fake icon extractor.
function search(query, _context, extractIcon = defaultExtractIcon) {
	const matches = matchApps(cachedApps, query);
	const results = matches.map(toResult);
	return attachIcons(results, cachedApps, extractIcon);
}

// -- execute() --------------------------------------------------------------
async function execute(result) {
	const app = cachedApps.find((entry) => entry.appId === result?.id);
	const target = resolveExecuteTarget(app);
	if (!target) {
		return { ok: false, error: "Unknown or no longer installed application." };
	}
	const outcome = await platform.launchInstalledApp(target);
	if (!outcome.supported) {
		return { ok: false, error: "Launching apps is not supported on this platform." };
	}
	return {
		ok: Boolean(outcome.launched),
		title: outcome.launched ? `Launched ${app.name}` : undefined,
		error: outcome.launched ? undefined : `Could not launch "${app.name}".`,
	};
}

// -- Background enumeration/refresh -------------------------------------
// Coalesces concurrent calls (the periodic timer firing again mid-refresh,
// say) onto the SAME in-flight promise rather than kicking off a second
// overlapping PowerShell spawn.
async function refresh() {
	if (refreshInFlight) {
		return refreshInFlight;
	}
	refreshInFlight = (async () => {
		try {
			const outcome = await platform.listInstalledApps();
			if (outcome.supported) {
				cachedApps = outcome.apps;
			}
			// `supported: false` (a non-Windows build, D10) leaves `cachedApps`
			// exactly as it was -- empty at first boot, same as before this call
			// -- rather than wiping out a previously-good list.
		} catch (error) {
			console.error("[Atlas] apps-provider enumeration failed (keeping previous cache):", error);
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

// Called once at boot (see index.cjs's registry.init(), which calls every
// registered provider's own optional init() -- WP-2.4's addition to that
// function). Fire-and-forget by design: `void refresh()` is never awaited
// here, so this function itself returns immediately and never delays
// whatever called it (main.cjs's own app.whenReady() handler, ultimately --
// see this file's header). Safe to call more than once (repeated test
// registry.init() calls, say): clears any previous timer first rather than
// stacking up a second one.
function init() {
	if (refreshTimer) {
		clearInterval(refreshTimer);
	}
	void refresh();
	refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	// Never keeps the process alive on its own -- matters for the smoke
	// scripts and any test harness that boots a real Electron process and
	// expects it to be able to exit cleanly.
	if (refreshTimer && typeof refreshTimer.unref === "function") {
		refreshTimer.unref();
	}
}

// Test-only seam: lets apps-provider.test.js seed/reset the module-level
// cache without waiting on a real (or even fake-timers-driven) refresh()
// cycle, and without reaching into this module's closure from outside it.
function _setCachedAppsForTest(apps) {
	cachedApps = Array.isArray(apps) ? apps : [];
}

function _resetForTest() {
	cachedApps = [];
	iconCache.clear();
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
	refreshInFlight = null;
}

module.exports = {
	name: "apps",
	search,
	execute,
	init,
	// Exposed for unit tests only -- not part of the LauncherProvider interface.
	matchApps,
	toResult,
	resolveExecuteTarget,
	attachIcons,
	_setCachedAppsForTest,
	_resetForTest,
};
