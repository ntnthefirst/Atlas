"use strict";

// ---------------------------------------------------------------------------
// The "files" provider (WP-2.5) -- a BASIC, FTS5-backed name search over the
// file index (electron/migrations/009_file_index.cjs, electron/services/
// file-index/{crawler,store}.cjs).
//
// -- A deliberately thin seam ------------------------------------------------
// `search()` below is nothing more than "run the query through store.cjs's
// searchFiles(), map each row to a result" -- ranking is whatever order
// files_fts's own bm25 `rank` returns (see store.cjs's header), with the
// registry's usual frecency/match-quality blend (launcher-providers/
// index.cjs's rankResults()) applied on top, exactly like every other
// provider. There is no fuzzy matching, no recency/path-depth weighting, and
// no `ext:`/`in:` filter parsing here -- WP-2.7 ("File index: ranking and
// filters") is where that belongs, and this function's narrow (query,
// environmentId) -> rows shape is the clean seam that work slots into
// without touching index.cjs, this provider's registration, or any other
// provider.
//
// -- Environment scoping ------------------------------------------------
// Delegated entirely to store.searchFiles()'s own WHERE clause -- see that
// function's header for the exact rule (a row scoped to a DIFFERENT
// environment never crosses, a row with no environment claim at all is
// visible to everyone). This provider never re-implements or duplicates that
// check.
//
// -- execute() opens the file, not a folder ----------------------------------
// Reuses electron/platform's existing `launchInstalledApp({ kind: "classic",
// path })` -- exactly the `shell.openPath` call win32.cjs already makes for a
// classic installed app's `.exe`/`.lnk` path (see that file's header) -- so
// opening a found file with its OS-registered default application shares the
// one place that logic lives, rather than growing a second file-opening code
// path here.
// ---------------------------------------------------------------------------

const platform = require("../../platform/index.cjs");
const { searchFiles } = require("../file-index/store.cjs");

// Matches apps-provider.cjs's own MAX_RESULTS -- a "good default suggestions"
// cap, not an exhaustive results page.
const MAX_RESULTS = 8;

function formatSize(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
	return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

// Pure: exported for tests. `id` is the file's own absolute path -- already
// globally unique, so there's no need to invent a second synthetic id (the
// registry namespaces it `files::<path>` regardless, see launcher-providers/
// index.cjs).
function toResult(row) {
	const size = formatSize(row.size);
	return {
		id: row.path,
		kind: "file",
		title: row.name,
		subtitle: size ? `${row.path} · ${size}` : row.path,
	};
}

function search(query, context = {}) {
	const db = context.getDb?.();
	if (!db || typeof query !== "string" || !query.trim()) {
		return [];
	}
	const rows = searchFiles(db, query, context.environmentId ?? null, MAX_RESULTS);
	return rows.map(toResult);
}

async function execute(result) {
	const filePath = result?.id;
	if (!filePath) {
		return { ok: false, error: "Unknown file." };
	}
	const outcome = await platform.launchInstalledApp({ kind: "classic", path: filePath });
	if (!outcome.supported) {
		return { ok: false, error: "Opening files is not supported on this platform." };
	}
	return {
		ok: Boolean(outcome.launched),
		error: outcome.launched ? undefined : "Could not open that file (it may have moved or been deleted).",
	};
}

module.exports = {
	name: "files",
	search,
	execute,
	// Exposed for unit tests only -- not part of the LauncherProvider interface.
	toResult,
	formatSize,
};
