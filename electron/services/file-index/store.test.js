import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	applyWatcherBatch,
	getIndexStats,
	parseFileSearchFilters,
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

// ---------------------------------------------------------------------------
// Filters (WP-2.7): ext:<value> / in:<value>, parsed out of the query
// string, applied as SQL constraints, and composable with each other and
// with free text.
// ---------------------------------------------------------------------------

describe("parseFileSearchFilters", () => {
	it("parses a bare ext: filter and leaves no residual text", () => {
		expect(parseFileSearchFilters("ext:pdf")).toEqual({ ext: "pdf", in: null, residualText: "" });
	});

	it("parses a bare in: filter and leaves no residual text", () => {
		expect(parseFileSearchFilters("in:work")).toEqual({ ext: null, in: "work", residualText: "" });
	});

	it("composes ext: and in: together with free text, regardless of order", () => {
		expect(parseFileSearchFilters("ext:pdf in:work report")).toEqual({
			ext: "pdf",
			in: "work",
			residualText: "report",
		});
		expect(parseFileSearchFilters("report ext:pdf in:work")).toEqual({
			ext: "pdf",
			in: "work",
			residualText: "report",
		});
	});

	it("normalizes ext: to lowercase and strips a leading dot", () => {
		expect(parseFileSearchFilters("ext:.PDF")).toEqual({ ext: "pdf", in: null, residualText: "" });
	});

	it("normalizes in: to lowercase", () => {
		expect(parseFileSearchFilters("IN:Work")).toEqual({ ext: null, in: "work", residualText: "" });
	});

	it("a filter token with no value is dropped and never breaks parsing", () => {
		expect(parseFileSearchFilters("ext: report")).toEqual({ ext: null, in: null, residualText: "report" });
		expect(parseFileSearchFilters("in:")).toEqual({ ext: null, in: null, residualText: "" });
	});

	it("keeps the LAST occurrence when a filter key is repeated", () => {
		expect(parseFileSearchFilters("ext:pdf ext:docx")).toEqual({ ext: "docx", in: null, residualText: "" });
	});

	it("does not treat a mid-word colon as a filter (only a whole whitespace-delimited token counts)", () => {
		expect(parseFileSearchFilters("reportext:pdf")).toEqual({ ext: null, in: null, residualText: "reportext:pdf" });
	});

	it("returns an all-empty shape for a blank query", () => {
		expect(parseFileSearchFilters("")).toEqual({ ext: null, in: null, residualText: "" });
		expect(parseFileSearchFilters(null)).toEqual({ ext: null, in: null, residualText: "" });
	});
});

describe("searchFiles filters", () => {
	async function createFilterFixtureDb() {
		const db = await createDb();
		upsertFilesBatch(
			db,
			[
				fileRow({
					path: "C:\\Users\\me\\work\\reports\\report.pdf",
					name: "report.pdf",
					ext: "pdf",
					root: "root-work",
				}),
				fileRow({
					path: "C:\\Users\\me\\work\\reports\\report.docx",
					name: "report.docx",
					ext: "docx",
					root: "root-work",
				}),
				fileRow({
					path: "C:\\Users\\me\\personal\\report.pdf",
					name: "report.pdf",
					ext: "pdf",
					root: "root-personal",
				}),
			],
			1000,
		);
		rebuildFtsIndex(db);
		return db;
	}

	it("ext: restricts results to files with that extension (a real SQL WHERE constraint, not a JS filter)", async () => {
		const db = await createFilterFixtureDb();
		const results = searchFiles(db, "ext:pdf report", null, 10);
		expect(results.length).toBeGreaterThan(0); // non-vacuous: something actually matched
		expect(results.every((r) => r.ext === "pdf")).toBe(true);
		expect(results.some((r) => r.ext === "docx")).toBe(false);
	});

	it("in: restricts results to files under a matching path segment", async () => {
		const db = await createFilterFixtureDb();
		const results = searchFiles(db, "in:work report", null, 10);
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.path.includes("\\work\\"))).toBe(true);
		expect(results.some((r) => r.path.includes("\\personal\\"))).toBe(false);
	});

	it("in: also matches a file's configured root id, not only its literal path", async () => {
		const db = await createFilterFixtureDb();
		const results = searchFiles(db, "in:root-personal report", null, 10);
		expect(results.length).toBe(1);
		expect(results[0].path).toBe("C:\\Users\\me\\personal\\report.pdf");
	});

	it("ext: and in: COMPOSE: both constraints apply together, narrowing further than either alone", async () => {
		const db = await createFilterFixtureDb();
		// Both "in:work" alone (2 hits: report.pdf AND report.docx) and
		// "ext:pdf" alone (2 hits: work's report.pdf AND personal's report.pdf)
		// return more than one row -- proving this isn't a vacuous fixture --
		// but composed together only ONE file satisfies both.
		const inOnly = searchFiles(db, "in:work report", null, 10);
		const extOnly = searchFiles(db, "ext:pdf report", null, 10);
		expect(inOnly.length).toBe(2);
		expect(extOnly.length).toBe(2);

		const composed = searchFiles(db, "ext:pdf in:work report", null, 10);
		expect(composed).toHaveLength(1);
		expect(composed[0].path).toBe("C:\\Users\\me\\work\\reports\\report.pdf");
	});

	it("a filter with no value (ext:) does not break the query -- falls back to plain free-text search", async () => {
		const db = await createFilterFixtureDb();
		expect(() => searchFiles(db, "ext: report", null, 10)).not.toThrow();
		const results = searchFiles(db, "ext: report", null, 10);
		expect(results.length).toBe(3); // every "report*" file, ext: was dropped entirely
	});

	it("a filters-only query (no free text at all) still returns matching rows", async () => {
		const db = await createFilterFixtureDb();
		const results = searchFiles(db, "ext:docx", null, 10);
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("report.docx");
	});

	it("escapes LIKE wildcard characters in an in: value so they cannot be used to widen matches unexpectedly", async () => {
		const db = await createFilterFixtureDb();
		// "%" and "_" are SQL LIKE wildcards -- a filter value containing them
		// must be treated as a LITERAL folder name, not a wildcard pattern.
		const results = searchFiles(db, "in:100% report", null, 10);
		expect(results).toEqual([]);
	});

	it("still enforces environment scoping when a filter is present -- filters never widen visibility", async () => {
		const db = await createDb();
		upsertFilesBatch(
			db,
			[
				fileRow({
					path: "C:\\envA\\work\\secret.pdf",
					name: "secret.pdf",
					ext: "pdf",
					environmentId: "env-a",
					root: "root-a",
				}),
			],
			1000,
		);
		rebuildFtsIndex(db);
		expect(searchFiles(db, "ext:pdf in:work secret", "env-b", 10)).toEqual([]);
		expect(searchFiles(db, "ext:pdf in:work secret", "env-a", 10).map((r) => r.path)).toEqual([
			"C:\\envA\\work\\secret.pdf",
		]);
	});
});

describe("searchFiles ranking", () => {
	it("ranks a more recently modified, equally-matching file above a stale one", async () => {
		const db = await createDb();
		const now = Date.parse("2026-07-21T12:00:00.000Z");
		upsertFilesBatch(
			db,
			[
				fileRow({
					path: "C:\\a\\notes-stale.txt",
					name: "project-notes.txt",
					ext: "txt",
					mtime: now - 200 * 24 * 60 * 60 * 1000,
				}),
				fileRow({ path: "C:\\a\\notes-fresh.txt", name: "project-notes-fresh.txt", ext: "txt", mtime: now }),
			],
			1000,
		);
		rebuildFtsIndex(db);
		const results = searchFiles(db, "project", null, 10, { now });
		expect(results).toHaveLength(2); // non-vacuous: both rows actually matched
		expect(results[0].path).toBe("C:\\a\\notes-fresh.txt");
	});

	it("caps results at the requested limit even though ranking widens the internal candidate pool", async () => {
		const db = await createDb();
		const rows = Array.from({ length: 12 }, (_, i) =>
			fileRow({ path: `C:\\a\\report-${i}.txt`, name: `report-${i}.txt`, ext: "txt" }),
		);
		upsertFilesBatch(db, rows, 1000);
		rebuildFtsIndex(db);
		const results = searchFiles(db, "report", null, 5);
		expect(results).toHaveLength(5);
	});

	// Isolated proof that frecency is wired end-to-end through the REAL events
	// table (not just unit-tested in file-ranking.cjs with a hand-built
	// frecencyByPath map): launcher.execute events are recorded with the
	// provider-namespaced id ("files::<path>", see launcher-providers/
	// index.cjs's header), so this seeds exactly that shape directly into
	// `events` and expects searchFiles() to read it back out via its own
	// loadFileFrecency().
	it("promotes a heavily-and-recently-executed file over a fresher never-executed one, via real events rows", async () => {
		const db = await createDb();
		const now = Date.parse("2026-07-21T12:00:00.000Z");
		const heavilyUsedPath = "C:\\a\\quarterly-summary.txt";
		const neverUsedPath = "C:\\a\\quarterly-draft.txt";
		upsertFilesBatch(
			db,
			[
				fileRow({ path: heavilyUsedPath, name: "quarterly-summary.txt", ext: "txt", mtime: now - 90 * 24 * 60 * 60 * 1000 }),
				fileRow({ path: neverUsedPath, name: "quarterly-draft.txt", ext: "txt", mtime: now }),
			],
			1000,
		);
		rebuildFtsIndex(db);

		// Baseline: with no execution history at all, the fresher (never-used)
		// file wins on recency alone -- the control this test's real assertion
		// is measured against.
		const baseline = searchFiles(db, "quarterly", "env-x", 10, { now });
		expect(baseline).toHaveLength(2);
		expect(baseline[0].path).toBe(neverUsedPath);

		for (let i = 0; i < 15; i += 1) {
			db.run("INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, ?)", [
				new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
				"env-x",
				"launcher.execute",
				`files::${heavilyUsedPath}`,
				null,
				null,
			]);
		}

		const ranked = searchFiles(db, "quarterly", "env-x", 10, { now });
		expect(ranked[0].path).toBe(heavilyUsedPath);
	});

	// A DIFFERENT environment's frecency history for the exact same file must
	// never leak into this environment's ranking (WP-0.8's per-environment
	// frecency scoping, mirrored from launcher-providers/index.cjs's own
	// loadFrecency()).
	it("never uses another environment's execution history when ranking for this environment", async () => {
		const db = await createDb();
		const now = Date.parse("2026-07-21T12:00:00.000Z");
		const targetPath = "C:\\a\\quarterly-summary.txt";
		upsertFilesBatch(
			db,
			[
				fileRow({ path: targetPath, name: "quarterly-summary.txt", ext: "txt", mtime: now - 90 * 24 * 60 * 60 * 1000 }),
				fileRow({ path: "C:\\a\\quarterly-draft.txt", name: "quarterly-draft.txt", ext: "txt", mtime: now }),
			],
			1000,
		);
		rebuildFtsIndex(db);

		for (let i = 0; i < 15; i += 1) {
			db.run("INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, ?)", [
				new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
				"env-other",
				"launcher.execute",
				`files::${targetPath}`,
				null,
				null,
			]);
		}

		const ranked = searchFiles(db, "quarterly", "env-x", 10, { now });
		// Still the fresher file -- env-other's heavy usage of targetPath must
		// not be visible while ranking for env-x.
		expect(ranked[0].path).toBe("C:\\a\\quarterly-draft.txt");
	});
});
