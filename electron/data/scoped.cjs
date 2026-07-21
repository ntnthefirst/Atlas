// ---------------------------------------------------------------------------
// The scoped data accessor (WP-0.8) — the one seam every IPC handler must go
// through to touch tasks, notes, sessions, activity blocks, or events. This
// is the plumbing half of the isolation model; electron/data/isolation.cjs
// is the policy half (the two modes, the allowlist, the one decision
// function). Keeping them apart means the policy can be unit-tested as pure
// data, while this module stays about wiring queries up correctly.
//
// `scoped(db, environmentId)` returns an object bound to exactly one
// environment. Every list/create call on it is constrained by construction
// (`WHERE environment_id = ?`, same as the pre-WP-0.8 db.cjs methods it
// wraps — no query here is new, this package's job is to make bypassing the
// constraint impossible, not to change what the constraint is). Every
// operation that takes a bare row id (update/delete/pause/resume/stop) re-
// checks that the row actually belongs to this scope's environment before
// touching it, and fails closed (no-op / null / the same "not found" error
// the underlying db.cjs method already throws) rather than silently acting
// across the boundary.
//
// Several existing IPC channels (`task:updateStatus`, `task:update`,
// `task:delete`, `note:update`, `note:delete`, `session:pause/resume/stop/
// delete`, `activity:listBySession`) take only a bare id — no environment id
// — because that was already the shape of the channel before this package
// existed, and the WP's own rule is "no IPC channel name, argument, or
// return shape changes". There is therefore no ambient "which environment is
// this?" for those calls to be checked against. `forTask`/`forNote`/
// `forSession` below resolve the *only* meaningful scope available — the
// row's own environment — and build a bound `scoped(...)` from it, so the
// operation still runs through this accessor (never raw db.cjs calls from an
// IPC handler) and still gets the ownership re-check for free. The re-check
// is not vacuous: it is what stands between "this row's environment" and
// "some other environment" the moment any future call site passes a scope
// around instead of re-deriving it per id — which is exactly the mistake
// this module exists to make structurally hard.
// ---------------------------------------------------------------------------

"use strict";

const {
	ISOLATION_MODES,
	CROSS_ENVIRONMENT_SIGNALS,
	isCrossEnvironmentReadAllowed,
} = require("./isolation.cjs");
const { listEventsByEnvironment } = require("../services/event-log.cjs");

function requireEnvironmentId(environmentId) {
	if (!environmentId) {
		throw new Error("scoped() requires an environment id; refusing to build an unscoped accessor.");
	}
}

// True only when `row` exists AND belongs to exactly this environment. Fail
// closed: a missing row and a row belonging to someone else are treated
// identically -- neither one is ever distinguishable from the outside,
// which also avoids turning "not found" into an oracle for "exists, but not
// yours".
function owns(row, environmentId) {
	return Boolean(row) && row.environment_id === environmentId;
}

function scoped(db, environmentId, options = {}) {
	requireEnvironmentId(environmentId);
	const eventLog = options.eventLog ?? null;

	// A cross-environment read is never an ordinary query: it is named (the
	// allowlisted signal it computed), attributed to the requesting
	// environment, and recorded twice over -- once to the console (always,
	// so it shows up in a support log even with no event log wired up, e.g.
	// in tests) and once to the event log when one is available, so the
	// findings engine's own substrate carries a durable trail of every time
	// this boundary was crossed.
	function logCrossEnvironmentRead(signal, includedCount) {
		console.log(
			`[Atlas] scoped: cross-environment read -- environment=${environmentId} signal=${signal} includedCount=${includedCount}`,
		);
		eventLog?.record?.("data.cross_environment_read", {
			environmentId,
			subject: signal,
			payload: { includedCount },
		});
	}

	const tasks = {
		list: () => db.listTasksByEnvironment(environmentId),
		get: (taskId) => {
			const row = db.getTaskById(taskId);
			return owns(row, environmentId) ? row : null;
		},
		create: (title, description, fields) => db.createTask(environmentId, title, description, fields),
		updateStatus: (taskId, status) => {
			const row = db.getTaskById(taskId);
			if (!owns(row, environmentId)) {
				return null;
			}
			return db.updateTaskStatus(taskId, status);
		},
		update: (taskId, fields) => {
			const row = db.getTaskById(taskId);
			if (!owns(row, environmentId)) {
				return null;
			}
			return db.updateTask(taskId, fields);
		},
		// Matches db.cjs#deleteTask's own contract as closely as possible,
		// with one deliberate narrowing: deleteTask() unconditionally
		// returns `true`, even for an id that never existed. For an id that
		// exists but belongs to a DIFFERENT environment -- a scenario that
		// simply didn't exist before this package -- returning `true` would
		// claim a cross-environment delete succeeded when nothing was
		// touched. `false` here means "nothing was deleted", which is
		// accurate in both the not-found and the wrong-environment case.
		delete: (taskId) => {
			const row = db.getTaskById(taskId);
			if (!owns(row, environmentId)) {
				return false;
			}
			return db.deleteTask(taskId);
		},
	};

	const notes = {
		list: () => db.listNotesByEnvironment(environmentId),
		create: (content) => db.createNote(environmentId, content),
		update: (noteId, content) => {
			const row = db.getNoteById(noteId);
			if (!owns(row, environmentId)) {
				return null;
			}
			return db.updateNote(noteId, content);
		},
		// db.cjs#deleteNote() has no not-found handling at all -- it just
		// issues the DELETE and returns undefined either way. Mirrored
		// exactly: skip the delete on a mismatch, but return the same
		// (nothing) either way, so this is a true no-behaviour-change path
		// for every id that legitimately belongs to this environment.
		delete: (noteId) => {
			const row = db.getNoteById(noteId);
			if (owns(row, environmentId)) {
				db.deleteNote(noteId);
			}
		},
		getNotebook: () => db.getNotebookByEnvironment(environmentId),
		updateNotebook: (content) => db.updateNotebookByEnvironment(environmentId, content),
	};

	const sessions = {
		list: () => db.listSessionsByEnvironment(environmentId),
		get: (sessionId) => {
			const row = db.getSessionById(sessionId);
			return owns(row, environmentId) ? row : null;
		},
		start: () => db.startSession(environmentId),
		pause: (sessionId) => {
			const row = db.getSessionById(sessionId);
			if (!owns(row, environmentId)) {
				throw new Error("No active session found to pause.");
			}
			return db.pauseSession(sessionId);
		},
		resume: (sessionId) => {
			const row = db.getSessionById(sessionId);
			if (!owns(row, environmentId)) {
				throw new Error("No active session found to resume.");
			}
			return db.resumeSession(sessionId);
		},
		stop: (sessionId) => {
			const row = db.getSessionById(sessionId);
			if (!owns(row, environmentId)) {
				throw new Error("No active session found to stop.");
			}
			return db.stopSession(sessionId);
		},
		delete: (sessionId) => {
			const row = db.getSessionById(sessionId);
			if (!owns(row, environmentId)) {
				throw new Error("Session not found.");
			}
			return db.deleteSession(sessionId);
		},
		listActivityBlocks: (sessionId) => {
			const row = db.getSessionById(sessionId);
			if (!owns(row, environmentId)) {
				return [];
			}
			return db.listActivityBlocksBySession(sessionId);
		},
	};

	const events = {
		query: (queryOptions) => listEventsByEnvironment(db, environmentId, queryOptions),
	};

	// The one cross-environment read this package governs today (see
	// isolation.cjs's CROSS_ENVIRONMENT_ALLOWLIST doc comment for why this is
	// the only entry): the dashboard's "time spent per environment"
	// breakdown. db.cjs#getDashboardOverview computes it exactly as it did
	// before WP-0.8 -- own-environment stats plus a naive breakdown across
	// every environment's sessions today, grouped by environment *name*
	// (not id; that grouping key is pre-existing, unrelated to isolation).
	// This method never re-derives that aggregation; it only decides which
	// rows of the already-computed breakdown this particular requester is
	// allowed to see, which keeps the isolation decision in one place
	// instead of duplicated into the aggregation SQL itself.
	function dashboardOverview() {
		const overview = db.getDashboardOverview(environmentId);
		const modeRows = db.listEnvironmentIsolationModes();
		const selfRow = modeRows.find((row) => row.id === environmentId);
		const selfMode = selfRow ? selfRow.isolation_mode : null;

		// Every environment name that belongs to at least one enclosed
		// environment. Matched by name, the same key the aggregation itself
		// groups by -- if a connected and an enclosed environment happen to
		// share a name (already an existing ambiguity in this aggregation,
		// not one introduced here), the safe call is to exclude that name
		// entirely rather than guess which contribution is whose.
		const enclosedNames = new Set(
			modeRows.filter((row) => row.isolation_mode === ISOLATION_MODES.ENCLOSED).map((row) => row.name),
		);

		if (selfMode !== ISOLATION_MODES.CONNECTED) {
			// Enclosed (or a mode that can't be confirmed at all, e.g. the
			// environment itself has vanished mid-request): sees nothing
			// global. Not a "read" to log -- this is the boundary holding,
			// not crossing.
			return {
				...overview,
				timePerEnvironment: overview.timePerEnvironment.filter(
					(row) => selfRow && row.environmentName === selfRow.name,
				),
			};
		}

		const allowed = isCrossEnvironmentReadAllowed({
			requesterMode: selfMode,
			targetMode: ISOLATION_MODES.CONNECTED,
			signal: CROSS_ENVIRONMENT_SIGNALS.ENVIRONMENT_TIME_TOTALS,
		});
		if (!allowed) {
			// Should be unreachable given the check above, but the policy
			// module is the single source of truth for this decision --
			// honour a "no" from it even if this call site didn't expect one.
			return { ...overview, timePerEnvironment: [] };
		}

		const filtered = overview.timePerEnvironment.filter((row) => !enclosedNames.has(row.environmentName));
		logCrossEnvironmentRead(CROSS_ENVIRONMENT_SIGNALS.ENVIRONMENT_TIME_TOTALS, filtered.length);
		return { ...overview, timePerEnvironment: filtered };
	}

	return {
		environmentId,
		tasks,
		notes,
		sessions,
		events,
		dashboardOverview,
	};
}

// Resolve the bound scope for an id-only channel from the row's own
// environment -- see the file header for why this, not a passed-in
// environment id, is the only scope these particular channels can have.
// Returns null when the row doesn't exist (or, defensively, has no
// environment of its own) so callers can reproduce the same "not found"
// behaviour db.cjs's methods already had.
function forTask(db, taskId, options) {
	const row = db.getTaskById(taskId);
	if (!row || !row.environment_id) {
		return null;
	}
	return scoped(db, row.environment_id, options);
}

function forNote(db, noteId, options) {
	const row = db.getNoteById(noteId);
	if (!row || !row.environment_id) {
		return null;
	}
	return scoped(db, row.environment_id, options);
}

function forSession(db, sessionId, options) {
	const row = db.getSessionById(sessionId);
	if (!row || !row.environment_id) {
		return null;
	}
	return scoped(db, row.environment_id, options);
}

// The one deliberate, documented exception to "every read goes through a
// bound scope". `session:active` carries no environment id at all: there is
// exactly one active session in the whole app at a time (db.cjs#startSession
// refuses to start a second one), and the Notch overlay / header timer use
// this to answer "is anything running right now" regardless of which
// environment happens to be open in the renderer. There is no ambient
// environment to scope it to, and the WP's own rule against changing IPC
// argument shapes rules out adding one.
//
// Known, deliberate gap this leaves (see the PR description / final report
// for WP-0.8 for the full reasoning): if the one active session belongs to
// an ENCLOSED environment, its environment_id and elapsed duration are still
// visible here to a caller that isn't "in" that environment -- e.g. the
// Notch overlay while a different environment is focused. Closing that is a
// product decision about what a global timer indicator should show in that
// case, which belongs in WP-1.2 ("isolation enforcement UI"), not a silent
// reinterpretation of this data-layer plumbing package.
function getGlobalActiveSession(db) {
	return db.getActiveSession();
}

scoped.forTask = forTask;
scoped.forNote = forNote;
scoped.forSession = forSession;
scoped.getGlobalActiveSession = getGlobalActiveSession;

module.exports = { scoped };
