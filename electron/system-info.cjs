// ---------------------------------------------------------------------------
// System info (WP-0.6).
//
// Thin wrapper around the platform adapter (electron/platform/index.cjs).
// The real logic -- CPU/memory sampling and the visible-window enumeration --
// moved to electron/platform/win32.cjs essentially unchanged; this file's job
// is now just to unwrap the adapter's `{ supported, ... }` result into the
// plain shapes main.cjs's IPC handlers have always returned to the renderer,
// so this is a zero-behaviour-change refactor on Windows (the only platform
// Atlas ships on today, per D10).
//
// Both functions handle `supported: false` explicitly rather than letting it
// leak through as `undefined` fields -- there is currently no renderer UI for
// "stats aren't available on this platform", so the fallback is the most
// neutral value each shape can hold (an empty list, zeroed stats), not a
// fabricated reading.
// ---------------------------------------------------------------------------

"use strict";

const platform = require("./platform/index.cjs");

async function getSystemStats() {
	const result = await platform.getSystemStats();
	if (!result.supported) {
		return { cpuPercent: 0, memoryPercent: 0 };
	}
	return { cpuPercent: result.cpuPercent, memoryPercent: result.memoryPercent };
}

async function listOpenApps() {
	const result = await platform.listRunningApps();
	if (!result.supported) {
		return [];
	}
	return result.apps;
}

module.exports = { getSystemStats, listOpenApps };
