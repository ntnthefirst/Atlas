"use strict";

// ---------------------------------------------------------------------------
// Launcher result providers -- TEMPORARY STUB (WP-2.1).
//
// This is the ONE seam WP-2.2 (and later provider work) swaps out. `search`
// and `execute` below are the only two exports electron/ipc/launcher.cjs
// calls -- everything else in this package (the pre-created window, the
// rebindable hotkey, the IPC glue, the renderer's keyboard handling and
// stable-ordering logic) is provider-agnostic. It doesn't know or care that
// results currently come from a fixed in-memory list instead of the task
// store, the file index, installed apps, etc.
//
// To swap in real providers, WP-2.2 replaces the body of `search`/`execute`
// here (or points main.cjs at a different module with the same two-function
// shape when it wires `deps.search`/`deps.execute` into
// electron/ipc/launcher.cjs -- see main.cjs's `wireIpc()`). Nothing else --
// the window, the hotkey, the preload bridge, the renderer -- needs to
// change.
//
// `search(query, context)` may return an array OR a promise of one (a real
// provider will genuinely need to await a DB/file-system/index query); the
// stub returns synchronously since filtering an in-memory array needs
// nothing to await. `context.environmentId` is threaded through now (even
// though the stub ignores it) so a real, environment-scoped provider in
// WP-2.2 doesn't require a signature change.
// ---------------------------------------------------------------------------

// Deliberately small and fixed -- just enough to exercise the input surface
// and result-list shell end to end. Every entry is a plain "action" stub;
// real kinds (task, note, app, file, ...) arrive with their real providers.
const STUB_RESULTS = [
	{ id: "stub-new-task", kind: "action", title: "Create a new task", subtitle: "Quick capture" },
	{ id: "stub-new-note", kind: "action", title: "Create a new note", subtitle: "Quick capture" },
	{ id: "stub-open-settings", kind: "action", title: "Open Settings", subtitle: "Atlas" },
	{ id: "stub-open-dashboard", kind: "action", title: "Open Dashboard", subtitle: "Atlas" },
	{ id: "stub-start-focus", kind: "action", title: "Start a focus session", subtitle: "Focus" },
	{ id: "stub-switch-environment", kind: "action", title: "Switch environment", subtitle: "Atlas" },
	{ id: "stub-toggle-notch", kind: "action", title: "Toggle Smart Notch", subtitle: "Notch" },
	{ id: "stub-open-mini", kind: "action", title: "Open mini player", subtitle: "Atlas" },
];

function matches(result, needle) {
	return (
		result.title.toLowerCase().includes(needle) ||
		(result.subtitle ? result.subtitle.toLowerCase().includes(needle) : false)
	);
}

// Synchronous today (a stub over a fixed array); the return type is still
// treated as "awaitable" by the caller so a real, genuinely-async provider
// slots in later without touching ipc/launcher.cjs.
function search(query) {
	const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (!needle) {
		return STUB_RESULTS.slice();
	}
	return STUB_RESULTS.filter((result) => matches(result, needle));
}

// Stub execution: there is nothing real to do yet (no providers), so this
// just reports whether the id was one of the known stub results and echoes
// back which modifier (if any) was used to invoke it -- exactly the shape a
// real executor will need to return (`{ ok, resultId, modifier }`), so the
// renderer/IPC layer built against this stub doesn't change shape later.
function execute(resultId, options = {}) {
	const result = STUB_RESULTS.find((entry) => entry.id === resultId);
	return {
		ok: Boolean(result),
		resultId,
		title: result?.title ?? null,
		modifier: options.modifier ?? null,
	};
}

module.exports = { search, execute, STUB_RESULTS };
