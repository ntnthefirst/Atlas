"use strict";

// ---------------------------------------------------------------------------
// File index preferences: roots, exclusions, and crawl caps (WP-2.5).
//
// Pure -- no Electron, no filesystem access beyond `os.homedir()` (used only
// to compute the DEFAULT roots, exactly like every other config/*.cjs module
// keeps its schema/normalization testable under plain vitest, with the actual
// load/save/crawl mechanics living in electron/services/file-index/*.cjs,
// which are Electron- and fs-only and therefore only exercised against a real
// (or scratch-temp) userData directory.
//
// -- Shape -----------------------------------------------------------------
// `{ roots: FileIndexRoot[], exclusions: string[], maxDepth: number, maxFiles:
// number }`.
//
// `roots` is an ordered list of `{ id, label, path, environmentId, enabled }`.
// `id` is a STABLE identifier -- the default three roots below always carry
// the same `default:*` id across every normalize() call, and a user-added
// root keeps whatever id it was first given -- because `id` is exactly what
// electron/migrations/009_file_index.cjs's `files.root` column stores (see
// that migration's header): the crawler's per-root prune sweep, and this
// package's own re-normalization, both need a root's identity to survive a
// path edit or a preferences round-trip through disk.
//
// `environmentId` is nullable -- `null` means "global", exactly like
// migration 009's `files.environment_id` column: no environment claims this
// root, so every environment (connected or enclosed) can find files under it.
// A non-null value assigns the root (and therefore every file the crawler
// finds under it) to exactly one environment -- see that migration's header
// for why an environment being deleted later doesn't need this module or the
// crawler to cascade anything.
//
// -- Exclusions --------------------------------------------------------------
// Matched by plain directory NAME (case-insensitive), not by path or glob --
// see electron/services/file-index/crawl-worker.cjs's shouldExcludeName().
// DEFAULT_EXCLUSIONS covers the WP's own examples (`node_modules`, `.git`,
// `AppData`, `$Recycle.Bin`, `System Volume Information`) plus the other
// common "never worth indexing" directories a Desktop/Documents/Downloads
// crawl (or a user-added project root) is likely to contain. A user can widen
// this list from Settings; normalizeFileIndexPreferences() never re-adds
// items the user removed, only falls back to the full default list when the
// stored list is empty or missing entirely.
// ---------------------------------------------------------------------------

const os = require("node:os");
const path = require("node:path");
const { clampNumber } = require("./prefs-utils.cjs");

const FILE_INDEX_PREFS_FILE = "file-index-prefs.json";

const DEFAULT_EXCLUSIONS = Object.freeze([
	"node_modules",
	".git",
	".hg",
	".svn",
	".cache",
	"__pycache__",
	"AppData",
	"$Recycle.Bin",
	"System Volume Information",
	".venv",
	"venv",
	"dist",
	"build",
	".next",
	".turbo",
	"Windows",
	"Program Files",
	"Program Files (x86)",
	"ProgramData",
]);

// Depth is relative to a root itself (the root is depth 0); a very deep
// node_modules-free project tree rarely exceeds this. Files is a total-crawl
// safety cap (see this WP's "index size stays proportionate" acceptance
// criterion) -- crossing it truncates the CURRENT crawl run rather than
// growing the index unboundedly on a pathological tree.
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 200_000;
const MIN_MAX_DEPTH = 1;
const MAX_MAX_DEPTH = 64;
const MIN_MAX_FILES = 1_000;
const MAX_MAX_FILES = 2_000_000;

// Stable ids for the three seeded default roots -- see this file's header for
// why `id` (not `path`) is what the crawler and its prune sweep key on.
const DEFAULT_ROOT_IDS = Object.freeze({
	desktop: "default:desktop",
	documents: "default:documents",
	downloads: "default:downloads",
});

function defaultRoots(homeDir = os.homedir()) {
	return [
		{
			id: DEFAULT_ROOT_IDS.desktop,
			label: "Desktop",
			path: path.join(homeDir, "Desktop"),
			environmentId: null,
			enabled: true,
		},
		{
			id: DEFAULT_ROOT_IDS.documents,
			label: "Documents",
			path: path.join(homeDir, "Documents"),
			environmentId: null,
			enabled: true,
		},
		{
			id: DEFAULT_ROOT_IDS.downloads,
			label: "Downloads",
			path: path.join(homeDir, "Downloads"),
			environmentId: null,
			enabled: true,
		},
	];
}

function defaultFileIndexPreferences(homeDir) {
	return {
		roots: defaultRoots(homeDir),
		exclusions: [...DEFAULT_EXCLUSIONS],
		maxDepth: DEFAULT_MAX_DEPTH,
		maxFiles: DEFAULT_MAX_FILES,
	};
}

let fallbackIdCounter = 0;

// Never throws, never returns a root with a blank path -- a malformed entry
// (missing path, wrong type) is dropped rather than crashing the whole
// normalize() call; see normalizeFileIndexPreferences() below.
function normalizeRoot(raw) {
	if (!raw || typeof raw !== "object" || typeof raw.path !== "string" || !raw.path.trim()) {
		return null;
	}
	const trimmedPath = raw.path.trim();
	fallbackIdCounter += 1;
	return {
		id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `root:${Date.now()}:${fallbackIdCounter}`,
		label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : path.basename(trimmedPath) || trimmedPath,
		path: trimmedPath,
		environmentId: typeof raw.environmentId === "string" && raw.environmentId.trim() ? raw.environmentId.trim() : null,
		enabled: raw.enabled !== false,
	};
}

function normalizeFileIndexPreferences(raw, options = {}) {
	if (!raw || typeof raw !== "object") {
		return defaultFileIndexPreferences(options.homeDir);
	}

	const rootsInput = Array.isArray(raw.roots) ? raw.roots : defaultRoots(options.homeDir);
	const seenIds = new Set();
	const roots = [];
	for (const entry of rootsInput) {
		const normalized = normalizeRoot(entry);
		if (!normalized || seenIds.has(normalized.id)) {
			continue; // malformed or duplicate id -- drop rather than crash/collide
		}
		seenIds.add(normalized.id);
		roots.push(normalized);
	}

	const exclusionsInput = Array.isArray(raw.exclusions)
		? [...new Set(raw.exclusions.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
		: [];

	return {
		roots,
		exclusions: exclusionsInput.length > 0 ? exclusionsInput : [...DEFAULT_EXCLUSIONS],
		maxDepth: clampNumber(raw.maxDepth, DEFAULT_MAX_DEPTH, MIN_MAX_DEPTH, MAX_MAX_DEPTH),
		maxFiles: clampNumber(raw.maxFiles, DEFAULT_MAX_FILES, MIN_MAX_FILES, MAX_MAX_FILES),
	};
}

module.exports = {
	FILE_INDEX_PREFS_FILE,
	DEFAULT_EXCLUSIONS,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_FILES,
	DEFAULT_ROOT_IDS,
	defaultRoots,
	defaultFileIndexPreferences,
	normalizeFileIndexPreferences,
};
