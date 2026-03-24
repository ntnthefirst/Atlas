const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");
const { randomUUID } = require("node:crypto");

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
	static async create(dbPath) {
		const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
		const SQL = await initSqlJs({
			locateFile: (file) => {
				if (file === "sql-wasm.wasm") {
					return wasmPath;
				}
				return path.join(path.dirname(wasmPath), file);
			},
		});

		let db;
		if (fs.existsSync(dbPath)) {
			db = new SQL.Database(fs.readFileSync(dbPath));
		} else {
			db = new SQL.Database();
		}

		return new AtlasDatabase(dbPath, db);
	}

	constructor(dbPath, db) {
		this.dbPath = dbPath;
		this.db = db;
		this.initSchema();
	}

	persist() {
		const bytes = this.db.export();
		fs.writeFileSync(this.dbPath, Buffer.from(bytes));
	}

	run(sql, params = []) {
		this.db.run(sql, params);
		this.persist();
	}

	first(sql, params = []) {
		const rows = this.all(sql, params);
		return rows[0] ?? null;
	}

	all(sql, params = []) {
		const statement = this.db.prepare(sql, params);
		const rows = [];
		while (statement.step()) {
			rows.push(statement.getAsObject());
		}
		statement.free();
		return rows;
	}

	tableExists(tableName) {
		const row = this.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
		return Boolean(row);
	}

	columnExists(tableName, columnName) {
		if (!this.tableExists(tableName)) {
			return false;
		}
		const cols = this.all(`PRAGMA table_info(${tableName})`);
		return cols.some((col) => col.name === columnName);
	}

	initSchema() {
		this.run(
			`CREATE TABLE IF NOT EXISTS maps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
		);

		this.run(
			`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        map_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        total_duration INTEGER DEFAULT 0,
        paused_duration INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        is_paused INTEGER DEFAULT 0,
        pause_started_at TEXT,
        created_at TEXT NOT NULL
      )`,
		);

		this.run(
			`CREATE TABLE IF NOT EXISTS pauses (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`,
		);

		this.run(
			`CREATE TABLE IF NOT EXISTS activity_blocks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration INTEGER DEFAULT 0
      )`,
		);

		this.run(
			`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
		);

		this.run(
			`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
		);
	}

	/**
	 * Finalize any stranded sessions marked as active but actually ended.
	 * Called on app startup to handle crash scenarios or stale data.
	 */
	finalizeStrandedSessions() {
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
	}

	/**
	 * Repair corrupted session data where app durations exceed session duration.
	 * Rebuilds app durations from activity block timestamps.
	 */
	repairCorruptedSessions() {
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

	listMaps() {
		return this.all("SELECT id, name, created_at FROM maps ORDER BY created_at ASC");
	}

	createMap(name) {
		const map = {
			id: randomUUID(),
			name,
			created_at: nowIso(),
		};

		this.run("INSERT INTO maps (id, name, created_at) VALUES (?, ?, ?)", [map.id, map.name, map.created_at]);

		return map;
	}

	renameMap(mapId, name) {
		this.run("UPDATE maps SET name = ? WHERE id = ?", [name, mapId]);
		return this.first("SELECT id, name, created_at FROM maps WHERE id = ?", [mapId]);
	}

	deleteMap(mapId) {
		const map = this.first("SELECT id FROM maps WHERE id = ?", [mapId]);
		if (!map) {
			throw new Error("Map not found.");
		}

		const activeSession = this.getActiveSession();
		if (activeSession && activeSession.map_id === mapId) {
			throw new Error("Stop the active session in this map before deleting it.");
		}

		const sessionIds = this.all("SELECT id FROM sessions WHERE map_id = ?", [mapId]).map((row) => row.id);
		if (sessionIds.length > 0) {
			const placeholders = sessionIds.map(() => "?").join(", ");
			this.run(`DELETE FROM pauses WHERE session_id IN (${placeholders})`, sessionIds);
			this.run(`DELETE FROM activity_blocks WHERE session_id IN (${placeholders})`, sessionIds);
			this.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
		}

		this.run("DELETE FROM tasks WHERE map_id = ?", [mapId]);
		this.run("DELETE FROM notes WHERE map_id = ?", [mapId]);
		this.run("DELETE FROM maps WHERE id = ?", [mapId]);
		return true;
	}

	getSessionById(sessionId) {
		return normalizeSession(this.first("SELECT * FROM sessions WHERE id = ?", [sessionId]));
	}

	getActiveSession() {
		return normalizeSession(
			this.first("SELECT * FROM sessions WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"),
		);
	}

	startSession(mapId) {
		const active = this.getActiveSession();
		if (active) {
			throw new Error("A session is already active.");
		}

		const map = this.first("SELECT id FROM maps WHERE id = ?", [mapId]);
		if (!map) {
			throw new Error("Map not found.");
		}

		const session = {
			id: randomUUID(),
			map_id: mapId,
			started_at: nowIso(),
			created_at: nowIso(),
		};

		this.run(
			`INSERT INTO sessions (
        id, map_id, started_at, created_at, is_active, is_paused,
        paused_duration, total_duration
      ) VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
			[session.id, session.map_id, session.started_at, session.created_at],
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

		this.run("UPDATE sessions SET is_paused = 1, pause_started_at = ? WHERE id = ?", [pauseStartedAt, sessionId]);

		this.run("INSERT INTO pauses (id, session_id, started_at) VALUES (?, ?, ?)", [
			randomUUID(),
			sessionId,
			pauseStartedAt,
		]);

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

		return this.getSessionById(sessionId);
	}

	listSessionsByMap(mapId) {
		return this.all(
			`SELECT * FROM sessions
       WHERE map_id = ?
       ORDER BY created_at DESC`,
			[mapId],
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

		this.run(`DELETE FROM pauses WHERE session_id = ?`, [sessionId]);

		this.run(`DELETE FROM activity_blocks WHERE session_id = ?`, [sessionId]);

		this.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);

		return true;
	}

	listSessionsInRange(startIso, endIso) {
		return this.all(
			`SELECT s.*, m.name AS map_name
       FROM sessions s
       LEFT JOIN maps m ON m.id = s.map_id
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

	listTasksByMap(mapId) {
		return this.all(
			`SELECT id, map_id, title, description, status, created_at, updated_at
       FROM tasks
       WHERE map_id = ?
       ORDER BY created_at DESC`,
			[mapId],
		);
	}

	createTask(mapId, title, description = "") {
		const task = {
			id: randomUUID(),
			map_id: mapId,
			title,
			description,
			status: "todo",
			created_at: nowIso(),
			updated_at: nowIso(),
		};

		this.run(
			`INSERT INTO tasks (id, map_id, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[task.id, task.map_id, task.title, task.description, task.status, task.created_at, task.updated_at],
		);

		return task;
	}

	updateTaskStatus(taskId, status) {
		this.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), taskId]);
		return this.first("SELECT * FROM tasks WHERE id = ?", [taskId]);
	}

	listNotesByMap(mapId) {
		if (!mapId) {
			return [];
		}
		return [this.getNotebookByMap(mapId)];
	}

	createNote(mapId, content = "") {
		if (!mapId) {
			throw new Error("Map id is required.");
		}

		const existing = this.first(
			`SELECT id, map_id, content, created_at, updated_at
       FROM notes
       WHERE map_id = ?
       LIMIT 1`,
			[mapId],
		);

		if (existing) {
			const nextContent = content || existing.content;
			this.run("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", [nextContent, nowIso(), existing.id]);
			return this.first("SELECT id, map_id, content, created_at, updated_at FROM notes WHERE id = ?", [
				existing.id,
			]);
		}

		const note = {
			id: randomUUID(),
			map_id: mapId,
			content: content || createEmptyNotebookDocument(),
			created_at: nowIso(),
			updated_at: nowIso(),
		};

		this.run("INSERT INTO notes (id, map_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
			note.id,
			note.map_id,
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

	getNotebookByMap(mapId) {
		if (!mapId) {
			throw new Error("Map id is required.");
		}

		const existing = this.first(
			`SELECT id, map_id, content, created_at, updated_at
       FROM notes
       WHERE map_id = ?
       LIMIT 1`,
			[mapId],
		);

		if (existing) {
			return existing;
		}

		return this.createNote(mapId, createEmptyNotebookDocument());
	}

	updateNotebookByMap(mapId, content) {
		if (!mapId) {
			throw new Error("Map id is required.");
		}

		const notebook = this.getNotebookByMap(mapId);
		this.run("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", [content, nowIso(), notebook.id]);
		return this.first("SELECT id, map_id, content, created_at, updated_at FROM notes WHERE id = ?", [notebook.id]);
	}

	getDashboardOverview(mapId) {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		const startIso = start.toISOString();
		const endIso = end.toISOString();

		const todaySessions = this.listSessionsInRange(startIso, endIso);
		const mapSessions = todaySessions.filter((session) => session.map_id === mapId);

		const totalTodayMs = mapSessions.reduce((acc, session) => {
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
		for (const session of mapSessions) {
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

		const mapTotals = {};
		for (const session of todaySessions) {
			const key = session.map_name || "Untitled map";
			const amount = session.is_active
				? Math.max(0, toDurationMs(session.started_at, nowIso()) - session.paused_duration)
				: session.total_duration;
			mapTotals[key] = (mapTotals[key] ?? 0) + amount;
		}

		const timePerMap = Object.entries(mapTotals)
			.map(([mapName, duration]) => ({ mapName, duration }))
			.sort((a, b) => b.duration - a.duration);

		const taskRow = this.first("SELECT COUNT(*) AS count FROM tasks WHERE map_id = ? AND status != 'done'", [
			mapId,
		]);

		return {
			totalTodayMs,
			timePerApp,
			timePerMap,
			quickStats: {
				sessionsToday: mapSessions.length,
				openTasks: taskRow?.count ?? 0,
			},
		};
	}
}

module.exports = {
	AtlasDatabase,
};
