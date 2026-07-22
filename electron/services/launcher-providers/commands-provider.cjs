"use strict";

// ---------------------------------------------------------------------------
// The "commands" provider (WP-2.9) -- runs Atlas ITSELF from the launcher:
// start/stop the timer, switch environment, create a task or note (with an
// argument), open a top-level view, and open Settings. Every command below is
// a thin wrapper around the SAME primitive an existing electron/ipc/*.cjs
// handler already calls (electron/data/scoped.cjs for tasks/notes/sessions,
// the LauncherExecuteContext's navigate/switchEnvironment for windows/views,
// or a main.cjs window factory for Settings) -- nothing here is new business
// logic, only a new way to reach logic that already exists. See this file's
// footer for exactly which existing call site each command mirrors.
//
// -- Single source of truth (this WP's own acceptance criterion) -----------
// COMMANDS below is the one and only list: search() filters/maps over it,
// execute() dispatches back into it by id, and nothing about the command set
// is hand-duplicated anywhere else in this file (or, for that matter, in the
// registry -- index.cjs never sees anything but this provider's ordinary
// search()/execute() pair). commands-provider.test.js asserts there are no
// duplicate ids and that every command is reachable through search().
//
// -- Argument parsing --------------------------------------------------------
// A command descriptor's `keywords` double as its trigger phrases. Typing the
// exact phrase (e.g. "task") or the phrase followed by a space and more text
// (e.g. "task Buy milk") is an unambiguous VERB match -- the remainder of the
// query (in its ORIGINAL casing, only trimmed) becomes `arg`, parsed by
// matchCommand() below and carried on the result's own id (`task:Buy milk`)
// so a same-session execute() recovers it even on a result-cache miss (see
// index.cjs's header for why that fallback path exists at all). Typing
// anything else that merely appears inside the command's title/keywords
// (e.g. "milk" would not match, but "dash" matches "Open Dashboard") is a
// plain discoverability substring match, same style as actions-provider.cjs
// and data-provider.cjs already use -- `arg` is `null` in that case, since a
// substring match carries no reliable argument boundary to parse.
//
// -- Environment scoping ------------------------------------------------
// `task`/`note`/`start-timer` all read `options.environmentId` -- the SAME
// "currently active environment" value ipc/launcher.cjs threads into every
// execute() call (getCurrentEnvironmentId(), fresh per call) that an ordinary
// task:create/note:create/session:start IPC call would have used as its own
// `environmentId` argument -- and create through electron/data/scoped.cjs,
// exactly like electron/ipc/tasks.cjs, electron/ipc/notes.cjs, and
// electron/ipc/sessions.cjs do. No command here ever reads or writes a
// DIFFERENT environment's data.
//
// -- Scenes: deliberately NOT a command here --------------------------------
// "Run a scene" was considered and left out. A scene is not a row or an id of
// its own -- it is a JSON blob living inside one Notch widget's config (see
// data-provider.cjs's header for the full explanation, unchanged since
// WP-2.3) -- and actually RUNNING one (switch environment, start/stop the
// timer, create preset tasks, launch apps, open URLs) is entirely
// src/components/notch/NotchApp.tsx#runScene's own renderer-side pipeline,
// with no main-process entry point to call into. Reimplementing that whole
// pipeline here just to give the launcher a "run scene" verb would be a
// second, parallel copy of it -- exactly what this WP was told not to build.
// Left out deliberately, not fabricated; see this WP's final report.
// ---------------------------------------------------------------------------

const { scoped } = require("../../data/scoped.cjs");

// Case-insensitive "contains" match against a live environment list -- the
// same list electron/ipc/environments.cjs's `environment:list` (and this
// module's own switch-environment command) both read straight off `db`. The
// FIRST match wins; with several similarly-named environments this is a
// simplification (data-provider.cjs's own environment search already offers
// the exhaustive, unambiguous list) but it is enough for a quick "switch
// <name>" launcher command, and it never resolves outside the requested name.
function findEnvironmentByName(db, needle) {
	const trimmed = typeof needle === "string" ? needle.trim().toLowerCase() : "";
	if (!trimmed || !db) {
		return null;
	}
	const environments = db.listEnvironments();
	return environments.find((environment) => environment.name.toLowerCase().includes(trimmed)) ?? null;
}

// -- The registry ------------------------------------------------------------
//
// Every entry: { id, title, subtitle, keywords, argHint, run(arg, context, options) }.
// `argHint` is null for commands that never take one; non-null strings are
// shown to the user (result subtitle) and drive the "verb followed by a
// space" argument split in matchCommand() below.
const COMMANDS = [
	{
		id: "start-timer",
		title: "Start the timer",
		subtitle: "Session",
		keywords: ["start timer", "start session", "start focus"],
		argHint: null,
		// Mirrors electron/ipc/sessions.cjs's `session:start` handler exactly:
		// scoped(...).sessions.start() (db.cjs#startSession under the hood),
		// then tell the activity tracker which session is now current, then
		// record the same "session.start" event.
		run(_arg, context, options) {
			const environmentId = options?.environmentId ?? null;
			if (!environmentId) {
				return { ok: false, error: "No active environment to start a timer in." };
			}
			const db = context.getDb?.();
			if (!db) {
				return { ok: false, error: "Database not ready." };
			}
			try {
				const session = scoped(db, environmentId).sessions.start();
				context.getTracker?.()?.setCurrentSession?.(session.id);
				context.getEventLog?.()?.record("session.start", { environmentId, sessionId: session.id });
				return { ok: true, title: "Timer started" };
			} catch (error) {
				// db.cjs#startSession throws "A session is already active."/
				// "Environment not found." -- both are real, expected outcomes,
				// not bugs, so surface the message rather than a generic failure.
				return { ok: false, error: error instanceof Error ? error.message : "Could not start the timer." };
			}
		},
	},
	{
		id: "stop-timer",
		title: "Stop the timer",
		subtitle: "Session",
		keywords: ["stop timer", "stop session", "end session", "stop focus"],
		argHint: null,
		// Mirrors `session:stop` exactly, in the same order: close the tracker's
		// open activity block, clear its current-session pointer, stop the row,
		// record "session.stop", then close the mini window if one is open --
		// same as sessions.cjs, there is exactly one active session app-wide
		// (scoped.getGlobalActiveSession), so no session id argument is needed.
		run(_arg, context) {
			const db = context.getDb?.();
			if (!db) {
				return { ok: false, error: "Database not ready." };
			}
			const active = scoped.getGlobalActiveSession(db);
			if (!active) {
				return { ok: false, error: "No active timer to stop." };
			}
			try {
				const scope = scoped.forSession(db, active.id);
				if (!scope) {
					return { ok: false, error: "No active session found to stop." };
				}
				const tracker = context.getTracker?.();
				tracker?.closeOpenBlockNow?.(active.id);
				if (tracker?.currentSessionId === active.id) {
					tracker.clearCurrentSession?.();
				}
				const session = scope.sessions.stop(active.id);
				context.getEventLog?.()?.record("session.stop", { environmentId: session.environment_id, sessionId: active.id });
				const miniWindow = context.getMiniWindow?.();
				if (miniWindow && !miniWindow.isDestroyed()) {
					miniWindow.close();
				}
				return { ok: true, title: "Timer stopped" };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : "Could not stop the timer." };
			}
		},
	},
	{
		id: "switch-environment",
		title: "Switch environment",
		subtitle: "Command",
		keywords: ["switch", "switch environment", "switch to", "environment", "env"],
		argHint: "environment name",
		// Mirrors `environment:switch` exactly: context.switchEnvironment() IS
		// main.cjs's own setActiveEnvironment (see index.cjs's header), the same
		// function that IPC channel calls; navigate("dashboard") afterwards
		// mirrors data-provider.cjs's own "environment" result execute().
		run(arg, context) {
			const db = context.getDb?.();
			if (!db) {
				return { ok: false, error: "Database not ready." };
			}
			const trimmedArg = (arg || "").trim();
			if (!trimmedArg) {
				return { ok: false, error: 'Type an environment name after "switch".' };
			}
			const match = findEnvironmentByName(db, trimmedArg);
			if (!match) {
				return { ok: false, error: `No environment matches "${trimmedArg}".` };
			}
			const switched = context.switchEnvironment?.(match.id) ?? false;
			context.navigate?.("dashboard");
			return { ok: Boolean(switched), title: `Switched to ${match.name}` };
		},
	},
	{
		id: "task",
		title: "Create a new task",
		subtitle: "Quick capture",
		keywords: ["task", "new task", "create task", "add task", "todo"],
		argHint: "task title",
		// Mirrors `task:create` exactly: scoped(...).tasks.create(title, "", {})
		// (db.cjs#createTask under the hood) then the same "task.create" event,
		// with only the new task's id as `subject` -- never its title.
		run(arg, context, options) {
			const environmentId = options?.environmentId ?? null;
			const title = (arg || "").trim();
			if (!environmentId) {
				return { ok: false, error: "No active environment to create a task in." };
			}
			if (!title) {
				return { ok: false, error: 'Type a task title after "task".' };
			}
			const db = context.getDb?.();
			if (!db) {
				return { ok: false, error: "Database not ready." };
			}
			const task = scoped(db, environmentId).tasks.create(title, "", {});
			context.getEventLog?.()?.record("task.create", { environmentId, subject: task.id });
			return { ok: true, title: `Created task "${task.title}"` };
		},
	},
	{
		id: "note",
		title: "Create a new note",
		subtitle: "Quick capture",
		keywords: ["note", "new note", "create note", "add note"],
		argHint: "note text",
		// Mirrors `note:create` exactly: scoped(...).notes.create(content) (db.cjs
		// #createNote under the hood, appending one node to the environment's
		// single notebook document) then the same "note.create" event, with only
		// the new note's id as `subject` -- never its content.
		run(arg, context, options) {
			const environmentId = options?.environmentId ?? null;
			if (!environmentId) {
				return { ok: false, error: "No active environment to create a note in." };
			}
			const db = context.getDb?.();
			if (!db) {
				return { ok: false, error: "Database not ready." };
			}
			const content = (arg || "").trim();
			const note = scoped(db, environmentId).notes.create(content);
			context.getEventLog?.()?.record("note.create", { environmentId, subject: note.id });
			return { ok: true, title: content ? "Created note" : "Created a blank note" };
		},
	},
	{
		id: "open-tasks",
		title: "Open Tasks",
		subtitle: "Atlas",
		keywords: ["tasks", "open tasks", "task list", "board"],
		argHint: null,
		run(_arg, context) {
			const navigated = context.navigate?.("tasks") ?? false;
			return { ok: Boolean(navigated), title: "Opened Tasks" };
		},
	},
	{
		id: "open-notes",
		title: "Open Notes",
		subtitle: "Atlas",
		keywords: ["notes", "open notes", "notebook"],
		argHint: null,
		run(_arg, context) {
			const navigated = context.navigate?.("notes") ?? false;
			return { ok: Boolean(navigated), title: "Opened Notes" };
		},
	},
	{
		id: "open-activity",
		title: "Open Activity",
		subtitle: "Atlas",
		keywords: ["activity", "open activity", "logbook", "history", "sessions"],
		argHint: null,
		run(_arg, context) {
			const navigated = context.navigate?.("activity") ?? false;
			return { ok: Boolean(navigated), title: "Opened Activity" };
		},
	},
	{
		id: "open-dashboard",
		title: "Open Dashboard",
		subtitle: "Atlas",
		keywords: ["dashboard", "open dashboard", "home"],
		argHint: null,
		run(_arg, context) {
			const navigated = context.navigate?.("dashboard") ?? false;
			return { ok: Boolean(navigated), title: "Opened Dashboard" };
		},
	},
	{
		id: "open-settings",
		title: "Open Settings",
		subtitle: "Atlas",
		keywords: ["settings", "open settings", "preferences", "options"],
		argHint: null,
		// Mirrors `window:openSettings` exactly: same parent-window fallback
		// chain (main window, then welcome window, then none), same
		// createSettingsWindow() factory (main.cjs's own wrapper, which already
		// shows+focuses the existing window instead of opening a second one --
		// see windows/settings-window.cjs -- so this already behaves like a
		// toggle-to-front rather than spawning duplicates).
		run(_arg, context) {
			const parentWindow = context.getMainWindow?.() ?? context.getWelcomeWindow?.() ?? null;
			const opened = context.createSettingsWindow?.(parentWindow);
			return { ok: Boolean(opened), title: "Opened Settings" };
		},
	},
];

// Every command id must be unique -- enforced here (not just asserted by a
// test) so a future typo'd addition to COMMANDS fails loudly and immediately,
// the same instant this module is first required, rather than silently
// shadowing an earlier command at search/execute time.
(function assertUniqueCommandIds() {
	const seen = new Set();
	for (const command of COMMANDS) {
		if (seen.has(command.id)) {
			throw new Error(`commands-provider: duplicate command id "${command.id}".`);
		}
		seen.add(command.id);
	}
})();

// -- search() -----------------------------------------------------------

// A command's own local id never contains ":" -- the only place one can show
// up is the arg separator this file adds, so splitting on the FIRST ":" is
// always unambiguous, no matter what punctuation the user's own argument text
// contains (e.g. "task Meeting 3:00pm" round-trips its colon just fine).
function encodeResultId(commandId, arg) {
	return arg === null || arg === undefined ? commandId : `${commandId}:${arg}`;
}

function decodeResultId(id) {
	if (typeof id !== "string" || !id) {
		return null;
	}
	const separatorIndex = id.indexOf(":");
	if (separatorIndex === -1) {
		return { commandId: id, arg: null };
	}
	return { commandId: id.slice(0, separatorIndex), arg: id.slice(separatorIndex + 1) };
}

// Does `command` match `needle` (the trimmed, lowercased query)? Returns the
// parsed `arg` (a string once a verb phrase is recognized, even "" for a bare
// verb with nothing typed after it yet; `null` when this was only ever a
// discoverability substring match, or when the command takes no argument).
function matchCommand(command, needle, trimmedQuery) {
	for (const phrase of command.keywords) {
		if (needle === phrase) {
			return { matched: true, arg: command.argHint ? "" : null };
		}
		if (needle.startsWith(`${phrase} `)) {
			return { matched: true, arg: trimmedQuery.slice(phrase.length).trim() };
		}
	}
	const haystack = `${command.title.toLowerCase()} ${command.keywords.join(" ")}`;
	if (haystack.includes(needle)) {
		return { matched: true, arg: null };
	}
	return { matched: false, arg: null };
}

function toResult(command, arg, context) {
	const trimmedArg = typeof arg === "string" ? arg.trim() : "";
	let title = command.title;
	if (command.id === "switch-environment" && trimmedArg) {
		const db = context?.getDb?.();
		const match = db ? findEnvironmentByName(db, trimmedArg) : null;
		title = match ? `Switch to ${match.name}` : `Switch environment: "${trimmedArg}"`;
	} else if (command.argHint && trimmedArg) {
		title = `${command.title}: "${trimmedArg}"`;
	}
	return {
		id: encodeResultId(command.id, arg),
		kind: "command",
		title,
		subtitle: command.argHint && !trimmedArg ? `Type ${command.argHint} after "${command.id}"` : command.subtitle,
	};
}

function search(query, context = {}) {
	const trimmedQuery = typeof query === "string" ? query.trim() : "";
	if (!trimmedQuery) {
		// Blank query -> every command is a suggestion, exactly like
		// actions-provider.cjs's own "no needle" behaviour.
		return COMMANDS.map((command) => toResult(command, null, context));
	}
	const needle = trimmedQuery.toLowerCase();
	const results = [];
	for (const command of COMMANDS) {
		const { matched, arg } = matchCommand(command, needle, trimmedQuery);
		if (matched) {
			results.push(toResult(command, arg, context));
		}
	}
	return results;
}

// -- execute() --------------------------------------------------------------

function execute(result, options = {}, context = {}) {
	const parsed = decodeResultId(result?.id);
	if (!parsed) {
		return { ok: false, error: "Unknown launcher command." };
	}
	const command = COMMANDS.find((entry) => entry.id === parsed.commandId);
	if (!command) {
		return { ok: false, error: "Unknown launcher command." };
	}
	return command.run(parsed.arg, context, options);
}

module.exports = {
	name: "commands",
	search,
	execute,
	// Exposed for unit tests only -- not part of the provider interface.
	COMMANDS,
	decodeResultId,
};
