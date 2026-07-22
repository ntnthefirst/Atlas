import { describe, expect, it } from "vitest";
import {
	computeBm25Scores,
	computeDepthScore,
	computeEnvironmentScore,
	computeNameMatchScore,
	computeRecencyScore,
	rankFileResults,
} from "./file-ranking.cjs";

// ---------------------------------------------------------------------------
// Pure file ranking (WP-2.7) -- fixed-input unit tests, per the WP's own
// acceptance criterion. No db, no Electron, no async: every case here pins
// down an exact number or an exact order so a future change to the scoring
// formula has to update these tests on purpose, not by accident.
// ---------------------------------------------------------------------------

describe("computeNameMatchScore()", () => {
	it("scores an exact name match highest", () => {
		expect(computeNameMatchScore("report.pdf", "report.pdf")).toBe(100);
	});

	it("scores a name-starts-with match above a word-boundary match", () => {
		const startsWith = computeNameMatchScore("invoice", "invoice-march.pdf");
		const wordBoundary = computeNameMatchScore("march", "invoice-march.pdf");
		expect(startsWith).toBe(90);
		expect(wordBoundary).toBe(82);
		expect(startsWith).toBeGreaterThan(wordBoundary);
	});

	it("scores a word-boundary match above a mere substring match", () => {
		const wordBoundary = computeNameMatchScore("march", "invoice-march.pdf");
		const substring = computeNameMatchScore("voice", "invoice-march.pdf");
		expect(wordBoundary).toBe(82);
		expect(substring).toBe(68);
		expect(wordBoundary).toBeGreaterThan(substring);
	});

	it("scores a multi-token (any order) match above a fuzzy subsequence-only match", () => {
		const multiToken = computeNameMatchScore("march invoice", "invoice-march.pdf");
		expect(multiToken).toBe(55);
	});

	it("scores a fuzzy (typo'd/abbreviated) subsequence match low but non-zero", () => {
		const fuzzy = computeNameMatchScore("invmar", "invoice-march.pdf");
		expect(fuzzy).toBeGreaterThan(0);
		expect(fuzzy).toBeLessThan(55); // below every "real" tier above it
	});

	it("scores 0 when the query is not even a subsequence of the name", () => {
		expect(computeNameMatchScore("xyz-nope", "invoice-march.pdf")).toBe(0);
	});

	it("is case-insensitive", () => {
		expect(computeNameMatchScore("REPORT", "report.pdf")).toBe(90);
	});

	it("returns a neutral baseline for an empty/blank query, equal for every file", () => {
		expect(computeNameMatchScore("", "anything.txt")).toBe(50);
		expect(computeNameMatchScore("   ", "something-else.txt")).toBe(50);
	});

	it("returns 0 for a file with no usable name", () => {
		expect(computeNameMatchScore("report", "")).toBe(0);
		expect(computeNameMatchScore("report", null)).toBe(0);
	});
});

describe("computeRecencyScore()", () => {
	const now = Date.parse("2026-07-21T12:00:00.000Z");

	it("is 0 for a file with no usable mtime", () => {
		expect(computeRecencyScore(0, { now })).toBe(0);
		expect(computeRecencyScore(null, { now })).toBe(0);
		expect(computeRecencyScore(NaN, { now })).toBe(0);
	});

	it("is higher for a more recently modified file, all else equal", () => {
		const recent = computeRecencyScore(now - 1 * 24 * 60 * 60 * 1000, { now });
		const stale = computeRecencyScore(now - 90 * 24 * 60 * 60 * 1000, { now });
		expect(recent).toBeGreaterThan(stale);
	});

	it("decays to exactly half after one half-life", () => {
		const halfLifeDays = 30;
		const atHalfLife = computeRecencyScore(now - halfLifeDays * 24 * 60 * 60 * 1000, { now, halfLifeDays });
		expect(atHalfLife).toBeCloseTo(50, 5);
	});

	it("a file modified at exactly `now` scores exactly 100", () => {
		expect(computeRecencyScore(now, { now })).toBeCloseTo(100, 5);
	});
});

describe("computeDepthScore()", () => {
	it("scores a shallower path higher than a deeper one", () => {
		const shallow = computeDepthScore("C:\\Users\\me\\file.txt");
		const deep = computeDepthScore("C:\\Users\\me\\a\\b\\c\\d\\e\\f\\file.txt");
		expect(shallow).toBeGreaterThan(deep);
	});

	it("never goes negative for a pathologically deep path", () => {
		const veryDeep = "C:\\" + Array.from({ length: 40 }, (_, i) => `level${i}`).join("\\") + "\\file.txt";
		expect(computeDepthScore(veryDeep)).toBe(0);
	});

	it("returns a neutral score for a missing/blank path", () => {
		expect(computeDepthScore("")).toBe(50);
		expect(computeDepthScore(null)).toBe(50);
	});
});

describe("computeEnvironmentScore()", () => {
	it("boosts a row owned by the currently active environment", () => {
		expect(computeEnvironmentScore("env-a", "env-a")).toBe(100);
	});

	it("is neutral for a global (unassociated) row", () => {
		expect(computeEnvironmentScore(null, "env-a")).toBe(50);
	});

	it("is neutral (never a boost) when there is no active environment to prefer", () => {
		expect(computeEnvironmentScore(null, null)).toBe(50);
	});

	it("is neutral for a row belonging to a different environment (defensive -- should never actually reach here)", () => {
		expect(computeEnvironmentScore("env-b", "env-a")).toBe(50);
	});
});

describe("computeBm25Scores()", () => {
	it("scores the best (most negative) bm25 value 100, ranked by RELATIVE ORDER, not raw magnitude", () => {
		// The gap between -5 and -1 is huge; the gap the function actually
		// sees between -0.000002 and -0.0000015 (this build's real measured
		// scale, see this file's header) is tiny -- both must rank identically
		// (best=100, then a fixed step down per position) precisely BECAUSE
		// magnitude is deliberately ignored in favour of rank position.
		const wideGap = computeBm25Scores([{ bm25Rank: -5 }, { bm25Rank: -1 }, { bm25Rank: -3 }]);
		const tinyGap = computeBm25Scores([{ bm25Rank: -0.000002 }, { bm25Rank: -0.0000005 }, { bm25Rank: -0.0000015 }]);
		expect(wideGap).toEqual(tinyGap);
		expect(wideGap[0]).toBe(100); // -5 is the best (most negative)
		expect(wideGap[0]).toBeGreaterThan(wideGap[2]); // -3 (rank 1)
		expect(wideGap[2]).toBeGreaterThan(wideGap[1]); // -1 (rank 2, worst)
	});

	it("does not depend on the incoming array's order -- rank is derived internally from the bm25 values themselves", () => {
		const ascending = computeBm25Scores([{ bm25Rank: -5 }, { bm25Rank: -3 }, { bm25Rank: -1 }]);
		const shuffled = computeBm25Scores([{ bm25Rank: -1 }, { bm25Rank: -5 }, { bm25Rank: -3 }]);
		expect(ascending[0]).toBe(100); // -5, first in this array
		expect(shuffled[1]).toBe(100); // -5, second in this array -- same value, same score
		expect(ascending[0]).toBe(shuffled[1]);
	});

	it("scores every row 100 when every bm25 value is identical (a three-way tie in rank)", () => {
		const rows = [{ bm25Rank: -2 }, { bm25Rank: -2 }, { bm25Rank: -2 }];
		expect(computeBm25Scores(rows)).toEqual([100, 100, 100]);
	});

	it("is neutral (50) for every row when no bm25 value is present at all (a filters-only search)", () => {
		const rows = [{ path: "a" }, { path: "b" }];
		expect(computeBm25Scores(rows)).toEqual([50, 50]);
	});

	it("treats a row with a missing bm25 value as neutral even alongside rows that have one", () => {
		const rows = [{ bm25Rank: -4 }, {}, { bm25Rank: -1 }];
		const scores = computeBm25Scores(rows);
		expect(scores[0]).toBe(100); // best of the two that HAVE a value
		expect(scores[1]).toBe(50); // no value at all -- neutral
		expect(scores[2]).toBeLessThan(100); // worse than the best, still finite
		expect(scores[2]).toBeGreaterThan(0);
	});
});

describe("rankFileResults()", () => {
	const now = Date.parse("2026-07-21T12:00:00.000Z");

	it("ranks a better name match above a worse one when neither has recency, frecency, or bm25 signal", () => {
		const rows = [
			{ path: "C:\\a\\unrelated-notes.txt", name: "unrelated-notes.txt", mtime: 0, environment_id: null },
			{ path: "C:\\a\\report.pdf", name: "report.pdf", mtime: 0, environment_id: null },
		];
		const ranked = rankFileResults(rows, { query: "report", now });
		expect(ranked.map((r) => r.path)).toEqual(["C:\\a\\report.pdf", "C:\\a\\unrelated-notes.txt"]);
	});

	// The WP's own hard acceptance criterion, mirrored from ranking.cjs's own
	// test: frecency must DEMONSTRABLY promote a repeatedly-and-recently-
	// executed file over an equal-name-match file that has never been opened.
	it("promotes a frequently-and-recently-opened file over an equal-match file never opened", () => {
		const rows = [
			{ path: "C:\\a\\budget-draft.xlsx", name: "budget-draft.xlsx", mtime: 0, environment_id: null },
			{ path: "C:\\a\\budget-final.xlsx", name: "budget-final.xlsx", mtime: 0, environment_id: null },
		];
		// Both names merely CONTAIN "budget" (neither is a prefix), so both
		// score identically on name match alone -- isolating frecency as the
		// only thing that can tell them apart.
		const baseline = rankFileResults(rows, { query: "budget", now });
		expect(baseline[0].matchScore).toBe(baseline[1].matchScore);

		const frecencyByPath = new Map([
			["C:\\a\\budget-draft.xlsx", { count: 20, lastTs: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString() }],
		]);
		const ranked = rankFileResults(rows, { query: "budget", frecencyByPath, now });
		expect(ranked[0].path).toBe("C:\\a\\budget-draft.xlsx");
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
		expect(ranked[1].frecencyScore).toBe(0);
		expect(ranked[0].frecencyScore).toBeGreaterThan(0);
	});

	it("never lets frecency alone overturn a dramatically better name match", () => {
		const rows = [
			{ path: "C:\\a\\report.pdf", name: "report.pdf", mtime: 0, environment_id: null }, // exact match, never opened
			{ path: "C:\\a\\unrelated.pdf", name: "unrelated.pdf", mtime: 0, environment_id: null }, // no match at all, opened constantly
		];
		const frecencyByPath = new Map([
			["C:\\a\\unrelated.pdf", { count: 1000, lastTs: new Date(now).toISOString() }],
		]);
		const ranked = rankFileResults(rows, { query: "report.pdf", frecencyByPath, now });
		expect(ranked[0].path).toBe("C:\\a\\report.pdf");
	});

	it("never lets recency alone overturn a dramatically better name match", () => {
		const rows = [
			{ path: "C:\\a\\report.pdf", name: "report.pdf", mtime: 0, environment_id: null }, // exact match, ancient mtime
			{ path: "C:\\a\\unrelated.pdf", name: "unrelated.pdf", mtime: now, environment_id: null }, // no match, modified this instant
		];
		const ranked = rankFileResults(rows, { query: "report.pdf", now });
		expect(ranked[0].path).toBe("C:\\a\\report.pdf");
	});

	it("promotes a more recently modified file over an equal-match file that is stale, all else equal", () => {
		// Identical names (so matchScore/bm25/depth all tie exactly) and a path
		// for the FRESH file that sorts AFTER the stale one alphabetically ("z"
		// > "a") -- the deterministic name/path tiebreak alone would pick the
		// STALE file, so the only way the fresh file can win is via the
		// recency signal itself. (An earlier version of this test used
		// "notes-fresh.txt" vs "notes-stale.txt", where "fresh" alphabetically
		// precedes "stale" -- that accidentally passed even with recency
		// disabled entirely, caught by deliberately breaking recencyWeight
		// during development and seeing this test NOT fail.)
		const rows = [
			{ path: "C:\\a\\notes.txt", name: "notes.txt", mtime: now - 200 * 24 * 60 * 60 * 1000, environment_id: null },
			{ path: "C:\\z\\notes.txt", name: "notes.txt", mtime: now, environment_id: null },
		];
		const ranked = rankFileResults(rows, { query: "notes", now });
		expect(ranked[0].path).toBe("C:\\z\\notes.txt");
	});

	it("promotes a shallower path over an equal-match, equally-recent deeper one", () => {
		const rows = [
			{ path: "C:\\Users\\me\\a\\b\\c\\d\\e\\f\\deep-notes.txt", name: "notes.txt", mtime: 0, environment_id: null },
			{ path: "C:\\Users\\me\\notes.txt", name: "notes.txt", mtime: 0, environment_id: null },
		];
		const ranked = rankFileResults(rows, { query: "notes", now });
		expect(ranked[0].path).toBe("C:\\Users\\me\\notes.txt");
	});

	it("promotes a file owned by the active environment over an equal-match global file", () => {
		const rows = [
			{ path: "C:\\global\\plan.docx", name: "plan.docx", mtime: 0, environment_id: null },
			{ path: "C:\\work\\plan.docx", name: "plan.docx", mtime: 0, environment_id: "env-work" },
		];
		const ranked = rankFileResults(rows, { query: "plan", environmentId: "env-work", now });
		expect(ranked[0].path).toBe("C:\\work\\plan.docx");
	});

	it("factors bm25 into an otherwise-tied blend without letting it dominate", () => {
		const rows = [
			{ path: "C:\\a\\alpha-report.pdf", name: "alpha-report.pdf", mtime: 0, environment_id: null, bm25Rank: -1 },
			{ path: "C:\\a\\report-alpha.pdf", name: "report-alpha.pdf", mtime: 0, environment_id: null, bm25Rank: -9 },
		];
		// Both start with "report"? No -- craft so matchScore ties exactly:
		// neither is a prefix of the query "alpha report" in a way that
		// differs; use a query where both tie on the multi-token (55) tier.
		const ranked = rankFileResults(rows, { query: "alpha report", now });
		expect(ranked[0].matchScore).toBe(ranked[1].matchScore);
		// The row with the better (more negative) bm25 value wins the tie.
		expect(ranked[0].path).toBe("C:\\a\\report-alpha.pdf");
	});

	it("breaks a fully-tied score deterministically by name, then path", () => {
		const rows = [
			{ path: "C:\\z\\zebra.txt", name: "zebra.txt", mtime: 0, environment_id: null },
			{ path: "C:\\a\\apple.txt", name: "apple.txt", mtime: 0, environment_id: null },
		];
		const ranked = rankFileResults(rows, { query: "", now });
		expect(ranked.map((r) => r.name)).toEqual(["apple.txt", "zebra.txt"]);
	});

	it("does not mutate the input array or its row objects", () => {
		const rows = [{ path: "C:\\a\\report.pdf", name: "report.pdf", mtime: 0, environment_id: null }];
		const frozenCopy = JSON.parse(JSON.stringify(rows));
		rankFileResults(rows, { query: "report", now });
		expect(rows).toEqual(frozenCopy);
	});

	it("accepts a plain object as well as a Map for frecencyByPath", () => {
		const rows = [
			{ path: "C:\\a\\one.txt", name: "notes.txt", mtime: 0, environment_id: null },
			{ path: "C:\\a\\two.txt", name: "notes.txt", mtime: 0, environment_id: null },
		];
		const ranked = rankFileResults(rows, {
			query: "notes",
			frecencyByPath: { "C:\\a\\one.txt": { count: 10, lastTs: new Date(now).toISOString() } },
			now,
		});
		expect(ranked[0].path).toBe("C:\\a\\one.txt");
	});

	it("returns an empty array for empty/non-array input", () => {
		expect(rankFileResults([], { query: "x" })).toEqual([]);
		expect(rankFileResults(undefined, { query: "x" })).toEqual([]);
	});
});
