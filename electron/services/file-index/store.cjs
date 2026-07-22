"use strict";

const path = require("node:path");

// ---------------------------------------------------------------------------
// The file index store (WP-2.5) -- every write and read against the `files`
// / `files_fts` tables (electron/migrations/009_file_index.cjs) lives here.
// This is the MAIN-THREAD half of the crawler: electron/services/file-index/
// crawl-worker.cjs walks the filesystem in a worker thread and streams
// batches of plain records back; electron/services/file-index/crawler.cjs
// receives those messages and calls straight into this module, which is the
// only code in this package that ever touches `db`. The worker itself NEVER
// requires this file and NEVER opens a database connection -- required by
// the single-connection constraint (node-sqlite3-wasm has exactly one
// connection, owned by the main process).
//
// -- Batched, transactional writes -----------------------------------------
// `upsertFilesBatch` wraps its rows in ONE `db.transaction()` call --
// unbatched single-row-autocommit writes are ~800x slower on this engine (no
// WAL; every implicit commit is a full fsync-equivalent), so a 100k-file
// crawl streamed as individual writes would be prohibitively slow. The
// crawler streams batches of ~1000 rows (see crawler.cjs's BATCH_SIZE); this
// function doesn't care about that number, it just transacts whatever it's
// handed in one go.
//
// -- Upsert, not insert-then-update -----------------------------------------
// `path` is the table's PRIMARY KEY (a file's own filesystem path is
// naturally unique), so `ON CONFLICT(path) DO UPDATE` is what makes a
// re-crawl of an unchanged tree cheap and correct: an already-indexed file
// just gets its `last_seen_at` (and any changed size/mtime/environment_id/
// root) refreshed in place, never a duplicate row.
//
// -- Per-root pruning, never global ------------------------------------------
// `pruneStaleRows(db, root, crawlStartedAtMs)` deletes exactly the rows for
// ONE root whose `last_seen_at` predates this crawl run's start -- i.e. files
// that used to be under this root but weren't seen this time (deleted, moved,
// or the root shrank). electron/services/file-index/crawler.cjs calls this
// the moment a root finishes (its own "root-done" message from the worker),
// never for a root the crawl never got to (cancelled mid-walk) or hasn't
// finished yet -- see migration 009's header for why that per-root
// scoping is what makes a cancelled/partial run safe to run at all.
//
// -- FTS5: rebuilt wholesale, once per crawl -------------------------------
// `rebuildFtsIndex` does exactly what migration 009's header describes: wipe
// `files_fts` and re-populate it from `files` in one `INSERT ... SELECT`,
// rather than maintaining it incrementally on every single upsert. Measured
// against a 100k-row `files` table on this machine, the full rebuild takes
// low tens of milliseconds -- negligible next to the crawl itself (which
// spends its time in filesystem syscalls, not SQL) and far simpler than
// tracking which of a batch's paths are genuinely NEW (rather than a refreshed
// existing row) to decide whether an incremental `files_fts` insert is even
// needed for it. Called once, by crawler.cjs, when the ENTIRE crawl run (every
// enabled root) finishes -- not per-root and not per-batch -- so a query
// mid-crawl still sees the last fully-consistent snapshot rather than a
// partially-rebuilt index.
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
	INSERT INTO files (path, name, ext, size, mtime, environment_id, root, last_seen_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(path) DO UPDATE SET
		name = excluded.name,
		ext = excluded.ext,
		size = excluded.size,
		mtime = excluded.mtime,
		environment_id = excluded.environment_id,
		root = excluded.root,
		last_seen_at = excluded.last_seen_at
`;

// One transaction per call -- the crawler is expected to call this once per
// batch (~1000 rows), never once per row. Malformed rows (no usable `path`)
// are skipped rather than aborting the whole batch.
function upsertFilesBatch(db, rows, seenAtMs) {
	if (!db || !Array.isArray(rows) || rows.length === 0) {
		return 0;
	}
	let written = 0;
	db.transaction(() => {
		for (const row of rows) {
			if (!row || typeof row.path !== "string" || !row.path) {
				continue;
			}
			db.run(UPSERT_SQL, [
				row.path,
				typeof row.name === "string" ? row.name : "",
				row.ext ?? null,
				Number.isFinite(row.size) ? row.size : 0,
				Number.isFinite(row.mtime) ? row.mtime : 0,
				row.environmentId ?? null,
				row.root,
				seenAtMs,
			]);
			written += 1;
		}
	});
	return written;
}

// Returns the number of rows deleted -- crawler.cjs logs/reports this so a
// crawl's summary can say "removed N files no longer on disk", not just
// "added/refreshed N".
function pruneStaleRows(db, root, crawlStartedAtMs) {
	if (!db || !root) {
		return 0;
	}
	const before = db.first("SELECT COUNT(*) as count FROM files WHERE root = ? AND last_seen_at < ?", [
		root,
		crawlStartedAtMs,
	]);
	db.run("DELETE FROM files WHERE root = ? AND last_seen_at < ?", [root, crawlStartedAtMs]);
	return before?.count ?? 0;
}

function rebuildFtsIndex(db) {
	if (!db) {
		return;
	}
	db.transaction(() => {
		db.run("DELETE FROM files_fts");
		db.run("INSERT INTO files_fts (name, path) SELECT name, path FROM files");
	});
}

// -- Incremental FTS maintenance (WP-2.6, the watcher) -----------------------
//
// rebuildFtsIndex above is exactly right for the CRAWLER (wipe + repopulate
// wholesale, once per full run) and completely wrong for a watcher reacting
// to individual filesystem events: rebuilding a potentially 100k-row
// `files_fts` on every single change would be absurd. `syncFtsForPath` is the
// single-path primitive that keeps it correct without ever touching a row
// that isn't this exact path -- precisely the two operations migration 009's
// header says `files_fts` ever needs outside a full crawl: delete whatever
// row currently matches `filePath` (idempotent even if there wasn't one),
// then re-insert one iff the file still exists (`name` is a non-empty
// string; omit/pass null for a removal). A pure metadata refresh (size/mtime
// changed, but the path itself was already indexed) must call neither half
// of this at all -- a file's `name` can never change for an existing `path`
// (name is derived from path, and path is `files`' own PRIMARY KEY, see
// migration 009's header), so an existing path's `files_fts` row is already
// exactly right. `applyWatcherBatch` below is the only caller, and it is
// what decides whether a given upsert is genuinely a new path or just a
// refresh -- this function itself has no way to know.
function syncFtsForPath(db, filePath, name) {
	db.run("DELETE FROM files_fts WHERE path = ?", [filePath]);
	if (typeof name === "string" && name) {
		db.run("INSERT INTO files_fts (name, path) VALUES (?, ?)", [name, filePath]);
	}
}

// One transactional write per debounced batch of filesystem-watcher events
// (electron/services/file-index/watcher.cjs) -- mirrors upsertFilesBatch's
// batching discipline (everything in ONE `db.transaction()`) while also
// keeping `files_fts` in step incrementally via syncFtsForPath, and
// respecting the SAME `maxFiles` budget the crawler enforces (see
// file-index-prefs.cjs) so a watcher left running indefinitely can never
// grow the index past the size the user configured.
//
// `upserts` are rows shaped exactly like upsertFilesBatch's (a path the
// watcher confirmed still exists on disk, freshly stat()'d); `removals` are
// plain path strings the watcher confirmed are now gone (it could not
// stat() them -- ENOENT). A removal deletes both the exact path AND anything
// nested under it (`substr(path, 1, N) = prefix`, a plain literal-prefix
// comparison, never a LIKE pattern, so a path containing `%`/`_` can never
// be misread as a wildcard) -- covers the common case of a whole directory
// disappearing in one filesystem operation (e.g. dragged to the Recycle
// Bin), which was never itself a `files` row, but whose contents were.
function applyWatcherBatch(db, { upserts = [], removals = [], maxFiles = Infinity } = {}, seenAtMs) {
	if (!db) {
		return { upserted: 0, removed: 0, skippedAtCap: 0 };
	}
	let upserted = 0;
	let removed = 0;
	let skippedAtCap = 0;

	db.transaction(() => {
		for (const target of removals) {
			if (typeof target !== "string" || !target) {
				continue;
			}
			const prefix = `${target}${path.sep}`;
			const before = db.first("SELECT COUNT(*) as count FROM files WHERE path = ? OR substr(path, 1, ?) = ?", [
				target,
				prefix.length,
				prefix,
			]);
			removed += before?.count ?? 0;
			db.run("DELETE FROM files_fts WHERE path = ? OR substr(path, 1, ?) = ?", [target, prefix.length, prefix]);
			db.run("DELETE FROM files WHERE path = ? OR substr(path, 1, ?) = ?", [target, prefix.length, prefix]);
		}

		let totalFiles = db.first("SELECT COUNT(*) as count FROM files")?.count ?? 0;

		for (const row of upserts) {
			if (!row || typeof row.path !== "string" || !row.path) {
				continue;
			}
			const existing = db.first("SELECT 1 as found FROM files WHERE path = ?", [row.path]);
			if (!existing && totalFiles >= maxFiles) {
				// Never grow the index past the crawler's own budget -- an
				// existing path can still be refreshed (it doesn't grow the
				// table), and removals above always apply regardless of the cap.
				skippedAtCap += 1;
				continue;
			}
			db.run(UPSERT_SQL, [
				row.path,
				typeof row.name === "string" ? row.name : "",
				row.ext ?? null,
				Number.isFinite(row.size) ? row.size : 0,
				Number.isFinite(row.mtime) ? row.mtime : 0,
				row.environmentId ?? null,
				row.root,
				seenAtMs,
			]);
			upserted += 1;
			if (!existing) {
				totalFiles += 1;
				syncFtsForPath(db, row.path, row.name);
			}
			// else: same path, refreshed metadata only -- see this function's
			// header on why that needs no files_fts write at all.
		}
	});

	return { upserted, removed, skippedAtCap };
}

// -- Search -----------------------------------------------------------------
//
// Turns free text into an FTS5 MATCH expression: every whitespace-delimited
// token becomes its own double-quoted PREFIX phrase (`"tok"*`), ANDed
// together (FTS5's default when multiple phrases appear with no explicit
// OR/NOT) -- confirmed against this exact node-sqlite3-wasm build that plain
// prefix MATCH and `ORDER BY rank` (bm25) both work; see migration 009's
// header for the probe. Quoting every token (with internal `"` doubled, FTS5's own
// escape rule) is what keeps a token containing a character FTS5's query
// syntax would otherwise interpret (`:`, `-` as a column filter or NOT,
// stray unmatched quotes, ...) from ever raising a syntax error -- a search
// box is free text, not a query language, so nothing the user types should be
// able to break the MATCH clause itself. Returns null for a query with no
// usable token (blank, or pure punctuation) so callers can treat that as "no
// search" rather than sending FTS5 an empty MATCH string.
function sanitizeMatchQuery(query) {
	const tokens = typeof query === "string" ? query.match(/[\w.-]+/gu) : null;
	if (!tokens || tokens.length === 0) {
		return null;
	}
	// A defensive cap -- a search box is not the place for a 200-word query,
	// and FTS5's own query parser has no obligation to be fast against one.
	return tokens
		.slice(0, 8)
		.map((token) => `"${token.replace(/"/g, '""')}"*`)
		.join(" ");
}

// Environment scoping (WP-0.8): a row whose `environment_id` names a
// DIFFERENT environment than `environmentId` is never returned, regardless of
// isolation mode -- isolation.cjs's own policy comment is explicit that a
// file path is exactly the kind of raw content that must never cross an
// environment boundary, even in Connected mode's aggregate-only sharing. A
// row with `environment_id IS NULL` ("no environment claims this root", see
// migration 009's header) is visible to every environment alike -- it isn't
// "another environment's file" at all, the same way installed apps (a
// system-wide resource, apps-provider.cjs) aren't scoped to any one
// environment either. With no `environmentId` at all (e.g. the welcome
// screen, before any environment has ever been chosen), only those global,
// unassigned-root rows are visible -- there is no environment to match
// against, so nothing environment-specific can be shown.
function searchFiles(db, query, environmentId, limit = 20) {
	if (!db) {
		return [];
	}
	const matchQuery = sanitizeMatchQuery(query);
	if (!matchQuery) {
		return [];
	}
	const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 20;

	const envClause = environmentId ? "(f.environment_id = ? OR f.environment_id IS NULL)" : "f.environment_id IS NULL";
	const params = environmentId
		? [matchQuery, environmentId, boundedLimit]
		: [matchQuery, boundedLimit];

	try {
		return db.all(
			`SELECT f.path, f.name, f.ext, f.size, f.mtime, f.environment_id
			 FROM files_fts
			 JOIN files f ON f.path = files_fts.path
			 WHERE files_fts MATCH ? AND ${envClause}
			 ORDER BY rank
			 LIMIT ?`,
			params,
		);
	} catch (error) {
		// A malformed MATCH expression must never break the launcher's search --
		// degrade to "no file results this query" instead.
		console.error("[Atlas] file-index search failed:", error);
		return [];
	}
}

// Backs the Settings surface's "N files indexed" summary -- one query, no
// N+1 loop over roots.
function getIndexStats(db) {
	if (!db) {
		return { totalFiles: 0, perRoot: [] };
	}
	const totalRow = db.first("SELECT COUNT(*) as count FROM files");
	const perRoot = db.all(
		"SELECT root, COUNT(*) as count, MAX(last_seen_at) as lastSeenAt FROM files GROUP BY root",
	);
	return {
		totalFiles: totalRow?.count ?? 0,
		perRoot,
	};
}

module.exports = {
	upsertFilesBatch,
	pruneStaleRows,
	rebuildFtsIndex,
	syncFtsForPath,
	applyWatcherBatch,
	searchFiles,
	sanitizeMatchQuery,
	getIndexStats,
};
