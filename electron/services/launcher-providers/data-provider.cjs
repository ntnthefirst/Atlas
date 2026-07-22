"use strict";

// ---------------------------------------------------------------------------
// The "data" provider (WP-2.3) -- searches everything Atlas already knows
// straight from SQLite: tasks, notes, sessions, and environments themselves.
// The first provider registered after "actions" (WP-2.2's fixed list) and the
// first one that reads the database and can ACT on execute() (open a result
// in the main window) rather than just report whether an id was known -- see
// index.cjs's header for the execute(result, options, context) contract this
// relies on.
//
// -- Scenes are NOT covered here -----------------------------------------
// A "scene" (src/scenes.ts) is not a row of its own: it is a JSON blob living
// inside ONE particular "scene" widget's `config` string, inside a Notch
// layout's `data` document (electron/migrations/006_notch_layouts.cjs),
// which itself is very often the ONE global-default layout shared by every
// environment that hasn't overridden it (electron/config/notch-layouts.cjs).
// There is no `scenes` table, no scene id independent of "whichever widget
// slot it happens to sit in right now", and running one is not a navigation
// at all -- src/components/notch/NotchApp.tsx#runScene switches environment,
// starts/stops the timer, creates tasks, and launches apps/URLs, entirely in
// the renderer, with no main-process entry point to call into. Reaching into
// the layout JSON to list scene widgets would be possible; actually EXECUTING
// one from here would mean reimplementing that whole renderer-side pipeline
// (app launching, URL opening, task creation, timer control) a second time in
// the main process, which is a materially different (and much larger) feature
// than "open the thing you searched for". Left out deliberately rather than
// fabricated -- see this WP's final report for the full reasoning.
//
// -- Environment scoping ------------------------------------------------
// Tasks, notes, and sessions are read exclusively through
// electron/data/scoped.cjs, bound to `context.environmentId` -- the SAME
// scoping seam every IPC handler in electron/ipc/*.cjs already goes through.
// This provider never accepts or derives a different environment id for a
// search; there is no cross-environment lookup here at all (unlike
// scoped.cjs's own allowlisted dashboard aggregate), so an enclosed
// environment's tasks/notes/sessions are exactly as unreachable from a
// search run in another environment as they already are from everywhere
// else. Environments themselves are the one exception: switching TO an
// environment is not gated by isolation mode (only what an environment can
// read/aggregate FROM another one is), so every non-archived environment is
// always searchable here, exactly like the existing environment switcher
// already lists every one of them regardless of the current environment's
// mode.
//
// -- Query cost -----------------------------------------------------------
// Four call sites, four queries, every one already indexed:
//   - scope.tasks.list()      -> one SELECT on tasks(environment_id)
//   - scope.notes.getNotebook() -> one SELECT on notes(environment_id),
//     returning the environment's single notebook document; matching happens
//     against its (already in-memory, already small) parsed `nodes` array,
//     not a second query per node.
//   - scope.sessions.list()   -> one SELECT on sessions(environment_id)
//   - db.listEnvironments()   -> one SELECT (tiny table, no per-environment
//     filter to index)
// Migration 008 adds the environment_id indexes the first three rely on --
// none of them had one before this WP. No N+1 loop over entities anywhere in
// this file.
// ---------------------------------------------------------------------------

const { scoped } = require("../../data/scoped.cjs");

// Per-entity-type cap on how many matches a single query surfaces. This is a
// "good default suggestions" list, not an exhaustive search results page --
// keeping it small keeps the merged, ranked list (across every provider)
// readable, and keeps the per-provider timeout budget (index.cjs's
// DEFAULT_PROVIDER_TIMEOUT_MS) comfortable even against an environment with a
// very large board.
const MAX_RESULTS_PER_KIND = 8;

// How much of a matched note's text becomes its title -- long enough to be
// recognizable, short enough to still read as a launcher result rather than
// a paragraph.
const NOTE_SNIPPET_LENGTH = 60;

// Which top-level view (src/types.ts's AtlasView) each openable kind lives
// on. Deliberately the ONLY navigation vocabulary this provider uses -- see
// this file's header and the WP's final report for why a specific task/note/
// session can't be deep-linked any further than its view: window:navigate-
// changed (electron/ipc/windows.cjs) carries a bare AtlasView string, nothing
// more specific, and inventing a second, richer channel alongside it is
// exactly the "parallel mechanism" this WP was told not to build.
const VIEW_BY_KIND = Object.freeze({
	task: "tasks",
	note: "notes",
	session: "activity",
});

function normalizeQuery(query) {
	return typeof query === "string" ? query.trim().toLowerCase() : "";
}

function includesNeedle(text, needle) {
	return typeof text === "string" && text.toLowerCase().includes(needle);
}

function snippet(text, length = NOTE_SNIPPET_LENGTH) {
	const collapsed = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
	if (!collapsed) {
		return "Untitled note";
	}
	return collapsed.length > length ? `${collapsed.slice(0, length - 1)}…` : collapsed;
}

// -- Tasks --------------------------------------------------------------

function matchesTask(task, needle) {
	if (!needle) {
		return true;
	}
	if (includesNeedle(task.title, needle) || includesNeedle(task.description, needle)) {
		return true;
	}
	return Array.isArray(task.tags) && task.tags.some((tag) => includesNeedle(tag, needle));
}

function searchTasks(db, environmentId, needle) {
	const tasks = scoped(db, environmentId).tasks.list(); // one indexed SELECT
	return tasks
		.filter((task) => matchesTask(task, needle))
		.slice(0, MAX_RESULTS_PER_KIND)
		.map((task) => ({
			id: `task:${environmentId}:${task.id}`,
			kind: "task",
			title: task.title,
			subtitle: task.due_date ? `Task · due ${task.due_date}` : "Task",
		}));
}

// -- Notes (per-environment notebook canvas) -----------------------------
//
// A "note" isn't its own row -- db.cjs's `notes` table holds exactly ONE
// canvas document per environment (see db.cjs#getNotebookByEnvironment), a
// JSON blob of positioned `nodes` (text / sticky / media, src/types.ts's
// NotebookNode). Search treats each matching NODE as one result -- a much
// more useful grain than "you have a notebook, here it is" -- parsed from the
// single already-fetched document, never a query per node.

function parseNotebookNodes(content) {
	try {
		const parsed = JSON.parse(content);
		return Array.isArray(parsed?.nodes) ? parsed.nodes : [];
	} catch {
		return [];
	}
}

function nodeSearchText(node) {
	if (typeof node?.text === "string" && node.text.trim()) {
		return node.text;
	}
	if (typeof node?.name === "string" && node.name.trim()) {
		return node.name;
	}
	return "";
}

function nodeSubtitle(node) {
	if (node?.type === "postit") {
		return "Sticky note";
	}
	if (node?.type === "media") {
		return "Note attachment";
	}
	return "Note";
}

function searchNotes(db, environmentId, needle) {
	const notebook = scoped(db, environmentId).notes.getNotebook(); // one indexed SELECT
	const nodes = parseNotebookNodes(notebook?.content);

	const matched = [];
	for (const node of nodes) {
		if (!node || typeof node.id !== "string") {
			continue; // malformed node -- skip rather than crash the whole search
		}
		const text = nodeSearchText(node);
		if (needle ? includesNeedle(text, needle) : Boolean(text)) {
			matched.push({ node, text });
		}
		if (matched.length >= MAX_RESULTS_PER_KIND) {
			break;
		}
	}

	return matched.map(({ node, text }) => ({
		id: `note:${environmentId}:${node.id}`,
		kind: "note",
		title: snippet(text),
		subtitle: nodeSubtitle(node),
	}));
}

// -- Sessions -------------------------------------------------------------
//
// Sessions carry no title of their own (electron/migrations/001_initial.cjs)
// -- formatted here from their start date and duration/status, which is also
// what they're matched against (so typing e.g. "paused" or a weekday surfaces
// them, without fabricating a name the product doesn't actually have).

function formatSessionTitle(session) {
	const started = new Date(session.started_at);
	if (Number.isNaN(started.getTime())) {
		return "Session";
	}
	const dateLabel = started.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
	return `Session · ${dateLabel}`;
}

function formatDurationLabel(durationMs) {
	const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function sessionSubtitle(session) {
	if (session.is_active) {
		return session.is_paused ? "Paused" : "Active now";
	}
	return `Duration ${formatDurationLabel(session.total_duration)}`;
}

function searchSessions(db, environmentId, needle) {
	const sessions = scoped(db, environmentId).sessions.list(); // one indexed SELECT
	const matched = [];
	for (const session of sessions) {
		const title = formatSessionTitle(session);
		const subtitle = sessionSubtitle(session);
		const searchText = `${title} ${subtitle}`;
		if (needle ? includesNeedle(searchText, needle) : true) {
			matched.push({ session, title, subtitle });
		}
		if (matched.length >= MAX_RESULTS_PER_KIND) {
			break;
		}
	}

	return matched.map(({ session, title, subtitle }) => ({
		id: `session:${environmentId}:${session.id}`,
		kind: "session",
		title,
		subtitle,
	}));
}

// -- Environments -----------------------------------------------------------
//
// Not scoped by `environmentId` -- these ARE the scopes. See this file's
// header for why listing every one of them here mirrors the existing
// environment switcher rather than crossing the WP-0.8 boundary.

function searchEnvironments(db, needle) {
	const environments = db.listEnvironments(); // one SELECT, small table
	return environments
		.filter((environment) => (needle ? includesNeedle(environment.name, needle) : true))
		.slice(0, MAX_RESULTS_PER_KIND)
		.map((environment) => ({
			id: `environment:${environment.id}`,
			kind: "environment",
			title: environment.name,
			subtitle: "Switch environment",
		}));
}

// -- search() -------------------------------------------------------------

function search(query, context = {}) {
	const db = context.getDb?.();
	if (!db) {
		return [];
	}

	const needle = normalizeQuery(query);
	const environmentId = context.environmentId ?? null;

	const results = searchEnvironments(db, needle);
	// Tasks/notes/sessions need a bound environment to scope through --
	// nothing to search (and nothing to leak) without one, e.g. at the
	// welcome screen before any environment has ever been chosen.
	if (environmentId) {
		results.push(...searchTasks(db, environmentId, needle));
		results.push(...searchNotes(db, environmentId, needle));
		results.push(...searchSessions(db, environmentId, needle));
	}
	return results;
}

// -- execute() --------------------------------------------------------------

// Local ids are self-describing (`<kind>:<environmentId>:<entityId>`, or
// `environment:<environmentId>` for an environment itself) so a cache-miss
// fallback -- index.cjs hands execute() a bare `{ id }` stub when it no
// longer has the original search() result cached -- still carries everything
// needed to open the right thing, with no second lookup.
function parseLocalId(id) {
	if (typeof id !== "string") {
		return null;
	}
	const [kind, ...rest] = id.split(":");
	if (kind === "environment" && rest.length === 1 && rest[0]) {
		return { kind, environmentId: rest[0] };
	}
	if ((kind === "task" || kind === "note" || kind === "session") && rest.length === 2 && rest[0] && rest[1]) {
		return { kind, environmentId: rest[0], entityId: rest[1] };
	}
	return null;
}

// `context` is the registry's enriched execute context (index.cjs) -- the
// getMainWindow/showMainWindow/navigate/switchEnvironment quartet that lets a
// provider actually DO something on execute, not just report an id was
// known. `navigate(view)` reuses the exact same "show the main window, then
// tell it which view to land on" pair as the existing `window:navigate` IPC
// channel (electron/ipc/windows.cjs) -- see main.cjs's `navigateMainWindow`.
function execute(result, options = {}, context = {}) {
	const parsed = parseLocalId(result?.id);
	if (!parsed) {
		return { ok: false, error: "Unknown launcher result." };
	}

	if (parsed.kind === "environment") {
		context.switchEnvironment?.(parsed.environmentId);
		const navigated = context.navigate?.("dashboard") ?? false;
		return { ok: Boolean(navigated), title: result?.title ?? null };
	}

	const view = VIEW_BY_KIND[parsed.kind];
	if (!view) {
		return { ok: false, error: "Unknown launcher result kind." };
	}

	// Defensive re-scoping: the environment active right now (options.
	// environmentId, threaded fresh from getCurrentEnvironmentId() on every
	// launcher:execute call) might no longer match the environment this
	// result was found in, if the user switched between querying and
	// executing. Switch first so the view we're about to open actually shows
	// the right environment's data, rather than silently landing on whatever
	// happens to be active.
	const activeEnvironmentId = options?.environmentId ?? null;
	if (parsed.environmentId && parsed.environmentId !== activeEnvironmentId) {
		context.switchEnvironment?.(parsed.environmentId);
	}

	const navigated = context.navigate?.(view) ?? false;
	return { ok: Boolean(navigated), title: result?.title ?? null };
}

module.exports = {
	name: "data",
	search,
	execute,
	// Exposed for unit tests only -- not part of the provider interface.
	parseLocalId,
};
