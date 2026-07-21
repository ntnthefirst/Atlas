const { randomUUID } = require("node:crypto");
const { Database } = require("node-sqlite3-wasm");
const { wrapDatabase } = require("./migrations/sqlite-helpers.cjs");
const { runMigrations } = require("./migrations/index.cjs");
const { importLegacyDatabaseIfNeeded } = require("./migrations/legacy-import.cjs");
const { seedGlobalDefaultNotchLayoutIfNeeded } = require("./migrations/notch-layout-seed.cjs");
const { isValidIsolationMode, DEFAULT_ISOLATION_MODE } = require("./data/isolation.cjs");
const {
	parseEnvironmentConfig,
	serializeEnvironmentConfig,
	applyConfigPatch,
} = require("./config/environment-config.cjs");
const { GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, resolveNotchLayout } = require("./config/notch-layouts.cjs");
const { normalizeNotchPreferences } = require("./config/notch-prefs.cjs");

// Requests WAL (so readers don't block the writer) and synchronous=NORMAL
// (fsyncs at commit/checkpoint, so a hard crash can't corrupt the database —
// it can only lose the last few uncommitted writes; never use OFF, which
// drops that guarantee).
//
// Verified empirically: node-sqlite3-wasm's filesystem VFS does not actually
// honor `journal_mode = WAL` — the pragma call does not error, but
// `PRAGMA journal_mode` still reports `delete` (the default rollback
// journal) immediately afterward, on every connection, including a freshly
// created database. This is a limitation of the WASM VFS itself (it has no
// shared-memory backing for WAL's coordination file), not a mistake in how
// it's invoked here. `synchronous = NORMAL` *does* take effect (confirmed
// via `PRAGMA synchronous` returning `1`), which is the setting that matters
// for crash-safety; the call to set WAL is left in place — it's harmless,
// and future versions of the package may add support for it.
function applyPragmas(rawDb) {
	rawDb.exec("PRAGMA journal_mode = WAL");
	rawDb.exec("PRAGMA synchronous = NORMAL");
}

const nowIso = () => new Date().toISOString();

const toDurationMs = (startIso, endIso) => Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());

const toInt = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const createEmptyNotebookDocument = () =>
	JSON.stringify({
		version: 1,
		viewport: {
			x: 0,
			y: 0,
			zoom: 1,
		},
		nodes: [],
	});

const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"];

// Tasks store tags as a JSON string and may predate the priority/due columns;
// normalize every row the app sees into a stable shape (tags: string[],
// priority: enum, due_date: string|null).
const normalizeTask = (task) => {
	if (!task) {
		return task;
	}
	let tags = [];
	try {
		const parsed = typeof task.tags === "string" ? JSON.parse(task.tags) : task.tags;
		if (Array.isArray(parsed)) {
			tags = parsed.filter((tag) => typeof tag === "string");
		}
	} catch {
		tags = [];
	}
	return {
		...task,
		description: task.description ?? "",
		priority: TASK_PRIORITIES.includes(task.priority) ? task.priority : "none",
		tags,
		due_date: task.due_date || null,
	};
};

const normalizeSession = (session) => {
	if (!session) {
		return session;
	}

	return {
		...session,
		total_duration: toInt(session.total_duration),
		paused_duration: toInt(session.paused_duration),
		is_active: toInt(session.is_active),
		is_paused: toInt(session.is_paused),
	};
};

class AtlasDatabase {
	// Kept `async` for compatibility with every existing caller (they all
	// `await AtlasDatabase.create(...)`), even though node-sqlite3-wasm's
	// constructor is synchronous. The legacy sql.js import (if needed) also
	// runs synchronously, before the real connection is ever opened.
	static async create(dbPath) {
		importLegacyDatabaseIfNeeded(dbPath);
		const rawDb = new Database(dbPath);
		return new AtlasDatabase(dbPath, rawDb);
	}

	constructor(dbPath, rawDb) {
		this.dbPath = dbPath;
		this.db = rawDb;
		applyPragmas(rawDb);
		this._core = wrapDatabase(rawDb);
		runMigrations(this._core);
		// WP-1.3: populate notch_layouts' "default" row from the pre-existing
		// flat notch-preferences.json the very first time this table exists --
		// see notch-layout-seed.cjs's header for why this can't be part of
		// migration 006 itself (it needs filesystem access to a file beside the
		// database, not inside it). Idempotent and safe to call on every boot.
		seedGlobalDefaultNotchLayoutIfNeeded(this._core, dbPath);
	}

	run(sql, params = []) {
		this._core.run(sql, params);
	}

	first(sql, params = []) {
		return this._core.first(sql, params);
	}

	all(sql, params = []) {
		return this._core.all(sql, params);
	}

	tableExists(tableName) {
		return this._core.tableExists(tableName);
	}

	columnExists(tableName, columnName) {
		return this._core.columnExists(tableName, columnName);
	}

	// Runs `fn` (which may issue several `this.run`/`this.all` calls) inside a
	// single SQLite transaction. Every method below that issues more than one
	// write uses this, both so a crash or thrown error mid-operation can't
	// leave orphaned rows, and because node-sqlite3-wasm is dramatically
	// faster when writes are batched into one transaction than when each hits
	// disk individually (benchmarked: ~0.016ms/insert batched vs ~12.7ms/insert
	// unbatched).
	transaction(fn) {
		return this._core.transaction(fn);
	}

	/**
	 * Finalize any stranded sessions marked as active but actually ended.
	 * Called on app startup to handle crash scenarios or stale data.
	 */
	finalizeStrandedSessions() {
		return this.transaction(() => {
			const strandedSessions = this.all(
				`SELECT * FROM sessions
       WHERE is_active = 1
       ORDER BY created_at DESC`,
			);

			const results = {
				finalized: 0,
				blocksRepairedWithSessionEnd: 0,
			};

			for (const session of strandedSessions) {
				// Check if session has any activity blocks
				const blocks = this.listActivityBlocksBySession(session.id);
				if (blocks.length === 0) {
					// No activity tracked, mark session as ended with 0 duration
					this.run(
						`UPDATE sessions
           SET is_active = 0, ended_at = ?, total_duration = 0
           WHERE id = ?`,
						[session.started_at, session.id],
					);
					results.finalized++;
					continue;
				}

				// Get the most recent block to determine when activity ended
				const lastBlock = blocks[blocks.length - 1];
				const assumedEndTime = lastBlock.ended_at || lastBlock.started_at;

				// Mark session as ended
				const totalDuration = Math.max(
					0,
					toDurationMs(session.started_at, assumedEndTime) - session.paused_duration,
				);
				this.run(
					`UPDATE sessions
         SET is_active = 0, ended_at = ?, total_duration = ?
         WHERE id = ?`,
					[assumedEndTime, totalDuration, session.id],
				);

				// Repair any unclosed blocks
				for (const block of blocks) {
					if (!block.ended_at) {
						const validEndTime = Math.min(block.started_at, assumedEndTime);
						const blockDuration = toDurationMs(block.started_at, validEndTime);
						this.run(
							`UPDATE activity_blocks
             SET ended_at = ?, duration = ?
             WHERE id = ?`,
							[validEndTime, blockDuration, block.id],
						);
						results.blocksRepairedWithSessionEnd++;
					}
				}

				results.finalized++;
			}

			return results;
		});
	}

	/**
	 * Repair corrupted session data where app durations exceed session duration.
	 * Rebuilds app durations from activity block timestamps.
	 */
	repairCorruptedSessions() {
		return this.transaction(() => {
			const results = {
				sessionsRepaired: 0,
				blocksNormalized: 0,
			};

			// Find all completed sessions
			const completedSessions = this.all(
				`SELECT id, started_at, ended_at, total_duration FROM sessions
       WHERE is_active = 0 AND ended_at IS NOT NULL`,
			);

			for (const session of completedSessions) {
				const sessionStart = new Date(session.started_at).getTime();
				const sessionEnd = new Date(session.ended_at).getTime();
				const sessionDurationMs = Math.max(0, sessionEnd - sessionStart);

				// Get all blocks for this session
				const blocks = this.listActivityBlocksBySession(session.id);

				let hasCorruption = false;
				let totalAppDuration = 0;

				// Validate and repair each block
				for (const block of blocks) {
					const blockStart = new Date(block.started_at).getTime();
					let blockEnd = block.ended_at ? new Date(block.ended_at).getTime() : blockStart;

					// Ensure block is within session bounds
					if (blockStart > sessionEnd) {
						blockEnd = sessionEnd;
						hasCorruption = true;
					} else if (blockEnd > sessionEnd) {
						blockEnd = sessionEnd;
						hasCorruption = true;
					}

					// Also ensure block didn't start before session started
					const actualStart = Math.max(blockStart, sessionStart);
					const actualEnd = Math.min(blockEnd, sessionEnd);

					const blockDuration = Math.max(0, actualEnd - actualStart);
					if (blockDuration !== block.duration || !block.ended_at) {
						this.run(
							`UPDATE activity_blocks
             SET started_at = ?, ended_at = ?, duration = ?
             WHERE id = ?`,
							[
								new Date(actualStart).toISOString(),
								new Date(actualEnd).toISOString(),
								blockDuration,
								block.id,
							],
						);
						hasCorruption = true;
						results.blocksNormalized++;
					}

					totalAppDuration += blockDuration;
				}

				// If total app duration exceeds session, that's data corruption
				if (totalAppDuration > sessionDurationMs * 1.05) {
					hasCorruption = true;
				}

				if (hasCorruption) {
					results.sessionsRepaired++;
				}
			}

			return results;
		});
	}

	/**
	 * Validate that a session is truly active and can accept new data.
	 * Returns the session if valid, throws otherwise.
	 */
	validateActiveSession(sessionId) {
		const session = this.getSessionById(sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}
		if (!session.is_active || session.ended_at) {
			throw new Error(
				`Session is no longer active (is_active=${session.is_active}, ended_at=${session.ended_at}). Cannot modify.`,
			);
		}
		return session;
	}

	// `isolation_mode` (WP-0.8) rides along on every environment read from here
	// on (WP-1.2): it is a first-class column on this row, exactly like icon/
	// accent/preset, so the isolation-enforcement UI can show and switch it
	// straight from the same environment list the app already loads -- no
	// separate round trip, and no way for the renderer's idea of an
	// environment's mode to go stale relative to what electron/data/scoped.cjs
	// actually enforces.
	//
	// WP-1.5: filters out archived environments, exactly as it always
	// implicitly did before archiving existed (every environment used to be
	// "visible"). This is the one change that makes archiving actually hide
	// something -- every OTHER caller of this method (the switcher, the
	// sidebar, `hasAnyEnvironments()` in main.cjs, ...) keeps behaving
	// identically for a user who has never archived anything, since
	// `archived_at` is NULL for every row until archiveEnvironment() sets it.
	// See listArchivedEnvironments() below for the deliberate mirror image of
	// this query.
	listEnvironments() {
		return this.all(
			"SELECT id, name, icon, accent, preset, isolation_mode, created_at FROM environments WHERE archived_at IS NULL ORDER BY created_at ASC",
		);
	}

	// Deliberately NOT filtered by archived_at -- renaming, recoloring, or
	// looking up a single environment by id must keep working on an archived
	// one (the Settings surface's "Archived" section still needs to render
	// its name/icon/accent, and unarchiving it has to read it first). Includes
	// `archived_at` itself (unlike listEnvironments' column list, which is
	// left exactly as it was pre-WP-1.5) so the renderer can tell an archived
	// environment apart from a visible one wherever it fetches a single row.
	getEnvironment(environmentId) {
		return this.first(
			"SELECT id, name, icon, accent, preset, isolation_mode, archived_at, created_at FROM environments WHERE id = ?",
			[environmentId],
		);
	}

	createEnvironment(name, options = {}) {
		const environment = {
			id: randomUUID(),
			name,
			icon: options.icon ?? null,
			accent: options.accent ?? null,
			preset: options.preset ?? null,
			// Not part of the INSERT below -- the column's own
			// `NOT NULL DEFAULT 'connected'` (migration 004) is what actually
			// assigns this. Mirrored into the returned object here purely so a
			// freshly created environment's isolation_mode is visible to the
			// caller immediately, without a second read back from the row this
			// INSERT just wrote.
			isolation_mode: DEFAULT_ISOLATION_MODE,
			created_at: nowIso(),
		};

		this.run("INSERT INTO environments (id, name, icon, accent, preset, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
			environment.id,
			environment.name,
			environment.icon,
			environment.accent,
			environment.preset,
			environment.created_at,
		]);

		return environment;
	}

	renameEnvironment(environmentId, name) {
		this.run("UPDATE environments SET name = ? WHERE id = ?", [name, environmentId]);
		return this.getEnvironment(environmentId);
	}

	updateEnvironment(environmentId, fields = {}) {
		const allowed = ["name", "icon", "accent", "preset"];
		const updates = [];
		const values = [];
		for (const key of allowed) {
			if (Object.prototype.hasOwnProperty.call(fields, key)) {
				updates.push(`${key} = ?`);
				values.push(fields[key]);
			}
		}

		// WP-1.4: `environments.accent` and `environments.config.appearance.accent`
		// are deliberately the same value living in two places (see
		// environment-config.cjs's header comment for why) -- the atomic
		// environment-switch bundle reads accent from the config document, so a
		// plain recolor through this method must keep that document in sync,
		// never leave it silently stale. Wrapped in one transaction with the row
		// update itself (D9: multi-statement writes must not risk a crash
		// leaving the two out of sync); guarded on the environment actually
		// existing so a bad id keeps this method's existing no-throw, no-op
		// contract for a missing row.
		const touchesAccent = Object.prototype.hasOwnProperty.call(fields, "accent");
		this.transaction(() => {
			if (updates.length > 0) {
				this.run(`UPDATE environments SET ${updates.join(", ")} WHERE id = ?`, [...values, environmentId]);
			}
			if (touchesAccent) {
				const exists = this.first("SELECT id FROM environments WHERE id = ?", [environmentId]);
				if (exists) {
					this.setEnvironmentConfig(environmentId, { appearance: { accent: fields.accent } });
				}
			}
		});

		return this.getEnvironment(environmentId);
	}

	deleteEnvironment(environmentId) {
		const environment = this.first("SELECT id FROM environments WHERE id = ?", [environmentId]);
		if (!environment) {
			throw new Error("Environment not found.");
		}

		const activeSession = this.getActiveSession();
		if (activeSession && activeSession.environment_id === environmentId) {
			throw new Error("Stop the active session in this environment before deleting it.");
		}

		// WP-1.3: capture this environment's own Notch layout id (if it has
		// one) before the row disappears, so the now-unreferenced layout can be
		// cleaned up in the same transaction. Read outside the transaction,
		// same as `activeSession` above -- this is a plain SELECT, nothing here
		// depends on transactional isolation from the deletes that follow.
		const config = this.getEnvironmentConfig(environmentId);

		return this.transaction(() => {
			const sessionIds = this.all("SELECT id FROM sessions WHERE environment_id = ?", [environmentId]).map(
				(row) => row.id,
			);
			if (sessionIds.length > 0) {
				const placeholders = sessionIds.map(() => "?").join(", ");
				this.run(`DELETE FROM pauses WHERE session_id IN (${placeholders})`, sessionIds);
				this.run(`DELETE FROM activity_blocks WHERE session_id IN (${placeholders})`, sessionIds);
				this.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
			}

			this.run("DELETE FROM tasks WHERE environment_id = ?", [environmentId]);
			this.run("DELETE FROM notes WHERE environment_id = ?", [environmentId]);
			// WP-1.5: the event log (WP-0.5) is per-environment content too --
			// its `events.environment_id` column is exactly the same shape as
			// tasks/notes/sessions above. Deleting an environment now takes its
			// event history with it, matching the WP's own list of what
			// deletion destroys. Global events (environment_id IS NULL, e.g.
			// nothing today, but the column allows it) are never touched.
			this.run("DELETE FROM events WHERE environment_id = ?", [environmentId]);
			this.run("DELETE FROM environments WHERE id = ?", [environmentId]);
			// Never delete GLOBAL_DEFAULT_NOTCH_LAYOUT_ID here -- it is shared
			// across every other environment that has no override of its own.
			// Only an environment's OWN layout (a real, environment-specific
			// row) is cleaned up when that environment goes away.
			if (config?.notchLayoutId && config.notchLayoutId !== GLOBAL_DEFAULT_NOTCH_LAYOUT_ID) {
				this.run("DELETE FROM notch_layouts WHERE id = ?", [config.notchLayoutId]);
			}
			return true;
		});
	}

	// WP-1.5: real per-category counts of everything deleteEnvironment above
	// would destroy, so the confirmation dialog can say "12 tasks, 40
	// sessions, 3 notes..." instead of generic wording. Every query is
	// filtered by this ONE environment id and nothing is ever aggregated
	// across environments, so an enclosed environment's counts can never leak
	// into another environment's confirmation dialog (WP-0.8) -- there is no
	// cross-environment read here for electron/data/scoped.cjs to gate, only
	// "how much does THIS environment itself hold", the same shape
	// environment:getConfig already has no isolation policy question about.
	getEnvironmentContentCounts(environmentId) {
		const environment = this.first("SELECT id FROM environments WHERE id = ?", [environmentId]);
		if (!environment) {
			throw new Error("Environment not found.");
		}

		const countOf = (sql, params) => this.first(sql, params)?.count ?? 0;

		const tasks = countOf("SELECT COUNT(*) AS count FROM tasks WHERE environment_id = ?", [environmentId]);
		const sessions = countOf("SELECT COUNT(*) AS count FROM sessions WHERE environment_id = ?", [environmentId]);
		const activityBlocks = countOf(
			`SELECT COUNT(*) AS count FROM activity_blocks
			 WHERE session_id IN (SELECT id FROM sessions WHERE environment_id = ?)`,
			[environmentId],
		);
		const events = countOf("SELECT COUNT(*) AS count FROM events WHERE environment_id = ?", [environmentId]);

		// The notebook is one row per environment holding a canvas document
		// (createEmptyNotebookDocument's `nodes` array) -- "notes" here counts
		// the individual nodes on that canvas, which is what a user actually
		// thinks of as "a note", not the single database row that holds them
		// all. A notebook that was never opened has no row at all yet
		// (getNotebookByEnvironment creates one lazily on first read) -- read
		// the raw row directly rather than going through that lazy accessor,
		// since a COUNT must never itself create the thing it's counting.
		const notebookRow = this.first("SELECT content FROM notes WHERE environment_id = ? LIMIT 1", [environmentId]);
		let notes = 0;
		if (notebookRow) {
			try {
				const parsed = JSON.parse(notebookRow.content);
				notes = Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0;
			} catch {
				notes = 0;
			}
		}

		const config = this.getEnvironmentConfig(environmentId);
		const hasCustomNotchLayout = Boolean(
			config?.notchLayoutId && config.notchLayoutId !== GLOBAL_DEFAULT_NOTCH_LAYOUT_ID,
		);

		return { tasks, sessions, notes, activityBlocks, events, hasCustomNotchLayout };
	}

	// WP-1.5: hides `environmentId` from every switching surface
	// (listEnvironments filters `archived_at IS NULL`) while leaving every
	// row it owns -- tasks, notes, sessions, activity blocks, events, its own
	// Notch layout, its config document -- completely untouched. Deliberately
	// NOT a soft delete: this method never reads or writes any table but
	// `environments.archived_at` itself.
	archiveEnvironment(environmentId) {
		const environment = this.getEnvironment(environmentId);
		if (!environment) {
			throw new Error("Environment not found.");
		}
		if (environment.archived_at) {
			return environment;
		}

		// Mirrors deleteEnvironment's own guard: archiving an environment out
		// from under a session that's actively running in it would hide the
		// very surface (the switcher) someone needs to get back to it and
		// stop that session.
		const activeSession = this.getActiveSession();
		if (activeSession && activeSession.environment_id === environmentId) {
			throw new Error("Stop the active session in this environment before archiving it.");
		}

		// Never let the last VISIBLE environment disappear this way. Archiving
		// is meant to be the low-stakes, reversible alternative to deleting --
		// but the one surface that can undo it (Settings, WP-1.5's own
		// environment management card) lives inside the main app window, and
		// main.cjs only opens that window when at least one non-archived
		// environment exists (hasAnyEnvironments/openPrimaryWindowByEnvironmentState);
		// with zero left it opens the welcome window instead, which has no
		// "unarchive" control at all. Archiving the only remaining environment
		// would therefore strand its data behind a window that no longer
		// opens -- a worse outcome than doing nothing, which archiving must
		// never produce. Deleting the last environment is still permitted
		// (see deleteEnvironment): that is a fully-confirmed, final, explicit
		// action with its own established "show the welcome window" fallback,
		// not something this method needs to also guard against.
		const visibleCount = this.first(
			"SELECT COUNT(*) AS count FROM environments WHERE archived_at IS NULL",
		).count;
		if (visibleCount <= 1) {
			throw new Error(
				"Cannot archive the only environment. Create another environment first, or delete this one instead.",
			);
		}

		this.run("UPDATE environments SET archived_at = ? WHERE id = ?", [nowIso(), environmentId]);
		return this.getEnvironment(environmentId);
	}

	// Reverses archiveEnvironment. No guard beyond "does it exist" -- unlike
	// archiving, there is no state unarchiving could ever strand anyone in.
	unarchiveEnvironment(environmentId) {
		const environment = this.getEnvironment(environmentId);
		if (!environment) {
			throw new Error("Environment not found.");
		}
		if (!environment.archived_at) {
			return environment;
		}
		this.run("UPDATE environments SET archived_at = NULL WHERE id = ?", [environmentId]);
		return this.getEnvironment(environmentId);
	}

	// The archived counterpart to listEnvironments -- everything that list
	// deliberately excludes. Ordered by archived_at DESC (most recently
	// hidden first), since that's the order someone hunting for "the thing I
	// just archived" wants to scan.
	listArchivedEnvironments() {
		return this.all(
			`SELECT id, name, icon, accent, preset, isolation_mode, archived_at, created_at
			 FROM environments
			 WHERE archived_at IS NOT NULL
			 ORDER BY archived_at DESC`,
		);
	}

	// Appends " 2", " 3", ... until `baseName` doesn't collide (case/
	// whitespace-insensitively) with any EXISTING environment, archived or
	// not -- names are meant to be unique enough to tell environments apart
	// wherever they might be listed, not just in the currently-visible set.
	uniqueEnvironmentName(baseName) {
		const trimmedBase = baseName.trim();
		const existingNames = new Set(this.all("SELECT name FROM environments").map((row) => row.name.trim().toLowerCase()));
		if (!existingNames.has(trimmedBase.toLowerCase())) {
			return trimmedBase;
		}
		let attempt = 2;
		while (existingNames.has(`${trimmedBase} ${attempt}`.toLowerCase())) {
			attempt += 1;
		}
		return `${trimmedBase} ${attempt}`;
	}

	// WP-1.5: copies `environmentId`'s SETUP into a brand new environment --
	// icon/accent/preset, isolation mode, its full config document (WP-1.1),
	// and its own Notch layout if it has one (WP-1.3). Deliberately copies
	// NOTHING from any content table (tasks/notes/sessions/activity_blocks/
	// events): duplicating a setup is the point, copying someone's data would
	// be surprising and wrong. `isolation_mode` is copied too even though it
	// is NOT part of `config` (see environment-config.cjs's header for why
	// those stay separate columns) -- it is still part of an environment's
	// SETUP, not its content, so a duplicated "Enclosed" work environment
	// starts out Enclosed as well rather than silently downgrading to the
	// default the moment it's copied.
	duplicateEnvironment(environmentId, name) {
		const source = this.getEnvironment(environmentId);
		if (!source) {
			throw new Error("Environment not found.");
		}

		const sourceConfig = this.getEnvironmentConfig(environmentId);
		const requestedName = typeof name === "string" && name.trim() ? name.trim() : `${source.name} copy`;
		const finalName = this.uniqueEnvironmentName(requestedName);

		return this.transaction(() => {
			const created = this.createEnvironment(finalName, {
				icon: source.icon,
				accent: source.accent,
				preset: source.preset,
			});

			if (source.isolation_mode && source.isolation_mode !== DEFAULT_ISOLATION_MODE) {
				this.setEnvironmentIsolationMode(created.id, source.isolation_mode);
			}

			// Copies every config section EXCEPT notchLayoutId, which is
			// resolved separately below: "copy the layout" (WP-1.3) means
			// giving the duplicate its OWN row when the source has a genuine
			// override, never pointing two environments at the same mutable
			// row (editing one would silently edit the other; deleting either
			// environment would orphan or destroy the other's layout).
			this.setEnvironmentConfig(created.id, {
				appearance: sourceConfig.appearance,
				ai: sourceConfig.ai,
				integrations: sourceConfig.integrations,
				startupBehaviour: sourceConfig.startupBehaviour,
			});

			if (sourceConfig.notchLayoutId && sourceConfig.notchLayoutId !== GLOBAL_DEFAULT_NOTCH_LAYOUT_ID) {
				const sourcePreferences = this.getEffectiveNotchPreferences(environmentId).preferences;
				// Passing the FULL preferences document as the patch means
				// every key is overwritten, not shallow-merged onto whatever
				// the brand-new environment's own (still-default) effective
				// layout happened to be -- the result is an exact copy,
				// forked into its own fresh row.
				this.setEnvironmentNotchLayout(created.id, sourcePreferences);
			}
			// else: the source has no override of its own, so the duplicate
			// simply keeps pointing at the shared global default too --
			// nothing to fork.

			return this.getEnvironment(created.id);
		});
	}

	// The three isolation-mode primitives WP-0.8's scoped accessor
	// (electron/data/scoped.cjs) is built on. None of these are wired to an
	// IPC channel -- there is no renderer-facing way to change an
	// environment's mode yet (that is WP-1.2's UI). They exist so the data
	// layer itself, and tests, have a way to read and change the one column
	// the whole isolation model hinges on, without every caller writing its
	// own raw SQL against `environments`.
	getEnvironmentIsolationMode(environmentId) {
		const row = this.first("SELECT isolation_mode FROM environments WHERE id = ?", [environmentId]);
		// Fail closed: an environment that can't be found has no confirmed
		// mode, so return null rather than guessing `connected` -- callers
		// (scoped.cjs) treat "unknown" as "deny", never as "assume the safe
		// default".
		return row ? row.isolation_mode : null;
	}

	// Every environment's mode in one query -- what the scoped accessor's
	// cross-environment dashboard read uses to build the set of environments
	// that must never appear in another environment's aggregate.
	listEnvironmentIsolationModes() {
		return this.all("SELECT id, name, isolation_mode FROM environments");
	}

	setEnvironmentIsolationMode(environmentId, mode) {
		if (!isValidIsolationMode(mode)) {
			throw new Error(`Invalid isolation mode: ${mode}`);
		}
		const environment = this.first("SELECT id FROM environments WHERE id = ?", [environmentId]);
		if (!environment) {
			throw new Error("Environment not found.");
		}
		this.run("UPDATE environments SET isolation_mode = ? WHERE id = ?", [mode, environmentId]);
		return this.getEnvironmentIsolationMode(environmentId);
	}

	// WP-1.1: an environment's own settings document -- appearance, Notch
	// layout reference, AI defaults, integration enablement, startup
	// behaviour. See electron/config/environment-config.cjs for the schema
	// and defensive parser. `icon`/`accent`/`preset` are pulled in alongside
	// the raw `config` column so a NULL/absent config (every environment
	// created before this column existed) resolves to defaults seeded from
	// that row's own existing data, rather than a generic blank -- in
	// particular so an existing user's accent is never silently reset.
	getEnvironmentConfig(environmentId) {
		const row = this.first("SELECT icon, accent, preset, config FROM environments WHERE id = ?", [environmentId]);
		if (!row) {
			return null;
		}
		return parseEnvironmentConfig(row.config, { icon: row.icon, accent: row.accent, preset: row.preset });
	}

	// Applies a partial patch on top of the environment's current (already
	// defensively-resolved) config, re-normalizes the merged result, and
	// persists it. Throws for an environment that doesn't exist, matching
	// setEnvironmentIsolationMode's contract; re-reads via
	// getEnvironmentConfig afterward so the return value is exactly what a
	// fresh load would produce, not just what this call assembled in memory.
	setEnvironmentConfig(environmentId, patch) {
		const row = this.first("SELECT icon, accent, preset, config FROM environments WHERE id = ?", [environmentId]);
		if (!row) {
			throw new Error("Environment not found.");
		}
		const current = parseEnvironmentConfig(row.config, { icon: row.icon, accent: row.accent, preset: row.preset });
		const next = applyConfigPatch(current, patch);
		this.run("UPDATE environments SET config = ? WHERE id = ?", [serializeEnvironmentConfig(next), environmentId]);
		return this.getEnvironmentConfig(environmentId);
	}

	// WP-1.3: per-environment Notch layouts. `notch_layouts` is keyed by id,
	// not by environment -- many environments (every one with no override)
	// share GLOBAL_DEFAULT_NOTCH_LAYOUT_ID's row, and `environments.config.
	// notchLayoutId` (WP-1.1) is the only thing that ties a SPECIFIC
	// environment to its OWN row instead. See electron/config/notch-
	// layouts.cjs for the pure resolution function every method below
	// delegates the actual "which one wins" decision to -- this class only
	// fetches rows and hands their raw `data` column to that function.
	getNotchLayoutRow(layoutId) {
		if (!layoutId) {
			return null;
		}
		return this.first("SELECT id, data FROM notch_layouts WHERE id = ?", [layoutId]);
	}

	// Resolves the EFFECTIVE Notch preferences for `environmentId`: its own
	// layout if it has one, otherwise the global default. Passing a falsy
	// `environmentId` (no environment selected/active yet, e.g. at app boot
	// before any environment has been switched to) resolves straight to the
	// global default, the same as an environment whose own `notchLayoutId`
	// is null.
	getEffectiveNotchPreferences(environmentId) {
		const config = environmentId ? this.getEnvironmentConfig(environmentId) : null;
		const notchLayoutId = config ? config.notchLayoutId : null;
		const ownRow = notchLayoutId ? this.getNotchLayoutRow(notchLayoutId) : null;
		const defaultRow = this.getNotchLayoutRow(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID);
		return resolveNotchLayout({
			notchLayoutId,
			ownLayoutRaw: ownRow ? ownRow.data : null,
			defaultLayoutRaw: defaultRow ? defaultRow.data : null,
		});
	}

	// Low-level upsert: normalizes `preferences` and writes it to the row at
	// `layoutId` (creating it if it doesn't exist yet), regardless of which
	// environment (if any) currently points at that id. Every higher-level
	// write below (the default, or one environment's own override) goes
	// through this, so there is exactly one place that ever writes a row's
	// `data` column.
	setNotchLayout(layoutId, preferences) {
		const normalized = normalizeNotchPreferences(preferences);
		const now = nowIso();
		this.run(
			`INSERT INTO notch_layouts (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
			[layoutId, JSON.stringify(normalized), now, now],
		);
		return normalized;
	}

	// Edits the GLOBAL DEFAULT layout directly -- `patch` is shallow-merged
	// onto the current default (the same merge shape notch:setPreferences
	// has always used), never onto any specific environment's own override.
	updateGlobalDefaultNotchLayout(patch = {}) {
		const current = this.getEffectiveNotchPreferences(null).preferences;
		const normalized = this.setNotchLayout(GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, { ...current, ...(patch || {}) });
		return { usesDefault: true, layoutId: GLOBAL_DEFAULT_NOTCH_LAYOUT_ID, preferences: normalized };
	}

	// Gives `environmentId` its OWN Notch layout, forking from whatever is
	// currently effective for it (its own layout if it already had one, the
	// default otherwise) and merging `patch` on top -- the same shallow
	// merge updateGlobalDefaultNotchLayout uses. Reuses the environment's
	// existing own-layout id if it has one, so repeated edits update the
	// SAME row instead of orphaning a new one on every save; mints a fresh
	// id (and points the environment's config at it) the first time it
	// diverges from the default.
	setEnvironmentNotchLayout(environmentId, patch = {}) {
		const config = this.getEnvironmentConfig(environmentId);
		if (!config) {
			throw new Error("Environment not found.");
		}
		const currentEffective = this.getEffectiveNotchPreferences(environmentId).preferences;
		const layoutId = config.notchLayoutId || randomUUID();
		const normalized = this.setNotchLayout(layoutId, { ...currentEffective, ...(patch || {}) });
		if (config.notchLayoutId !== layoutId) {
			this.setEnvironmentConfig(environmentId, { notchLayoutId: layoutId });
		}
		return { usesDefault: false, layoutId, preferences: normalized };
	}

	// Reverts `environmentId` to the global default -- clears the reference
	// only. Deliberately leaves the now-unreferenced notch_layouts row in
	// place rather than deleting it (the same "migrate, never destroy"
	// discipline as everywhere else in this schema): flipping back to a
	// custom layout later mints a fresh row rather than resurrecting this
	// one (see setEnvironmentNotchLayout), so nothing is lost by leaving it,
	// and deleteEnvironment is what actually cleans up an orphaned row, once
	// the environment itself is gone for good.
	clearEnvironmentNotchLayout(environmentId) {
		const config = this.getEnvironmentConfig(environmentId);
		if (!config) {
			throw new Error("Environment not found.");
		}
		this.setEnvironmentConfig(environmentId, { notchLayoutId: null });
		return this.getEffectiveNotchPreferences(environmentId);
	}

	getSessionById(sessionId) {
		return normalizeSession(this.first("SELECT * FROM sessions WHERE id = ?", [sessionId]));
	}

	getActiveSession() {
		return normalizeSession(
			this.first("SELECT * FROM sessions WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"),
		);
	}

	startSession(environmentId) {
		const active = this.getActiveSession();
		if (active) {
			throw new Error("A session is already active.");
		}

		const environment = this.first("SELECT id FROM environments WHERE id = ?", [environmentId]);
		if (!environment) {
			throw new Error("Environment not found.");
		}

		const session = {
			id: randomUUID(),
			environment_id: environmentId,
			started_at: nowIso(),
			created_at: nowIso(),
		};

		this.run(
			`INSERT INTO sessions (
        id, environment_id, started_at, created_at, is_active, is_paused,
        paused_duration, total_duration
      ) VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
			[session.id, session.environment_id, session.started_at, session.created_at],
		);

		return this.getSessionById(session.id);
	}

	pauseSession(sessionId) {
		const session = this.getSessionById(sessionId);
		if (!session || !session.is_active) {
			throw new Error("No active session found to pause.");
		}
		if (session.is_paused) {
			return session;
		}

		const pauseStartedAt = nowIso();

		this.transaction(() => {
			this.run("UPDATE sessions SET is_paused = 1, pause_started_at = ? WHERE id = ?", [pauseStartedAt, sessionId]);

			this.run("INSERT INTO pauses (id, session_id, started_at) VALUES (?, ?, ?)", [
				randomUUID(),
				sessionId,
				pauseStartedAt,
			]);
		});

		return this.getSessionById(sessionId);
	}

	resumeSession(sessionId) {
		const session = this.getSessionById(sessionId);
		if (!session || !session.is_active) {
			throw new Error("No active session found to resume.");
		}
		if (!session.is_paused || !session.pause_started_at) {
			return session;
		}

		const resumedAt = nowIso();
		const pauseDelta = toDurationMs(session.pause_started_at, resumedAt);
		const newPausedDuration = session.paused_duration + pauseDelta;

		this.transaction(() => {
			this.run(
				`UPDATE sessions
       SET is_paused = 0,
           pause_started_at = NULL,
           paused_duration = ?
       WHERE id = ?`,
				[newPausedDuration, sessionId],
			);

			this.run(
				`UPDATE pauses
       SET ended_at = ?
       WHERE session_id = ? AND ended_at IS NULL`,
				[resumedAt, sessionId],
			);
		});

		return this.getSessionById(sessionId);
	}

	stopSession(sessionId) {
		const active = this.getSessionById(sessionId);
		if (!active) {
			throw new Error("No active session found to stop.");
		}

		if (!active.is_active) {
			return active;
		}

		const endedAt = nowIso();
		let pausedDuration = active.paused_duration;

		this.transaction(() => {
			if (active.is_paused && active.pause_started_at) {
				const trailingPause = toDurationMs(active.pause_started_at, endedAt);
				pausedDuration += trailingPause;

				this.run(
					`UPDATE pauses
         SET ended_at = ?
         WHERE session_id = ? AND ended_at IS NULL`,
					[endedAt, sessionId],
				);
			}

			const totalDuration = Math.max(0, toDurationMs(active.started_at, endedAt) - pausedDuration);

			this.run(
				`UPDATE sessions
       SET ended_at = ?,
           total_duration = ?,
           paused_duration = ?,
           is_active = 0,
           is_paused = 0,
           pause_started_at = NULL
       WHERE id = ?`,
				[endedAt, totalDuration, pausedDuration, sessionId],
			);

			this.closeOpenActivityBlock(sessionId, endedAt);
		});

		return this.getSessionById(sessionId);
	}

	listSessionsByEnvironment(environmentId) {
		return this.all(
			`SELECT * FROM sessions
       WHERE environment_id = ?
       ORDER BY created_at DESC`,
			[environmentId],
		).map(normalizeSession);
	}

	deleteSession(sessionId) {
		const session = this.getSessionById(sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}

		if (session.is_active) {
			throw new Error("Cannot delete an active session. Stop it first.");
		}

		this.transaction(() => {
			this.run(`DELETE FROM pauses WHERE session_id = ?`, [sessionId]);
			this.run(`DELETE FROM activity_blocks WHERE session_id = ?`, [sessionId]);
			this.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
		});

		return true;
	}

	listSessionsInRange(startIso, endIso) {
		return this.all(
			`SELECT s.*, e.name AS environment_name
       FROM sessions s
       LEFT JOIN environments e ON e.id = s.environment_id
       WHERE s.started_at >= ? AND s.started_at < ?
       ORDER BY s.started_at DESC`,
			[startIso, endIso],
		).map(normalizeSession);
	}

	listActivityBlocksBySession(sessionId) {
		return this.all(
			`SELECT * FROM activity_blocks
       WHERE session_id = ?
       ORDER BY started_at ASC`,
			[sessionId],
		);
	}

	getOpenActivityBlock(sessionId) {
		return this.first(
			`SELECT * FROM activity_blocks
       WHERE session_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
			[sessionId],
		);
	}

	closeOpenActivityBlock(sessionId, endedAt) {
		const openBlock = this.getOpenActivityBlock(sessionId);
		if (!openBlock) {
			return null;
		}

		// Get the session to validate block doesn't exceed session bounds
		const session = this.getSessionById(sessionId);
		if (!session) {
			return null;
		}

		// Calculate duration, ensuring it doesn't exceed session window
		let actualEndTime = endedAt;
		if (session.ended_at) {
			// If session is already ended, cap the block end time at session end
			const sessionEnd = new Date(session.ended_at).getTime();
			const blockEnd = new Date(endedAt).getTime();
			if (blockEnd > sessionEnd) {
				actualEndTime = session.ended_at;
			}
		}

		const duration = toDurationMs(openBlock.started_at, actualEndTime);

		this.run(
			`UPDATE activity_blocks
       SET ended_at = ?, duration = ?
       WHERE id = ?`,
			[actualEndTime, duration, openBlock.id],
		);

		return {
			...openBlock,
			ended_at: actualEndTime,
			duration,
		};
	}

	createActivityBlock(sessionId, appName, startedAt) {
		const session = this.getSessionById(sessionId);

		// Safeguard: don't create activity blocks for ended sessions
		if (!session || !session.is_active || session.ended_at) {
			return null;
		}

		const block = {
			id: randomUUID(),
			session_id: sessionId,
			app_name: appName,
			started_at: startedAt,
		};

		this.run(
			`INSERT INTO activity_blocks (id, session_id, app_name, started_at, duration)
       VALUES (?, ?, ?, ?, 0)`,
			[block.id, block.session_id, block.app_name, block.started_at],
		);

		return block;
	}

	listTasksByEnvironment(environmentId) {
		return this.all(
			`SELECT id, environment_id, title, description, status, priority, tags, due_date, created_at, updated_at
       FROM tasks
       WHERE environment_id = ?
       ORDER BY created_at DESC`,
			[environmentId],
		).map(normalizeTask);
	}

	getTaskById(taskId) {
		return normalizeTask(this.first("SELECT * FROM tasks WHERE id = ?", [taskId]));
	}

	createTask(environmentId, title, description = "", fields = {}) {
		const task = {
			id: randomUUID(),
			environment_id: environmentId,
			title,
			description,
			status: typeof fields.status === "string" && fields.status ? fields.status : "todo",
			priority: TASK_PRIORITIES.includes(fields.priority) ? fields.priority : "none",
			tags: Array.isArray(fields.tags) ? fields.tags.filter((tag) => typeof tag === "string") : [],
			due_date: fields.due_date || null,
			created_at: nowIso(),
			updated_at: nowIso(),
		};

		this.run(
			`INSERT INTO tasks (id, environment_id, title, description, status, priority, tags, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				task.id,
				task.environment_id,
				task.title,
				task.description,
				task.status,
				task.priority,
				JSON.stringify(task.tags),
				task.due_date,
				task.created_at,
				task.updated_at,
			],
		);

		return task;
	}

	updateTaskStatus(taskId, status) {
		this.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), taskId]);
		return normalizeTask(this.first("SELECT * FROM tasks WHERE id = ?", [taskId]));
	}

	// General task editor used by the task detail panel: updates only the fields
	// present in `fields` (title/description/status/priority/tags/due_date).
	updateTask(taskId, fields = {}) {
		const sets = [];
		const values = [];
		for (const key of ["title", "description", "status", "priority", "due_date"]) {
			if (key in fields) {
				sets.push(`${key} = ?`);
				values.push(key === "priority" && !TASK_PRIORITIES.includes(fields[key]) ? "none" : fields[key]);
			}
		}
		if ("tags" in fields) {
			sets.push("tags = ?");
			values.push(JSON.stringify(Array.isArray(fields.tags) ? fields.tags.filter((t) => typeof t === "string") : []));
		}
		sets.push("updated_at = ?");
		values.push(nowIso());
		values.push(taskId);
		this.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, values);
		return normalizeTask(this.first("SELECT * FROM tasks WHERE id = ?", [taskId]));
	}

	deleteTask(taskId) {
		this.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		return true;
	}

	listNotesByEnvironment(environmentId) {
		if (!environmentId) {
			return [];
		}
		return [this.getNotebookByEnvironment(environmentId)];
	}

	// Added for WP-0.8: the scoped accessor needs a way to look up which
	// environment owns a bare note id (`note:update`/`note:delete` are
	// called with only the id, no environment id, so ownership has to be
	// resolved from the row itself before an update/delete can be scoped).
	getNoteById(noteId) {
		return this.first("SELECT id, environment_id, content, created_at, updated_at FROM notes WHERE id = ?", [
			noteId,
		]);
	}

	createNote(environmentId, content = "") {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}

		const existing = this.first(
			`SELECT id, environment_id, content, created_at, updated_at
       FROM notes
       WHERE environment_id = ?
       LIMIT 1`,
			[environmentId],
		);

		if (existing) {
			const nextContent = content || existing.content;
			this.run("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", [nextContent, nowIso(), existing.id]);
			return this.first("SELECT id, environment_id, content, created_at, updated_at FROM notes WHERE id = ?", [
				existing.id,
			]);
		}

		const note = {
			id: randomUUID(),
			environment_id: environmentId,
			content: content || createEmptyNotebookDocument(),
			created_at: nowIso(),
			updated_at: nowIso(),
		};

		this.run("INSERT INTO notes (id, environment_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
			note.id,
			note.environment_id,
			note.content,
			note.created_at,
			note.updated_at,
		]);

		return note;
	}

	updateNote(noteId, content) {
		this.run("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", [content, nowIso(), noteId]);
		return this.first("SELECT * FROM notes WHERE id = ?", [noteId]);
	}

	deleteNote(noteId) {
		this.run("DELETE FROM notes WHERE id = ?", [noteId]);
	}

	getNotebookByEnvironment(environmentId) {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}

		const existing = this.first(
			`SELECT id, environment_id, content, created_at, updated_at
       FROM notes
       WHERE environment_id = ?
       LIMIT 1`,
			[environmentId],
		);

		if (existing) {
			return existing;
		}

		return this.createNote(environmentId, createEmptyNotebookDocument());
	}

	updateNotebookByEnvironment(environmentId, content) {
		if (!environmentId) {
			throw new Error("Environment id is required.");
		}

		return this.transaction(() => {
			const notebook = this.getNotebookByEnvironment(environmentId);
			this.run("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", [content, nowIso(), notebook.id]);
			return this.first("SELECT id, environment_id, content, created_at, updated_at FROM notes WHERE id = ?", [
				notebook.id,
			]);
		});
	}

	getDashboardOverview(environmentId) {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		const startIso = start.toISOString();
		const endIso = end.toISOString();

		const todaySessions = this.listSessionsInRange(startIso, endIso);
		const environmentSessions = todaySessions.filter((session) => session.environment_id === environmentId);

		const totalTodayMs = environmentSessions.reduce((acc, session) => {
			if (session.is_active) {
				const pausedExtra =
					session.is_paused && session.pause_started_at
						? toDurationMs(session.pause_started_at, nowIso())
						: 0;
				const paused = session.paused_duration + pausedExtra;
				return acc + Math.max(0, toDurationMs(session.started_at, nowIso()) - paused);
			}
			return acc + session.total_duration;
		}, 0);

		const appTotals = {};
		for (const session of environmentSessions) {
			const blocks = this.listActivityBlocksBySession(session.id);
			for (const block of blocks) {
				// For completed sessions: always use block.duration, never recalculate from now
				// For active sessions: can recalculate open blocks from now
				const amount = session.is_active
					? block.ended_at
						? block.duration
						: toDurationMs(block.started_at, nowIso())
					: block.duration || 0;
				appTotals[block.app_name] = (appTotals[block.app_name] ?? 0) + amount;
			}
		}

		const timePerApp = Object.entries(appTotals)
			.map(([appName, duration]) => ({ appName, duration }))
			.sort((a, b) => b.duration - a.duration)
			.slice(0, 8);

		const environmentTotals = {};
		for (const session of todaySessions) {
			const key = session.environment_name || "Untitled environment";
			const amount = session.is_active
				? Math.max(0, toDurationMs(session.started_at, nowIso()) - session.paused_duration)
				: session.total_duration;
			environmentTotals[key] = (environmentTotals[key] ?? 0) + amount;
		}

		const timePerEnvironment = Object.entries(environmentTotals)
			.map(([environmentName, duration]) => ({ environmentName, duration }))
			.sort((a, b) => b.duration - a.duration);

		const taskRow = this.first(
			"SELECT COUNT(*) AS count FROM tasks WHERE environment_id = ? AND status != 'done'",
			[environmentId],
		);

		return {
			totalTodayMs,
			timePerApp,
			timePerEnvironment,
			quickStats: {
				sessionsToday: environmentSessions.length,
				openTasks: taskRow?.count ?? 0,
			},
		};
	}
}

module.exports = {
	AtlasDatabase,
};
