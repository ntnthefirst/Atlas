import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { rebuildFtsIndex, searchFiles, upsertFilesBatch } from "./store.cjs";

// ---------------------------------------------------------------------------
// WP-2.7's own explicit acceptance criterion: "A documented benchmark set of
// 20 realistic queries, with the expected result in the top 3 for at least
// 18." This file IS that documentation -- BENCHMARK_QUERIES below lists every
// query, the file it's expected to surface, and WHY (what's competing against
// it and which ranking signal is supposed to settle it) -- plus the single
// test at the bottom that actually runs all 20 against a realistic fixture
// corpus and asserts the >=18/20 threshold, so a future ranking regression
// fails this suite rather than silently degrading search quality.
//
// -- The corpus --------------------------------------------------------------
// FIXTURE_FILES is the kind of file tree actually on a Windows machine:
// invoices, code, photos, downloads, notes, contracts -- realistic names,
// realistic nesting, and DELIBERATE near-duplicates (an "-old"/"-final"/
// "-corrected"/"-signed" sibling, a same-named file in two different
// projects, ...) so a query that only has ONE plausible answer in a toy
// corpus still has to out-rank real competitors here, exactly like it would
// on a real disk.
//
// -- Why each query is answerable in principle --------------------------
// Every query's tokens are chosen so FTS5's own prefix MATCH (see
// store.cjs's sanitizeMatchQuery) returns AT LEAST the expected file as a
// candidate -- a query this benchmark can never pass no matter how good the
// ranking is (because the file wouldn't even reach the candidate pool) would
// be testing FTS5's tokenizer, not this WP's ranking blend.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => NOW - n * DAY_MS;
const BENCH_ENV = "env-bench";

const P = (...segments) => ["C:\\Users\\nathan", ...segments].join("\\");

// { path, name, ext, mtime } -- every file lives in the same (global) scope
// and the same benchmark environment; `root` values are plain category tags
// that deliberately never contain the substring "work" themselves, so the
// in:work benchmark query (#20) is only ever satisfied by the PATH segment
// check, never an accidental root-id match.
const FIXTURE_FILES = [
	// Invoices -- a realistic "same document, several revisions" cluster.
	{ path: P("Documents", "Invoices", "2024", "invoice-march.pdf"), ext: "pdf", mtime: daysAgo(5), root: "root:documents" },
	{ path: P("Documents", "Invoices", "2024", "invoice-april.pdf"), ext: "pdf", mtime: daysAgo(40), root: "root:documents" },
	{ path: P("Documents", "Invoices", "2023", "invoice-december.pdf"), ext: "pdf", mtime: daysAgo(200), root: "root:documents" },
	{
		path: P("Documents", "Invoices", "2024", "invoice-march-corrected.pdf"),
		ext: "pdf",
		mtime: daysAgo(20),
		root: "root:documents",
	},
	{ path: P("Documents", "Invoices", "2024", "invoice-march.xlsx"), ext: "xlsx", mtime: daysAgo(90), root: "root:documents" },
	{ path: P("Documents", "Receipts", "receipt-amazon-2024.pdf"), ext: "pdf", mtime: daysAgo(15), root: "root:documents" },

	// Work reports / budget -- under a literal "Work" folder (feeds in:work).
	{
		path: P("Documents", "Work", "Reports", "quarterly-report-q1.docx"),
		ext: "docx",
		mtime: daysAgo(100),
		root: "root:documents",
	},
	{
		path: P("Documents", "Work", "Reports", "quarterly-report-q2.docx"),
		ext: "docx",
		mtime: daysAgo(10),
		root: "root:documents",
	},
	{
		path: P("Documents", "Work", "Reports", "annual-summary-2023.docx"),
		ext: "docx",
		mtime: daysAgo(300),
		root: "root:documents",
	},
	{ path: P("Documents", "Work", "Budget", "budget-2024.xlsx"), ext: "xlsx", mtime: daysAgo(8), root: "root:documents" },
	{ path: P("Documents", "Work", "Budget", "budget-2023.xlsx"), ext: "xlsx", mtime: daysAgo(380), root: "root:documents" },
	{ path: P("Documents", "Personal", "taxes-2024.pdf"), ext: "pdf", mtime: daysAgo(60), root: "root:documents" },

	// Code projects -- two projects sharing a component name pattern.
	{ path: P("projects", "atlas", "src", "components", "Button.tsx"), ext: "tsx", mtime: daysAgo(3), root: "root:projects" },
	{
		path: P("projects", "atlas", "src", "components", "ButtonGroup.tsx"),
		ext: "tsx",
		mtime: daysAgo(50),
		root: "root:projects",
	},
	{
		path: P("projects", "atlas", "src", "components", "ButtonIcon.tsx"),
		ext: "tsx",
		mtime: daysAgo(70),
		root: "root:projects",
	},
	{
		path: P("projects", "atlas", "src", "components", "Button.test.tsx"),
		ext: "tsx",
		mtime: daysAgo(45),
		root: "root:projects",
	},
	{ path: P("projects", "atlas", "package.json"), ext: "json", mtime: daysAgo(3), root: "root:projects" },
	{ path: P("projects", "website", "README.md"), ext: "md", mtime: daysAgo(200), root: "root:projects" },
	{
		path: P("projects", "website", "src", "components", "Header.tsx"),
		ext: "tsx",
		mtime: daysAgo(150),
		root: "root:projects",
	},

	// Photos.
	{ path: P("Pictures", "Vacation2024", "beach-sunset.jpg"), ext: "jpg", mtime: daysAgo(120), root: "root:pictures" },
	{ path: P("Pictures", "Vacation2024", "beach-morning.jpg"), ext: "jpg", mtime: daysAgo(120), root: "root:pictures" },
	{
		path: P("Pictures", "Screenshots", "screenshot-2024-01-15.png"),
		ext: "png",
		mtime: daysAgo(180),
		root: "root:pictures",
	},
	{
		path: P("Pictures", "Screenshots", "screenshot-2023-11-02.png"),
		ext: "png",
		mtime: daysAgo(400),
		root: "root:pictures",
	},
	{ path: P("Desktop", "family-photo.jpg"), ext: "jpg", mtime: daysAgo(250), root: "root:desktop" },

	// Downloads.
	{ path: P("Downloads", "setup-installer.exe"), ext: "exe", mtime: daysAgo(30), root: "root:downloads" },
	{ path: P("Downloads", "driver-update-v3.exe"), ext: "exe", mtime: daysAgo(500), root: "root:downloads" },
	{ path: P("Downloads", "atlas-v1.2.0.zip"), ext: "zip", mtime: daysAgo(25), root: "root:downloads" },
	{ path: P("Downloads", "resume-nathan-2024.pdf"), ext: "pdf", mtime: daysAgo(12), root: "root:downloads" },
	{ path: P("Downloads", "resume-nathan-old.pdf"), ext: "pdf", mtime: daysAgo(400), root: "root:downloads" },

	// Music.
	{ path: P("Music", "playlist-workout.mp3"), ext: "mp3", mtime: daysAgo(15), root: "root:music" },
	{ path: P("Music", "favorite-song.mp3"), ext: "mp3", mtime: daysAgo(300), root: "root:music" },

	// Presentations (also under Work -- more in:work candidates).
	{
		path: P("Documents", "Work", "Presentations", "project-kickoff.pptx"),
		ext: "pptx",
		mtime: daysAgo(95),
		root: "root:documents",
	},
	{
		path: P("Documents", "Work", "Presentations", "project-kickoff-final.pptx"),
		ext: "pptx",
		mtime: daysAgo(18),
		root: "root:documents",
	},

	// Notes.
	{
		path: P("Documents", "Notes", "meeting-notes-2024-06-01.txt"),
		ext: "txt",
		mtime: daysAgo(45),
		root: "root:documents",
	},
	{ path: P("Documents", "Notes", "project-notes.txt"), ext: "txt", mtime: daysAgo(55), root: "root:documents" },
	// Older than random-notes-draft.txt below, but heavily-and-recently
	// executed (see SEEDED_FRECENCY) -- the deliberate frecency-vs-recency
	// benchmark case (#11).
	{ path: P("Documents", "Notes", "daily-standup-notes.txt"), ext: "txt", mtime: daysAgo(60), root: "root:documents" },
	{ path: P("Documents", "Notes", "random-notes-draft.txt"), ext: "txt", mtime: daysAgo(2), root: "root:documents" },

	// Personal finance.
	{
		path: P("Documents", "Personal", "Finance", "bank-statement-july-2024.pdf"),
		ext: "pdf",
		mtime: daysAgo(6),
		root: "root:documents",
	},
	{
		path: P("Documents", "Personal", "Finance", "bank-statement-june-2024.pdf"),
		ext: "pdf",
		mtime: daysAgo(36),
		root: "root:documents",
	},

	// Contracts (also under Work).
	{
		path: P("Documents", "Work", "Contracts", "contract-acme-corp.docx"),
		ext: "docx",
		mtime: daysAgo(80),
		root: "root:documents",
	},
	{
		path: P("Documents", "Work", "Contracts", "contract-acme-corp-signed.pdf"),
		ext: "pdf",
		mtime: daysAgo(14),
		root: "root:documents",
	},
].map((file) => ({ ...file, name: path.win32.basename(file.path), environmentId: null }));

// A file this benchmark expects frecency (not recency) to promote --
// "daily-standup-notes.txt" is OLDER than "random-notes-draft.txt" but has
// been opened from the launcher constantly and recently.
const SEEDED_FRECENCY = {
	subject: `files::${P("Documents", "Notes", "daily-standup-notes.txt")}`,
	count: 25,
	lastTsIso: new Date(daysAgo(1)).toISOString(),
};

function seedFrecencyEvent(db, { subject, count, lastTsIso, environmentId }) {
	for (let i = 0; i < count; i += 1) {
		db.run("INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, ?)", [
			i === count - 1 ? lastTsIso : new Date(Date.parse(lastTsIso) - (count - i) * DAY_MS).toISOString(),
			environmentId,
			"launcher.execute",
			subject,
			null,
			null,
		]);
	}
}

// { query, expectedPath, why } -- the "documented" part of this acceptance
// criterion. `why` names the competing file(s) and the signal that's
// supposed to settle the tie, so a failure here points straight at which
// part of the blend regressed.
const BENCHMARK_QUERIES = [
	{
		query: "invoice march",
		expectedPath: P("Documents", "Invoices", "2024", "invoice-march.pdf"),
		why: "Competes with invoice-march-corrected.pdf and invoice-march.xlsx (both also match 'invoice'+'march'); recency picks the plain, most-recently-touched one.",
	},
	{
		query: "button",
		expectedPath: P("projects", "atlas", "src", "components", "Button.tsx"),
		why: "Button.tsx, ButtonGroup.tsx, ButtonIcon.tsx, and Button.test.tsx all start with 'button' (tied matchScore); recency + bm25 (shortest name) favour the original component file.",
	},
	{
		query: "resume",
		expectedPath: P("Downloads", "resume-nathan-2024.pdf"),
		why: "Ties with resume-nathan-old.pdf on a name-prefix match; recency (2024 is far newer) breaks the tie.",
	},
	{
		query: "quarterly report q1",
		expectedPath: P("Documents", "Work", "Reports", "quarterly-report-q1.docx"),
		why: "The 'q1' token excludes quarterly-report-q2.docx from the FTS candidate set entirely -- a clean, unique match.",
	},
	{
		query: "budget 2024",
		expectedPath: P("Documents", "Work", "Budget", "budget-2024.xlsx"),
		why: "The '2024' token excludes budget-2023.xlsx from the FTS candidate set entirely -- a clean, unique match.",
	},
	{
		query: "beach sunset",
		expectedPath: P("Pictures", "Vacation2024", "beach-sunset.jpg"),
		why: "The 'sunset' token excludes beach-morning.jpg from the FTS candidate set entirely -- a clean, unique match.",
	},
	{
		query: "screenshot",
		expectedPath: P("Pictures", "Screenshots", "screenshot-2024-01-15.png"),
		why: "Ties on a name-prefix match with screenshot-2023-11-02.png; recency picks the newer one.",
	},
	{
		query: "family photo",
		expectedPath: P("Desktop", "family-photo.jpg"),
		why: "Unique multi-token ('family' + 'photo') match in this corpus.",
	},
	{
		query: "setup installer",
		expectedPath: P("Downloads", "setup-installer.exe"),
		why: "Unique multi-token match; driver-update-v3.exe shares no tokens with the query.",
	},
	{
		query: "atlas zip",
		expectedPath: P("Downloads", "atlas-v1.2.0.zip"),
		why: "Unique file whose NAME (not just its containing project folder) contains 'atlas'.",
	},
	{
		query: "notes",
		expectedPath: P("Documents", "Notes", "daily-standup-notes.txt"),
		why: "random-notes-draft.txt is fresher (mtime), but daily-standup-notes.txt has 25 seeded launcher.execute events -- frecency is expected to win over raw recency here.",
	},
	{
		query: "playlist workout",
		expectedPath: P("Music", "playlist-workout.mp3"),
		why: "Unique multi-token match.",
	},
	{
		query: "meeting notes",
		expectedPath: P("Documents", "Notes", "meeting-notes-2024-06-01.txt"),
		why: "The 'meeting' token excludes every other *-notes*.txt file from the FTS candidate set entirely.",
	},
	{
		query: "project notes",
		expectedPath: P("Documents", "Notes", "project-notes.txt"),
		why: "The 'project' token excludes every other *-notes*.txt file from the FTS candidate set entirely.",
	},
	{
		query: "bank statement july",
		expectedPath: P("Documents", "Personal", "Finance", "bank-statement-july-2024.pdf"),
		why: "The 'july' token excludes bank-statement-june-2024.pdf from the FTS candidate set entirely.",
	},
	{
		query: "contract acme",
		expectedPath: P("Documents", "Work", "Contracts", "contract-acme-corp-signed.pdf"),
		why: "Ties with contract-acme-corp.docx on a multi-token match ('contract' + 'acme'); recency picks the more recently touched (signed) copy.",
	},
	{
		query: "resume nathan 2024",
		expectedPath: P("Downloads", "resume-nathan-2024.pdf"),
		why: "The '2024' token excludes resume-nathan-old.pdf from the FTS candidate set entirely.",
	},
	{
		query: "ext:pdf invoice",
		expectedPath: P("Documents", "Invoices", "2024", "invoice-march.pdf"),
		why: "ext:pdf excludes invoice-march.xlsx; the remaining 4 PDF invoices tie on a name-prefix match, recency picks the newest.",
	},
	{
		query: "ext:docx report",
		expectedPath: P("Documents", "Work", "Reports", "quarterly-report-q2.docx"),
		why: "ext:docx narrows to the two quarterly-report docx files (word-boundary match); recency picks q2, the more recently touched.",
	},
	{
		query: "in:work budget",
		expectedPath: P("Documents", "Work", "Budget", "budget-2024.xlsx"),
		why: "in:work narrows to files under the Work folder; both budget files qualify and tie on a name-prefix match, recency picks 2024.",
	},
];

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ranking-benchmark-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function seedBenchmarkDb() {
	const db = await AtlasDatabase.create(createTempDbPath());
	upsertFilesBatch(db, FIXTURE_FILES, NOW);
	rebuildFtsIndex(db);
	seedFrecencyEvent(db, { ...SEEDED_FRECENCY, environmentId: BENCH_ENV });
	return db;
}

describe("WP-2.7 ranking benchmark -- 20 realistic queries", () => {
	it("has no duplicate query text (every case below is independently meaningful)", () => {
		const queries = BENCHMARK_QUERIES.map((c) => c.query);
		expect(new Set(queries).size).toBe(queries.length);
		expect(BENCHMARK_QUERIES).toHaveLength(20);
	});

	it("every expected file actually exists in the fixture corpus (guards against a typo silently passing vacuously)", () => {
		const fixturePaths = new Set(FIXTURE_FILES.map((f) => f.path));
		for (const { query, expectedPath } of BENCHMARK_QUERIES) {
			expect(fixturePaths.has(expectedPath), `expected file for query "${query}" is missing from the fixture corpus`).toBe(
				true,
			);
		}
	});

	it("places the expected result in the top 3 for at least 18 of the 20 benchmark queries", async () => {
		const db = await seedBenchmarkDb();

		const outcomes = BENCHMARK_QUERIES.map(({ query, expectedPath }) => {
			const results = searchFiles(db, query, BENCH_ENV, 10, { now: NOW });
			const rank = results.findIndex((r) => r.path === expectedPath);
			return { query, expectedPath, rank, top3: rank !== -1 && rank < 3 };
		});

		const passCount = outcomes.filter((o) => o.top3).length;
		const failures = outcomes.filter((o) => !o.top3);

		// Printed unconditionally (not just on failure) so a full run of this
		// suite documents the actual measured score, per this WP's acceptance
		// criterion -- not just a boolean pass/fail.
		console.log(
			`[ranking benchmark] ${passCount}/${outcomes.length} queries placed their expected result in the top 3.`,
		);
		if (failures.length > 0) {
			console.log(
				"[ranking benchmark] misses:",
				failures.map((f) => `"${f.query}" -> expected rank ${f.rank === -1 ? "not returned" : f.rank + 1}`),
			);
		}

		expect(passCount).toBeGreaterThanOrEqual(18);
	});
});
