// Migration 003 — the event log (WP-0.5): a single, append-only table that
// becomes the substrate the findings engine (Phase 3) reads from. See D9 in
// IMPLEMENTATION-PLAN.md for why this table is written through a batched
// writer (electron/services/event-log.cjs) rather than one INSERT per event —
// node-sqlite3-wasm is ~800x slower unbatched, and this is the one table
// expected to grow continuously for as long as Atlas runs.
//
// Columns match the shape decided in the plan exactly: `environment_id` and
// `subject` are nullable (not every event belongs to an environment, and not
// every event has a natural "subject" beyond its type), `ts` is ISO-8601
// text (consistent with every other timestamp column in this schema), and
// `payload` is a JSON string for whatever small amount of structured detail
// an event type wants to carry — never free text, per the privacy rule in
// the plan (no window titles, no keystrokes, no note/task body content).
"use strict";

module.exports = {
	version: 3,
	name: "003_event_log",

	up(db) {
		db.run(
			`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        environment_id TEXT,
        type TEXT NOT NULL,
        subject TEXT,
        payload TEXT,
        session_id TEXT
      )`,
		);

		// The miner's primary access patterns, per the WP: a pure time-range scan
		// across every event type (idx_events_ts), and a scan for one event type
		// across a time range (idx_events_type_ts) — e.g. "every task.complete in
		// the last 30 days". A plain index on `type` alone would still need a
		// separate sort by `ts` afterward; leading with `type` and including `ts`
		// gets both the filter and the order for free.
		db.run("CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)");
		db.run("CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts)");

		// Same reasoning again for the third query helper the miner needs
		// ("everything that happened in environment X, in order") — an
		// environment-scoped equivalent of idx_events_type_ts.
		db.run("CREATE INDEX IF NOT EXISTS idx_events_environment_ts ON events (environment_id, ts)");
	},
};
