const { randomUUID } = require("node:crypto");
const { Database } = require("node-sqlite3-wasm");
const { wrapDatabase } = require("./migrations/sqlite-helpers.cjs");
const { runMigrations } = require("./migrations/index.cjs");
const { importLegacyDatabaseIfNeeded } = require("./migrations/legacy-import.cjs");

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

	listEnvironments() {
		return this.all("SELECT id, name, icon, accent, preset, created_at FROM environments ORDER BY created_at ASC");
	}

	getEnvironment(environmentId) {
		return this.first("SELECT id, name, icon, accent, preset, created_at FROM environments WHERE id = ?", [
			environmentId,
		]);
	}

	createEnvironment(name, options = {}) {
		const environment = {
			id: randomUUID(),
			name,
			icon: options.icon ?? null,
			accent: options.accent ?? null,
			preset: options.preset ?? null,
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
		if (updates.length > 0) {
			this.run(`UPDATE environments SET ${updates.join(", ")} WHERE id = ?`, [...values, environmentId]);
		}
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
			this.run("DELETE FROM environments WHERE id = ?", [environmentId]);
			return true;
		});
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
