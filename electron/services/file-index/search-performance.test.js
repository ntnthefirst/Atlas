import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { rebuildFtsIndex, searchFiles, upsertFilesBatch } from "./store.cjs";

// ---------------------------------------------------------------------------
// A real, measured sanity check against WP-2.5's own "<50ms at 100k files"
// query-latency criterion, which that WP asserted only indirectly (indexed
// queries, batched transactions) and never actually benchmarked -- see this
// WP's own brief. This is not a strict CI gate: the threshold below is
// intentionally generous (an order of magnitude looser than 50ms) so it
// catches a genuine gross regression (an accidental full table scan, a
// forgotten index, an unbounded candidate pool) without being flaky across
// whatever machine happens to run the test suite. The ACTUAL measured
// numbers are always printed to console.log, unconditionally, so a real
// number is on record rather than only a boolean pass/fail.
//
// 100k rows generated synthetically (not a real crawl) -- cheap enough to
// build in-process (batched exactly like the real crawler does, ~1000 rows
// per transaction) without needing a real 100k-file tree on disk, which
// would make this suite slow, environment-dependent, and unable to run in
// CI at all.
// ---------------------------------------------------------------------------

const TOTAL_FILES = 100_000;
const BATCH_SIZE = 1000;
const NOW = Date.parse("2026-07-22T12:00:00.000Z");

const EXTENSIONS = ["pdf", "docx", "xlsx", "txt", "jpg", "png", "tsx", "ts", "js", "json", "mp3", "zip", "csv"];
const NAME_TEMPLATES = ["report", "invoice", "photo", "component", "notes", "budget", "draft", "summary", "archive"];
const ROOTS = [
	{ id: "root:documents", dir: "C:\\Users\\bench\\Documents" },
	{ id: "root:downloads", dir: "C:\\Users\\bench\\Downloads" },
	{ id: "root:pictures", dir: "C:\\Users\\bench\\Pictures" },
	{ id: "root:projects", dir: "C:\\Users\\bench\\projects\\app\\src\\components" },
	{ id: "root:music", dir: "C:\\Users\\bench\\Music" },
];

// Deterministic (no real randomness -- a fixed seed run always generates the
// exact same corpus) but varied enough to exercise realistic FTS token
// diversity, extension diversity, and path depth diversity.
function generateSyntheticCorpus(count) {
	const rows = new Array(count);
	for (let i = 0; i < count; i += 1) {
		const root = ROOTS[i % ROOTS.length];
		const template = NAME_TEMPLATES[i % NAME_TEMPLATES.length];
		const ext = EXTENSIONS[i % EXTENSIONS.length];
		const subfolder = `folder-${i % 50}`;
		const name = `${template}-${i}.${ext}`;
		rows[i] = {
			path: `${root.dir}\\${subfolder}\\${name}`,
			name,
			ext,
			size: 1024 + (i % 5000),
			mtime: NOW - (i % 720) * 24 * 60 * 60 * 1000,
			environmentId: null,
			root: root.id,
		};
	}
	return rows;
}

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-search-perf-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("file-index search latency at 100k files (real, measured)", () => {
	it(
		"stays comfortably fast for plain, ext:, in:, and composed filter queries",
		async () => {
			const db = await AtlasDatabase.create(createTempDbPath());
			const corpus = generateSyntheticCorpus(TOTAL_FILES);

			const insertStart = performance.now();
			for (let offset = 0; offset < corpus.length; offset += BATCH_SIZE) {
				upsertFilesBatch(db, corpus.slice(offset, offset + BATCH_SIZE), NOW);
			}
			const insertMs = performance.now() - insertStart;

			const rebuildStart = performance.now();
			rebuildFtsIndex(db);
			const rebuildMs = performance.now() - rebuildStart;

			expect(db.first("SELECT COUNT(*) AS count FROM files").count).toBe(TOTAL_FILES);

			const queries = [
				{ label: "plain free-text (common token)", query: "report" },
				{ label: "plain free-text (specific)", query: "invoice-4210" },
				{ label: "ext: filter + free text", query: "ext:pdf report" },
				{ label: "in: filter + free text", query: "in:documents budget" },
				{ label: "composed ext: + in: + free text", query: "ext:pdf in:documents report" },
			];

			const measurements = queries.map(({ label, query }) => {
				const start = performance.now();
				const results = searchFiles(db, query, null, 20, { now: NOW });
				const elapsedMs = performance.now() - start;
				return { label, query, elapsedMs, resultCount: results.length };
			});

			console.log(
				`[perf] 100k-file corpus: insert (batched, ${TOTAL_FILES / BATCH_SIZE} transactions) = ${insertMs.toFixed(1)}ms, FTS rebuild = ${rebuildMs.toFixed(1)}ms`,
			);
			for (const m of measurements) {
				console.log(`[perf] query ${JSON.stringify(m.query)} (${m.label}): ${m.elapsedMs.toFixed(2)}ms, ${m.resultCount} result(s)`);
			}

			// Every representative query returned something -- a 0-result query
			// would make its own latency measurement meaningless (an empty-set
			// SQL query can look artificially fast).
			for (const m of measurements) {
				expect(m.resultCount).toBeGreaterThan(0);
			}

			// Generous, non-flaky ceiling (see this file's header) -- catches a
			// gross regression, not a micro-benchmark.
			const SEARCH_CEILING_MS = 500;
			for (const m of measurements) {
				expect(m.elapsedMs, `query ${JSON.stringify(m.query)} took ${m.elapsedMs.toFixed(2)}ms`).toBeLessThan(
					SEARCH_CEILING_MS,
				);
			}
		},
		// The per-query assertions above are what this test actually measures;
		// this ceiling only has to be large enough to seed 100k rows. It was
		// 30s, which was ample when the suite was small and started timing out
		// once the suite grew past a hundred files running in parallel -- the
		// seeding competes for the same disk and cores. Raising it weakens
		// nothing: the measurements are wall-clock timings of individual
		// queries, not of this budget.
		120_000,
	);
});
