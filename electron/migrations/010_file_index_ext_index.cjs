// Migration 010 (WP-2.7) — an index on `files.ext`, the column
// electron/services/file-index/store.cjs's searchFiles() filters on for the
// `ext:<value>` launcher search filter (`WHERE ... AND f.ext = ?`).
//
// Migration 009 already indexed `environment_id`, `(root, last_seen_at)`, and
// `name` -- everything store.cjs's queries filtered on at the time. WP-2.7
// adds a genuinely new filtered predicate (`f.ext = ?`), so it gets the same
// treatment: a plain single-column index, exactly like 009's own
// `idx_files_environment_id`. Without this, `ext:pdf` (or any ext: filter)
// would force a full table scan of `files` on every keystroke once the index
// holds anywhere near the 100k-file scale this package is sized for.
"use strict";

module.exports = {
	version: 10,
	name: "010_file_index_ext_index",

	up(db) {
		db.run("CREATE INDEX IF NOT EXISTS idx_files_ext ON files (ext)");
	},
};
