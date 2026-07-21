// ---------------------------------------------------------------------------
// Platform adapter (WP-0.6).
//
// One interface for every OS-level query Atlas needs: what's focused, what's
// running, what's installed, how loaded the machine is, and launching a
// program. Before this package, OS access was an inline PowerShell string
// living inside activity-tracker.cjs, with system-info.cjs and main.cjs each
// growing their own copy of the same pattern. Every later package -- the
// launcher, the app index, the file indexer, context detection -- needs the
// same access; this file exists so none of them grow a fourth, fifth, sixth
// copy of that same OS-shell-spawn pattern of their own.
//
// D10 made this Windows-only for now: `win32.cjs` is the only real
// implementation, and `unsupported.cjs` is what every other platform gets --
// an honest `{ supported: false }`, never fabricated data. Adding macOS later
// means writing one `darwin.cjs` against this same five-method interface and
// adding one line to `selectImplementation` below -- not unpicking
// PowerShell calls scattered through feature code.
//
// `selectImplementation` is exported (and pure) specifically so it can be
// unit-tested against arbitrary `process.platform` values without needing to
// stub the real global and reload this module.
// ---------------------------------------------------------------------------

"use strict";

const win32 = require("./win32.cjs");
const unsupported = require("./unsupported.cjs");

function selectImplementation(platform) {
	return platform === "win32" ? win32 : unsupported;
}

const impl = selectImplementation(process.platform);

module.exports = {
	// getForegroundWindow() -> Promise<
	//   | { supported: true, processName: string, title: string, label: string }
	//   | { supported: false }
	// >
	// `processName` is the coarse process identity (e.g. "chrome", "Code").
	// `label` prefers the window title when one is present -- it is the
	// display name, not an identity, and callers that write to any
	// long-lived or shared log (the event log, WP-0.5) must use
	// `processName`, never `label`: window titles can contain arbitrary
	// user content.
	getForegroundWindow: (...args) => impl.getForegroundWindow(...args),

	// listRunningApps() -> Promise<
	//   | { supported: true, apps: Array<{ name: string, path: string | null }> }
	//   | { supported: false, apps: [] }
	// >
	// One entry per running process that owns a visible top-level window.
	listRunningApps: (...args) => impl.listRunningApps(...args),

	// listInstalledApps() -> Promise<
	//   | { supported: true, apps: Array<{ name: string, path: string | null }> }
	//   | { supported: false, apps: [] }
	// >
	// Not consumed by anything yet -- added so the interface is complete for
	// the launcher/app-index work (WP-2.x) that depends on this package.
	listInstalledApps: (...args) => impl.listInstalledApps(...args),

	// getSystemStats() -> Promise<
	//   | { supported: true, cpuPercent: number, memoryPercent: number }
	//   | { supported: false, cpuPercent: null, memoryPercent: null }
	// >
	getSystemStats: (...args) => impl.getSystemStats(...args),

	// launch(command: string) -> Promise<
	//   | { supported: true, launched: true }
	//   | { supported: false, launched: false }
	// >
	// Fire-and-forget: resolves once the process has been asked to start, not
	// once it has actually started successfully.
	launch: (...args) => impl.launch(...args),

	// isIgnoredProcessName(processName: string) -> boolean
	// Not part of the "OS query" interface above -- see win32.cjs for why
	// this lives beside it rather than being a pure tracking-policy constant.
	isIgnoredProcessName: (...args) => impl.isIgnoredProcessName(...args),

	// Exposed for tests and for anything that wants to know which
	// implementation is actually active without inferring it from behaviour.
	selectImplementation,
	PLATFORM: impl.PLATFORM,
};
