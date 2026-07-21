// ---------------------------------------------------------------------------
// Unsupported-platform fallback (WP-0.6).
//
// D10 (IMPLEMENTATION-PLAN.md) made Atlas Windows-only for now. This module
// is what every OS-level query resolves to on any platform that isn't
// win32 -- and the whole point of it is to be honest about that rather than
// inventing a plausible-looking value.
//
// Before this package, activity-tracker.cjs returned the literal string
// "Unknown" for a non-Windows foreground app. That is indistinguishable from
// a real window whose title genuinely is "Unknown" -- a caller (or a human
// reading activity_blocks later) has no way to tell "we don't know" from "we
// know, and the answer is the word Unknown". Every method here instead
// returns an explicit `{ supported: false, ... }` shape, so callers have to
// branch on `supported` rather than silently treating a placeholder as data.
// See activity-tracker.cjs's tick() for the pattern this enables: it checks
// `appInfo.supported` before touching processName/label at all, and neither
// fabricates an app name nor writes a bogus activity block when it's false.
//
// When a macOS implementation (darwin.cjs) is eventually written, only
// index.cjs's selection needs to change -- nothing here.
// ---------------------------------------------------------------------------

"use strict";

const PLATFORM = "unsupported";

async function getForegroundWindow() {
	return { supported: false };
}

async function listRunningApps() {
	return { supported: false, apps: [] };
}

async function listInstalledApps() {
	return { supported: false, apps: [] };
}

async function getSystemStats() {
	return { supported: false, cpuPercent: null, memoryPercent: null };
}

async function launch() {
	return { supported: false, launched: false };
}

// There is no known set of "shell process" names on a platform we have no
// implementation for, so there is nothing to correctly ignore -- this is
// never actually reached in practice, since activity-tracker.cjs's tick()
// returns before calling it whenever getForegroundWindow() reports
// `supported: false`, but it exists so the shape of this module matches
// win32.cjs's.
function isIgnoredProcessName() {
	return false;
}

module.exports = {
	PLATFORM,
	getForegroundWindow,
	listRunningApps,
	listInstalledApps,
	getSystemStats,
	launch,
	isIgnoredProcessName,
};
