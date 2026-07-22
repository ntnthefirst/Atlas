import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	applyWatcherBatch,
	getIndexStats,
	pruneStaleRows,
	rebuildFtsIndex,
	sanitizeMatchQuery,
	searchFiles,
	syncFtsForPath,
	upsertFilesBatch,
} from "./store.cjs";

// ---------------------------------------------------------------------------
// The file index store (WP-2.5) -- batched upsert, per-root pruning, the
// wholesale FTS rebuild, and environment-scoped search, all against a REAL
// (scratch, temp-file) AtlasDatabase -- never the real %APPDATA%/Atlas or
// Atlas-Dev userData directory.
// ---------------------------------------------------------------------------

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-file-index-store-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

function fileRow(overrides = {}) {
	return {
		path: "C:\\Users\\me\\Documents\\report.pdf",
		name: "report.pdf",
		ext: "pdf",
		size: 1024,
		mtime: 1_700_000_000_000,
		environmentId: null,
		root: "default:documents",
		...overrides,
	};
}

describe("upsertFilesBatch", () => {
	it("inserts new rows and is queryable back exactly as written", async () => {
		const db = await createDb();
		const written = upsertFilesBatch(db, [fileRow()], 1000);
		expect(written).toBe(1);
		const row = db.first("SELECT * FROM files WHERE path = ?", [fileRow().path]);
		expect(row).toMatchObject({ name: "report.pdf", ext: "pdf", size: 1024, root: "default:documents" });
	});

	it("upserts (refreshes) an existing path rather than duplicating it", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ size: 100 })], 1000);
		upsertFilesBatch(db, [fileRow({ size: 999, mtime: 2_000 })], 2000);

		const rows = db.all("SELECT * FROM files WHERE path = ?", [fileRow().path]);
		expect(rows).toHaveLength(1);
		expect(rows[0].size).toBe(999);
		expect(rows[0].last_seen_at).toBe(2000);
	});

	it("skips a malformed row (no path) instead of throwing", async () => {
		const db = await createDb();
		const written = upsertFilesBatch(db, [{ name: "x" }, fileRow()], 1000);
		expect(written).toBe(1);
		expect(db.all("SELECT * FROM files")).toHaveLength(1);
	});

	it("does nothing for an empty batch", async () => {
		const db = await createDb();
		expect(upsertFilesBatch(db, [], 1000)).toBe(0);
		expect(db.all("SELECT * FROM files")).toHaveLength(0);
	});
});

describe("pruneStaleRows", () => {
	it("deletes only rows for the given root whose last_seen_at predates the crawl start", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ path: "C:\\a\\old.txt", root: "root-a" })], 1000);
		upsertFilesBatch(db, [fileRow({ path: "C:\\a\\fresh.txt", root: "root-a" })], 5000);
		upsertFilesBatch(db, [fileRow({ path: "C:\\b\\other-root.txt", root: "root-b" })], 1000);

		const deleted = pruneStaleRows(db, "root-a", 5000);
		expect(deleted).toBe(1);

		const remaining = db.all("SELECT path FROM files ORDER BY path").map((r) => r.path);
		expect(remaining).toEqual(["C:\\a\\fresh.txt", "C:\\b\\other-root.txt"]);
	});

	it("never touches a root it isn't told to prune -- a cancelled/partial crawl leaves other roots alone", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ path: "C:\\untouched\\file.txt", root: "root-never-finished" })], 1);
		// root-never-finished's crawl never sent "root-done" this run, so
		// pruneStaleRows is simply never called for it -- proven here by not
		// calling it, and asserting the row survives regardless of how old its
		// last_seen_at is relative to a LATER run's start time.
		pruneStaleRows(db, "some-other-root", 999_999_999);
		expect(db.all("SELECT path FROM files")).toHaveLength(1);
	});
});

describe("rebuildFtsIndex + searchFiles", () => {
	it("finds a file by a case-insensitive prefix of its name", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ path: "C:\\docs\\Quarterly-Report.pdf", name: "Quarterly-Report.pdf" })], 1000);
		rebuildFtsIndex(db);

		const results = searchFiles(db, "quarter", null, 10);
		expect(results.map((r) => r.name)).toEqual(["Quarterly-Report.pdf"]);
	});

	it("returns nothing for a query that matches no indexed file", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow()], 1000);
		rebuildFtsIndex(db);
		expect(searchFiles(db, "zzz-nomatch", null, 10)).toEqual([]);
	});

	it("does not see a file added after the crawl's own rebuild until it is rebuilt again", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ path: "C:\\a.txt", name: "a.txt" })], 1000);
		rebuildFtsIndex(db);
		// A file that shows up mid-crawl (before the NEXT rebuild) is in `files`
		// but deliberately not yet in `files_fts` -- see store.cjs's header.
		upsertFilesBatch(db, [fileRow({ path: "C:\\b-new.txt", name: "b-new.txt" })], 2000);
		expect(searchFiles(db, "b-new", null, 10)).toEqual([]);
		rebuildFtsIndex(db);
		expect(searchFiles(db, "b-new", null, 10).map((r) => r.name)).toEqual(["b-new.txt"]);
	});

	it("environment scoping: a file scoped to one environment never surfaces in another environment's search", async () => {
		const db = await createDb();
		upsertFilesBatch(
			db,
			[
				fileRow({ path: "C:\\envA\\secret-report.docx", name: "secret-report.docx", environmentId: "env-a" }),
				fileRow({ path: "C:\\envB\\other.docx", name: "other-doc.docx", environmentId: "env-b" }),
				fileRow({ path: "C:\\global\\shared.docx", name: "shared-doc.docx", environmentId: null }),
			],
			1000,
		);
		rebuildFtsIndex(db);

		// env-b's search for env-a's file must come back empty -- this is the
		// literal "an enclosed/other environment never sees another
		// environment's files" proof this WP asks for.
		expect(searchFiles(db, "secret", "env-b", 10)).toEqual([]);
		// env-b can still find its own file...
		expect(searchFiles(db, "other-doc", "env-b", 10).map((r) => r.path)).toEqual(["C:\\envB\\other.docx"]);
		// ...and the global (unassigned) file, which belongs to no one environment.
		expect(searchFiles(db, "shared-doc", "env-b", 10).map((r) => r.path)).toEqual(["C:\\global\\shared.docx"]);
		// env-a, symmetrically, never sees env-b's file.
		expect(searchFiles(db, "other-doc", "env-a", 10)).toEqual([]);
	});

	it("with no environmentId at all (e.g. no environment chosen yet), only global rows are visible", async () => {
		const db = await createDb();
		upsertFilesBatch(
			db,
			[
				fileRow({ path: "C:\\envA\\scoped.txt", name: "scoped-file.txt", environmentId: "env-a" }),
				fileRow({ path: "C:\\global\\open.txt", name: "open-file.txt", environmentId: null }),
			],
			1000,
		);
		rebuildFtsIndex(db);

		expect(searchFiles(db, "scoped", null, 10)).toEqual([]);
		expect(searchFiles(db, "open-file", null, 10).map((r) => r.path)).toEqual(["C:\\global\\open.txt"]);
	});

	it("sanitizes special FTS5 syntax characters instead of throwing a MATCH syntax error", async () => {
		const db = await createDb();
		upsertFilesBatch(db, [fileRow({ path: "C:\\a\\file.txt", name: "file.txt" })], 1000);
		rebuildFtsIndex(db);
		// A bare double-quote or colon would otherwise be interpreted as FTS5
		// query syntax (an unterminated string / a column filter) and throw.
		expect(() => searchFiles(db, 'file" OR 1=1 --:bad', null, 10)).not.toThrow();
	});

	it("sanitizeMatchQuery returns null for a query with no usable token", () => {
		expect(sanitizeMatchQuery("   ")).toBeNull();
		expect(sanitizeMatchQuery("???")).toBeNull();
		expect(sanitizeMatchQuery(null)).toBeNull();
	});
});

describe("syncFtsForPath", () => {
	it("inserts a files_fts row for a path that did not have one", async () => {
		const db = await createDb();
		syncFtsForPath(db, "C:\\a\\new-file.txt", "new-file.txt");
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\new-file.txt"])).toHaveLength(1);
	});

	it("removes the files_fts row for a path when called with no name (a deletion)", async () => {
		const db = await createDb();
		syncFtsForPath(db, "C:\\a\\gone.txt", "gone.txt");
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\gone.txt"])).toHaveLength(1);
		syncFtsForPath(db, "C:\\a\\gone.txt", null);
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\gone.txt"])).toHaveLength(0);
	});

	it("never leaves a duplicate row when called twice for the same path", async () => {
		const db = await createDb();
		syncFtsForPath(db, "C:\\a\\dup.txt", "dup.txt");
		syncFtsForPath(db, "C:\\a\\dup.txt", "dup.txt");
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\dup.txt"])).toHaveLength(1);
	});
});

describe("applyWatcherBatch", () => {
	it("upserts a genuinely new path into both files AND files_fts", async () => {
		const db = await createDb();
		const result = applyWatcherBatch(db, { upserts: [fileRow({ path: "C:\\a\\brand-new.txt", name: "brand-new.txt" })] }, 1000);
		expect(result).toMatchObject({ upserted: 1, removed: 0 });
		expect(db.all("SELECT path FROM files WHERE path = ?", ["C:\\a\\brand-new.txt"])).toHaveLength(1);
		expect(searchFiles(db, "brand-new", null, 10).map((r) => r.path)).toEqual(["C:\\a\\brand-new.txt"]);
	});

	// This is the exact behaviour the watcher exists to get right: a
	// metadata-only refresh (the overwhelmingly common case -- an editor
	// saving a file it already indexed) must touch `files` but leave
	// files_fts's row for that path completely alone, not delete-then-
	// reinsert it. Proven by spying on every SQL statement `db.run` executes
	// during the refresh and asserting NONE of them touch `files_fts` at
	// all -- deliberately not a `rowid`-equality check, since SQLite's own
	// rowid-reuse-after-delete behaviour on a small table can coincidentally
	// hand back the same rowid even when a real delete+insert did happen,
	// which would make that assertion pass vacuously regardless of whether
	// the optimization actually fired.
	it("does NOT touch files_fts for a metadata-only refresh of an already-indexed path", async () => {
		const db = await createDb();
		const target = fileRow({ path: "C:\\a\\existing.txt", name: "existing.txt", size: 10 });
		applyWatcherBatch(db, { upserts: [target] }, 1000);
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\existing.txt"])).toHaveLength(1);

		const runSpy = vi.spyOn(db, "run");
		// A second "upsert" for the SAME path, just a bigger size (as if the
		// file's content changed but its name/path did not).
		applyWatcherBatch(db, { upserts: [{ ...target, size: 999 }] }, 2000);

		const ftsWrites = runSpy.mock.calls.filter(([sql]) => sql.includes("files_fts"));
		expect(ftsWrites).toHaveLength(0); // not one DELETE or INSERT against files_fts
		runSpy.mockRestore();

		const row = db.first("SELECT size FROM files WHERE path = ?", ["C:\\a\\existing.txt"]);
		expect(row.size).toBe(999); // files WAS refreshed
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\existing.txt"])).toHaveLength(1); // still exactly one row
	});

	it("removes a deleted path from both files and files_fts", async () => {
		const db = await createDb();
		applyWatcherBatch(db, { upserts: [fileRow({ path: "C:\\a\\doomed.txt", name: "doomed.txt" })] }, 1000);
		expect(db.all("SELECT path FROM files WHERE path = ?", ["C:\\a\\doomed.txt"])).toHaveLength(1);

		const result = applyWatcherBatch(db, { removals: ["C:\\a\\doomed.txt"] }, 2000);
		expect(result).toMatchObject({ upserted: 0, removed: 1 });
		expect(db.all("SELECT path FROM files WHERE path = ?", ["C:\\a\\doomed.txt"])).toHaveLength(0);
		expect(db.all("SELECT path FROM files_fts WHERE path = ?", ["C:\\a\\doomed.txt"])).toHaveLength(0);
	});

	it("removing a directory path also removes every file nested under it, even though the directory itself was never a row", async () => {
		const db = await createDb();
		applyWatcherBatch(
			db,
			{
				upserts: [
					fileRow({ path: "C:\\proj\\sub\\one.txt", name: "one.txt" }),
					fileRow({ path: "C:\\proj\\sub\\deep\\two.txt", name: "two.txt" }),
					fileRow({ path: "C:\\proj\\outside.txt", name: "outside.txt" }),
				],
			},
			1000,
		);

		// "C:\\proj\\sub" itself is never a `files` row -- only files are
		// indexed -- but removing it (e.g. the whole folder was dragged to the
		// Recycle Bin in one filesystem operation) must still purge everything
		// that lived underneath it.
		const result = applyWatcherBatch(db, { removals: ["C:\\proj\\sub"] }, 2000);
		expect(result.removed).toBe(2);
		expect(db.all("SELECT path FROM files ORDER BY path").map((r) => r.path)).toEqual(["C:\\proj\\outside.txt"]);
		expect(db.all("SELECT path FROM files_fts").map((r) => r.path)).toEqual(["C:\\proj\\outside.txt"]);
	});

	it("a removal for a similarly-prefixed sibling path does not remove the sibling itself", async () => {
		const db = await createDb();
		applyWatcherBatch(
			db,
			{
				upserts: [
					fileRow({ path: "C:\\proj\\sub\\file.txt", name: "file.txt" }),
					fileRow({ path: "C:\\proj\\sub-other\\file.txt", name: "file.txt" }),
				],
			},
			1000,
		);

		applyWatcherBatch(db, { removals: ["C:\\proj\\sub"] }, 2000);
		expect(db.all("SELECT path FROM files ORDER BY path").map((r) => r.path)).toEqual([
			"C:\\proj\\sub-other\\file.txt",
		]);
	});

	it("respects maxFiles: refuses to insert a genuinely NEW path once the cap is reached, but still allows refreshes and removals", async () => {
		const db = await createDb();
		applyWatcherBatch(
			db,
			{
				upserts: [
					fileRow({ path: "C:\\a\\1.txt", name: "1.txt" }),
					fileRow({ path: "C:\\a\\2.txt", name: "2.txt" }),
				],
				maxFiles: 2,
			},
			1000,
		);
		expect(db.all("SELECT path FROM files")).toHaveLength(2);

		// maxFiles=2 has already been reached -- a third, brand-new path must
		// be refused...
		const result = applyWatcherBatch(
			db,
			{
				upserts: [
					fileRow({ path: "C:\\a\\3.txt", name: "3.txt" }),
					fileRow({ path: "C:\\a\\1.txt", name: "1.txt", size: 55 }), // ...but refreshing an EXISTING path still works
				],
				maxFiles: 2,
			},
			2000,
		);
		expect(result.skippedAtCap).toBe(1);
		expect(result.upserted).toBe(1);
		expect(db.all("SELECT path FROM files")).toHaveLength(2);
		expect(db.all("SELECT path FROM files WHERE path = ?", ["C:\\a\\3.txt"])).toHaveLength(0);
		expect(db.first("SELECT size FROM files WHERE path = ?", ["C:\\a\\1.txt"]).size).toBe(55);

		// Removals are never blocked by the cap.
		const removalResult = applyWatcherBatch(db, { removals: ["C:\\a\\2.txt"], maxFiles: 2 }, 3000);
		expect(removalResult.removed).toBe(1);
		expect(db.all("SELECT path FROM files")).toHaveLength(1);
	});

	it("does nothing for an empty batch", () => {
		expect(applyWatcherBatch(null, {}, 1000)).toEqual({ upserted: 0, removed: 0, skippedAtCap: 0 });
	});
});

describe("getIndexStats", () => {
	it("reports total files and a per-root breakdown", async () => {
		const db = await createDb();
		upsertFilesBatch(
			db,
			[fileRow({ path: "C:\\a\\1.txt", root: "root-a" }), fileRow({ path: "C:\\b\\2.txt", root: "root-b" })],
			1000,
		);
		const stats = getIndexStats(db);
		expect(stats.totalFiles).toBe(2);
		expect(stats.perRoot.sort((a, b) => a.root.localeCompare(b.root))).toEqual([
			{ root: "root-a", count: 1, lastSeenAt: 1000 },
			{ root: "root-b", count: 1, lastSeenAt: 1000 },
		]);
	});
});
