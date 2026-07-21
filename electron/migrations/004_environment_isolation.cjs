// Migration 004 — the isolation model (WP-0.8): adds `isolation_mode` to
// `environments`, the column the whole scoped data layer
// (electron/data/isolation.cjs, electron/data/scoped.cjs) reads to decide
// whether a read may ever cross an environment boundary.
//
// Only two values are ever valid — `connected` (the default) and `enclosed`
// — enforced with a CHECK constraint at the schema level, not just in
// application code: this is the one column in the whole database where an
// invalid value would mean the isolation promise silently stops meaning
// anything (see the "gotchas" note on WP-0.8 in IMPLEMENTATION-PLAN.md —
// two modes, enforced strictly, no ambiguity). Verified empirically against
// node-sqlite3-wasm (see D9): `ALTER TABLE ... ADD COLUMN ... CHECK (...)` is
// supported here because the CHECK expression only references the new
// column itself and calls no non-deterministic function, which is exactly
// what SQLite allows on an ADD COLUMN.
//
// `NOT NULL DEFAULT 'connected'` on the ADD COLUMN means every existing row
// — every environment created before this migration ever ran — lands in
// `connected` mode the instant this migration applies, with no separate
// backfill step and no window where a row could have a NULL/invalid mode.
// That is D3 in practice: real users' existing environments must migrate
// with identical behaviour, and `connected` is defined (see isolation.cjs)
// to permit exactly what the app already does today.
"use strict";

module.exports = {
	version: 4,
	name: "004_environment_isolation",

	up(db) {
		if (!db.columnExists("environments", "isolation_mode")) {
			db.run(
				`ALTER TABLE environments
					ADD COLUMN isolation_mode TEXT NOT NULL DEFAULT 'connected'
					CHECK (isolation_mode IN ('connected', 'enclosed'))`,
			);
		}
	},
};
