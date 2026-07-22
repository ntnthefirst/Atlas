// Migration 009 (WP-2.5) -- the file index: a queryable table of the user's
// files (path/name/extension/size/mtime, plus an optional environment
// association) fed by the background crawler in electron/services/
// file-index/*.cjs, and a name-matching index for the launcher's "files"
// provider (electron/services/launcher-providers/files-provider.cjs).
//
// -- Filename/metadata only ---------------------------------------------
// Exactly what IMPLEMENTATION-PLAN.md's WP-2.5 spec calls for: path, name,
// extension, size, mtime. No file CONTENT is ever read or stored here --
// that is a separate, much larger problem this WP explicitly does not
// attempt.
//
// -- `root` and `last_seen_at` -------------------------------------------
// Two columns beyond the spec's bare minimum, both needed for the crawler
// to be safely re-runnable without leaking stale rows forever:
//   - `root` is the configured root directory (electron/config/
//     file-index-prefs.cjs) a row was found under. Re-crawling scopes its
//     "this file is gone from disk" cleanup to one root at a time -- a
//     crawl that only covers SOME configured roots (a partial run, or one
//     cancelled partway through) must never delete rows that belong to a
//     root it never touched this time.
//   - `last_seen_at` is the epoch-ms timestamp of whichever crawl run most
//     recently confirmed a row still exists on disk. electron/services/
//     file-index/store.cjs's pruneStaleRows() deletes exactly the rows
//     whose `last_seen_at` is older than the start of a crawl that fully
//     walked their `root` -- see that file's header for why a cancelled or
//     partial run only prunes the roots it actually finished.
//
// -- `environment_id` is nullable = global --------------------------------
// A file's environment association is a property of which configured ROOT
// it was found under (each root in file-index-prefs.cjs carries its own
// optional `environmentId`), not a heuristic re-derived from the file
// itself -- see file-index-prefs.cjs's header for why. NULL means "no
// environment claims this root", i.e. a global file every environment can
// find. There is no FOREIGN KEY constraint on this column on purpose: a
// root's `environmentId` is read at crawl time and copied onto every file
// under it, and an environment can be deleted later without this migration
// (or the crawler) needing to cascade -- a file whose owning environment
// was since deleted simply becomes an orphaned-but-harmless association;
// electron/data/scoped.cjs's files.search() only ever matches it against a
// currently-live environment id or NULL, so an orphaned id can never
// surface as another environment's file and is silently cleaned up the next
// time that root is re-crawled (its association is recomputed from the
// root config, which no longer names a deleted environment).
//
// -- Matching: FTS5, confirmed available ----------------------------------
// A tiny throwaway probe (`CREATE VIRTUAL TABLE t USING fts5(name)`) against
// this exact node-sqlite3-wasm build confirmed FTS5 is compiled in and
// works, so this migration commits to it rather than a fallback LIKE-based
// scan -- see this WP's final report for the probe output. `files_fts` is
// deliberately NOT an FTS5 "external content" table synced via triggers
// (the usual pattern for keeping an FTS index in step with a regular
// table): `name` never changes for a given `path` (a file's name is derived
// from its path, and a path is this table's own primary key), so the ONLY
// operations that ever need to touch the FTS index are a brand new path
// appearing or an old one being pruned -- both already rare relative to
// "same path, refreshed size/mtime" on any re-crawl of a mostly-unchanged
// tree. electron/services/file-index/store.cjs takes advantage of that by
// rebuilding `files_fts` wholesale (`DELETE` + one bulk `INSERT ... SELECT`)
// once per crawl run rather than maintaining it incrementally row by row --
// see that file's header for the measured cost. `path` rides along as an
// UNINDEXED column purely so a match can be joined straight back to `files`
// without a second lookup table.
"use strict";

module.exports = {
	version: 9,
	name: "009_file_index",

	up(db) {
		db.run(`CREATE TABLE IF NOT EXISTS files (
			path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			ext TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			mtime INTEGER NOT NULL DEFAULT 0,
			environment_id TEXT,
			root TEXT NOT NULL,
			last_seen_at INTEGER NOT NULL DEFAULT 0
		)`);

		// Every query shape store.cjs actually issues gets an index:
		// environment scoping (WHERE environment_id = ? OR IS NULL -- the
		// plain equality half of that benefits from this), the per-root
		// prune sweep (WHERE root = ? AND last_seen_at < ?), and a
		// case-insensitive name index kept as a fallback ordering/lookup aid
		// alongside FTS5 (also usable directly if a future caller needs a
		// plain prefix scan without going through MATCH).
		db.run("CREATE INDEX IF NOT EXISTS idx_files_environment_id ON files (environment_id)");
		db.run("CREATE INDEX IF NOT EXISTS idx_files_root_last_seen ON files (root, last_seen_at)");
		db.run("CREATE INDEX IF NOT EXISTS idx_files_name ON files (name COLLATE NOCASE)");

		db.run("CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, path UNINDEXED)");
	},
};
