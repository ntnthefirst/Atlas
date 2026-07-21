// ---------------------------------------------------------------------------
// Batched event log (WP-0.5).
//
// This is the substrate the entire findings engine (Phase 3) will read from,
// and it is the most privacy-sensitive thing Atlas writes: app identity and
// coarse action types only, never window title content, keystrokes,
// clipboard data, or note/task body text. Every call site that feeds this
// module is responsible for not handing it anything richer than that — this
// module itself has no way to tell a title from an id, so the discipline has
// to live at the call site.
//
// The design is dictated by D9 (see IMPLEMENTATION-PLAN.md): node-sqlite3-wasm
// is real SQLite with a filesystem VFS, and writing one row per event with its
// own transaction measured at ~12.7ms/insert -- 800x slower than the same
// writes batched into one transaction (~0.016ms/insert). An event log writes
// continuously, so unbatched writes here would make the whole app feel
// broken. The fix is the classic one: buffer in memory, flush the whole
// buffer inside a single `db.transaction(...)` call, on a timer and on quit.
//
// A broken event log must never break the app: `record()` swallows every
// error, and a flush failure is logged and the batch dropped rather than
// retried into an ever-growing buffer or rethrown into a timer/quit handler
// that isn't expecting it.
// ---------------------------------------------------------------------------

"use strict";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
// A burst (rapid app-switching, a scripted test) must not grow the in-memory
// buffer unboundedly between timer ticks, so it also flushes early past this
// size.
const DEFAULT_MAX_BUFFER = 500;
// The vision doc explicitly promises not to hoard behavioural data: prune
// anything older than this on every boot.
const DEFAULT_RETENTION_DAYS = 90;
// Belt-and-braces cap independent of age, in case retention is widened later
// or a single environment is unusually chatty.
const DEFAULT_ROW_CAP = 500000;

// Query helpers below default to a bounded page rather than an unbounded
// `SELECT *`, so a miner query against months of history can't accidentally
// pull the whole table into memory. Callers that genuinely need more can ask
// for up to MAX_QUERY_LIMIT explicitly.
const DEFAULT_QUERY_LIMIT = 1000;
const MAX_QUERY_LIMIT = 10000;

function normalizeLimit(limit) {
	const parsed = Number(limit);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_QUERY_LIMIT;
	}
	return Math.min(Math.floor(parsed), MAX_QUERY_LIMIT);
}

// Every optional field is coerced to a string or null -- never anything else
// -- so a caller can't accidentally serialize an object (which risks carrying
// more detail than intended) into a column meant to hold a short identifier.
function toNullableText(value) {
	if (value === undefined || value === null) {
		return null;
	}
	return String(value);
}

function serializePayload(payload) {
	if (payload === undefined || payload === null) {
		return null;
	}
	try {
		return JSON.stringify(payload);
	} catch {
		// Circular or otherwise unserializable -- drop the payload rather than
		// let a bad event break the whole flush.
		return null;
	}
}

function parseEventRow(row) {
	if (!row) {
		return row;
	}
	let payload = null;
	if (typeof row.payload === "string" && row.payload) {
		try {
			payload = JSON.parse(row.payload);
		} catch {
			payload = null;
		}
	}
	return {
		id: row.id,
		ts: row.ts,
		environmentId: row.environment_id ?? null,
		type: row.type,
		subject: row.subject ?? null,
		payload,
		sessionId: row.session_id ?? null,
	};
}

class EventLog {
	// `db` is anything exposing `run`/`all`/`first`/`transaction` -- in
	// practice an AtlasDatabase instance. Options let callers (and tests)
	// override the timer cadence, buffer cap, and retention policy without
	// touching module-level constants.
	constructor(db, options = {}) {
		this.db = db;
		this.buffer = [];
		this.timer = null;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER;
		this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
		this.rowCap = options.rowCap ?? DEFAULT_ROW_CAP;
	}

	start() {
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => this.flushNow(), this.flushIntervalMs);
		// Never hold the process open just to flush the event log -- `before-quit`
		// below is what guarantees a clean-quit flush, not this timer.
		if (typeof this.timer.unref === "function") {
			this.timer.unref();
		}
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	// Appends to the in-memory buffer. Must be cheap (no I/O) and must never
	// throw into the caller -- a broken event log must not break the feature
	// that triggered it (a task completing, a session starting, ...).
	//
	// `options`: { environmentId, subject, payload, sessionId }. Every field is
	// optional; `type` is the only required argument.
	record(type, options = {}) {
		try {
			if (typeof type !== "string" || !type.trim()) {
				return;
			}
			const { environmentId, subject, payload, sessionId } = options || {};
			this.buffer.push({
				ts: new Date().toISOString(),
				environmentId: toNullableText(environmentId),
				type: type.trim(),
				subject: toNullableText(subject),
				payload: serializePayload(payload),
				sessionId: toNullableText(sessionId),
			});

			if (this.buffer.length >= this.maxBufferSize) {
				this.flushNow();
			}
		} catch (error) {
			console.error("[Atlas] event-log record() failed (event dropped):", error);
		}
	}

	// Test/inspection seam.
	pendingCount() {
		return this.buffer.length;
	}

	// Writes the whole buffer inside ONE transaction. Safe to call from a
	// timer, from `before-quit`, or directly in tests. Never throws -- a
	// failed flush drops the batch rather than risking an unbounded retry
	// buffer or an uncaught exception inside a quit handler.
	flushNow() {
		if (this.buffer.length === 0) {
			return;
		}

		const batch = this.buffer;
		this.buffer = [];

		try {
			this.db.transaction(() => {
				for (const event of batch) {
					this.db.run(
						`INSERT INTO events (ts, environment_id, type, subject, payload, session_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
						[event.ts, event.environmentId, event.type, event.subject, event.payload, event.sessionId],
					);
				}
			});
		} catch (error) {
			console.error(`[Atlas] event-log flush failed; ${batch.length} event(s) dropped:`, error);
		}
	}

	// Retention: age-based window plus a hard row cap, run inside a
	// transaction. Intended to be called once on boot; exposed as an instance
	// method (rather than only the standalone `pruneEvents` below) so callers
	// that already hold an EventLog don't need to import the pure function
	// separately.
	pruneNow(options = {}) {
		return pruneEvents(this.db, {
			retentionDays: options.retentionDays ?? this.retentionDays,
			rowCap: options.rowCap ?? this.rowCap,
		});
	}
}

// Standalone so retention can be unit-tested (and invoked) without spinning
// up a full EventLog writer -- e.g. from a boot sequence that only wants to
// prune, or a test that seeds rows directly.
function pruneEvents(db, options = {}) {
	const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
	const rowCap = options.rowCap ?? DEFAULT_ROW_CAP;

	return db.transaction(() => {
		let deletedByAge = 0;
		let deletedByCap = 0;

		if (Number.isFinite(retentionDays) && retentionDays > 0) {
			const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
			const before = db.first("SELECT COUNT(*) AS count FROM events")?.count ?? 0;
			db.run("DELETE FROM events WHERE ts < ?", [cutoff]);
			const after = db.first("SELECT COUNT(*) AS count FROM events")?.count ?? 0;
			deletedByAge = before - after;
		}

		if (Number.isFinite(rowCap) && rowCap > 0) {
			const count = db.first("SELECT COUNT(*) AS count FROM events")?.count ?? 0;
			if (count > rowCap) {
				const excess = count - rowCap;
				// Oldest rows first (ts, then id as a tiebreaker for same-millisecond
				// writes from a batched flush).
				db.run("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts ASC, id ASC LIMIT ?)", [
					excess,
				]);
				deletedByCap = excess;
			}
		}

		return { deletedByAge, deletedByCap };
	});
}

// --- Query helpers for the Phase 3 miner -----------------------------------
// Deliberately pure SQL + parameters, taking `db` explicitly rather than
// living only on EventLog, so the miner (and tests) can query without caring
// whether a writer/timer exists at all.

function listEventsInRange(db, startIso, endIso, options = {}) {
	return db
		.all("SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT ?", [
			startIso,
			endIso,
			normalizeLimit(options.limit),
		])
		.map(parseEventRow);
}

function listEventsByType(db, type, options = {}) {
	const params = [type];
	let sql = "SELECT * FROM events WHERE type = ?";
	if (options.startIso) {
		sql += " AND ts >= ?";
		params.push(options.startIso);
	}
	if (options.endIso) {
		sql += " AND ts < ?";
		params.push(options.endIso);
	}
	sql += " ORDER BY ts ASC, id ASC LIMIT ?";
	params.push(normalizeLimit(options.limit));
	return db.all(sql, params).map(parseEventRow);
}

function listEventsByEnvironment(db, environmentId, options = {}) {
	const params = [environmentId];
	let sql = "SELECT * FROM events WHERE environment_id = ?";
	if (options.startIso) {
		sql += " AND ts >= ?";
		params.push(options.startIso);
	}
	if (options.endIso) {
		sql += " AND ts < ?";
		params.push(options.endIso);
	}
	sql += " ORDER BY ts ASC, id ASC LIMIT ?";
	params.push(normalizeLimit(options.limit));
	return db.all(sql, params).map(parseEventRow);
}

// Sequence lookup: everything that happened after event `eventId`, within
// `withinMinutes` of it. This is what lets the miner ask "what tends to
// follow a task.complete?" or "does app.focus on X precede session.stop?".
//
// Ties on `ts` (perfectly plausible after a batched flush inserts several
// events with the same millisecond) are broken by `id`, which is
// monotonically increasing insertion order -- so an event never "follows"
// itself and same-millisecond events still come back in a stable order.
function listEventsFollowing(db, eventId, options = {}) {
	const anchor = db.first("SELECT * FROM events WHERE id = ?", [eventId]);
	if (!anchor) {
		return [];
	}

	const withinMinutes =
		Number.isFinite(options.withinMinutes) && options.withinMinutes > 0 ? options.withinMinutes : 30;
	const windowEnd = new Date(new Date(anchor.ts).getTime() + withinMinutes * 60000).toISOString();

	const params = [anchor.ts, anchor.ts, anchor.id, windowEnd];
	let sql = "SELECT * FROM events WHERE (ts > ? OR (ts = ? AND id > ?)) AND ts <= ?";

	if (Array.isArray(options.types) && options.types.length > 0) {
		sql += ` AND type IN (${options.types.map(() => "?").join(", ")})`;
		params.push(...options.types);
	}

	sql += " ORDER BY ts ASC, id ASC LIMIT ?";
	params.push(normalizeLimit(options.limit));

	return db.all(sql, params).map(parseEventRow);
}

module.exports = {
	EventLog,
	pruneEvents,
	listEventsInRange,
	listEventsByType,
	listEventsByEnvironment,
	listEventsFollowing,
	DEFAULT_FLUSH_INTERVAL_MS,
	DEFAULT_MAX_BUFFER,
	DEFAULT_RETENTION_DAYS,
	DEFAULT_ROW_CAP,
	DEFAULT_QUERY_LIMIT,
	MAX_QUERY_LIMIT,
};
