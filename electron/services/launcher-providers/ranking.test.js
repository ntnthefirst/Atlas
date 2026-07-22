import { describe, expect, it } from "vitest";
import { computeMatchScore, computeFrecencyScore, rankResults } from "./ranking.cjs";

// ---------------------------------------------------------------------------
// Pure ranking (WP-2.2) -- fixed-input unit tests, per the WP's own
// acceptance criterion. No db, no Electron, no async: every case here pins
// down an exact number or an exact order so a future change to the scoring
// formula has to update these tests on purpose, not by accident.
// ---------------------------------------------------------------------------

describe("computeMatchScore()", () => {
	it("scores an exact title match highest", () => {
		expect(computeMatchScore("settings", { title: "Settings", subtitle: "Atlas" })).toBe(100);
	});

	it("scores a title-starts-with match above a mere substring match", () => {
		const startsWith = computeMatchScore("set", { title: "Settings", subtitle: null });
		const contains = computeMatchScore("ttin", { title: "Settings", subtitle: null });
		expect(startsWith).toBe(80);
		expect(contains).toBe(60);
		expect(startsWith).toBeGreaterThan(contains);
	});

	it("scores a subtitle-only match lower than any title match", () => {
		const subtitleOnly = computeMatchScore("focus", { title: "Start a session", subtitle: "Focus" });
		expect(subtitleOnly).toBe(40);
	});

	it("scores 0 when neither title nor subtitle match", () => {
		expect(computeMatchScore("xyz-nope", { title: "Settings", subtitle: "Atlas" })).toBe(0);
	});

	it("is case-insensitive", () => {
		expect(computeMatchScore("SETTINGS", { title: "settings", subtitle: null })).toBe(100);
	});

	it("returns a neutral baseline for an empty/blank query, equal for every result", () => {
		expect(computeMatchScore("", { title: "Anything", subtitle: null })).toBe(50);
		expect(computeMatchScore("   ", { title: "Something else", subtitle: null })).toBe(50);
	});
});

describe("computeFrecencyScore()", () => {
	const now = Date.parse("2026-07-21T12:00:00.000Z");

	it("is 0 for a result with no execution history", () => {
		expect(computeFrecencyScore(null, { now })).toBe(0);
		expect(computeFrecencyScore(undefined, { now })).toBe(0);
		expect(computeFrecencyScore({ count: 0, lastTs: new Date(now).toISOString() }, { now })).toBe(0);
	});

	it("is higher for a result executed more recently, all else equal", () => {
		const recent = computeFrecencyScore(
			{ count: 3, lastTs: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString() },
			{ now },
		);
		const stale = computeFrecencyScore(
			{ count: 3, lastTs: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString() },
			{ now },
		);
		expect(recent).toBeGreaterThan(stale);
	});

	it("is higher for a result executed more often, all else equal", () => {
		const lastTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
		const frequent = computeFrecencyScore({ count: 10, lastTs }, { now });
		const rare = computeFrecencyScore({ count: 1, lastTs }, { now });
		expect(frequent).toBeGreaterThan(rare);
	});

	it("decays to half its frequency weight after exactly one half-life", () => {
		const halfLifeDays = 7;
		const atHalfLife = computeFrecencyScore(
			{ count: 5, lastTs: new Date(now - halfLifeDays * 24 * 60 * 60 * 1000).toISOString() },
			{ now, halfLifeDays },
		);
		// count=5 saturates the frequency component at exactly 100, so after one
		// half-life the score should land at exactly 50.
		expect(atHalfLife).toBeCloseTo(50, 5);
	});

	it("caps the frequency component so an extreme count can't dominate forever", () => {
		const lastTs = new Date(now).toISOString();
		const saturated = computeFrecencyScore({ count: 5, lastTs }, { now });
		const overSaturated = computeFrecencyScore({ count: 500, lastTs }, { now });
		expect(saturated).toBe(100);
		expect(overSaturated).toBe(100);
	});
});

describe("rankResults()", () => {
	const now = Date.parse("2026-07-21T12:00:00.000Z");

	it("ranks a better text match above a worse one when neither has frecency history", () => {
		const results = [
			{ id: "a", title: "Open mini player", subtitle: "Atlas" },
			{ id: "b", title: "Open Settings", subtitle: "Atlas" },
		];
		const ranked = rankResults(results, { query: "settings", now });
		expect(ranked.map((r) => r.id)).toEqual(["b", "a"]);
	});

	// The WP's own hard acceptance criterion: frecency must DEMONSTRABLY
	// promote a repeatedly-and-recently-chosen result over an equal-match
	// result that has never been chosen.
	it("promotes a result chosen many times recently over an equal-match result never chosen", () => {
		// Both titles merely START WITH "open settings" (neither is an exact
		// match), so both score identically (80) on text match alone --
		// isolating frecency as the only thing that can tell them apart.
		const results = [
			{ id: "frequent", title: "Open Settings Panel", subtitle: "Atlas" },
			{ id: "never-chosen", title: "Open Settings Overview", subtitle: "Atlas" },
		];

		// Baseline: with no execution history at all, matchScore ties (80 vs
		// 80) and the deterministic alphabetical tiebreak decides -- "Overview"
		// sorts before "Panel", so the never-chosen result would win by
		// default. This is the control this test's real assertion is measured
		// against.
		const baseline = rankResults(results, { query: "open settings", now });
		expect(baseline[0].matchScore).toBe(baseline[1].matchScore);
		expect(baseline[0].id).toBe("never-chosen");

		// Now give "frequent" a real execution history -- 20 executions, most
		// recently yesterday -- and nothing for "never-chosen".
		const frecencyByResultId = new Map([
			["frequent", { count: 20, lastTs: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString() }],
		]);
		const ranked = rankResults(results, { query: "open settings", frecencyByResultId, now });

		// Frecency alone flips the order the tiebreak would otherwise produce.
		expect(ranked[0].id).toBe("frequent");
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
		expect(ranked[1].frecencyScore).toBe(0);
		expect(ranked[0].frecencyScore).toBeGreaterThan(0);
	});

	it("never lets frecency alone overturn a dramatically better text match", () => {
		const results = [
			// Exact match, never executed.
			{ id: "exact-match", title: "Settings", subtitle: null },
			// Barely matches (subtitle only), but executed constantly and recently.
			{ id: "heavily-used-poor-match", title: "Unrelated result", subtitle: "settings-adjacent" },
		];
		const frecencyByResultId = new Map([
			["heavily-used-poor-match", { count: 1000, lastTs: new Date(now).toISOString() }],
		]);

		const ranked = rankResults(results, { query: "settings", frecencyByResultId, now });

		expect(ranked[0].id).toBe("exact-match");
	});

	it("breaks exact ties alphabetically by title, for a fully deterministic order", () => {
		const results = [
			{ id: "1", title: "Zebra action" },
			{ id: "2", title: "Apple action" },
		];
		const ranked = rankResults(results, { query: "", now });
		expect(ranked.map((r) => r.title)).toEqual(["Apple action", "Zebra action"]);
	});

	it("does not mutate the input array or its result objects", () => {
		const results = [{ id: "a", title: "Settings", subtitle: null }];
		const frozenCopy = JSON.parse(JSON.stringify(results));
		rankResults(results, { query: "settings", now });
		expect(results).toEqual(frozenCopy);
	});

	it("accepts a plain object as well as a Map for frecencyByResultId", () => {
		const results = [
			{ id: "a", title: "Settings" },
			{ id: "b", title: "Settings redux" },
		];
		const ranked = rankResults(results, {
			query: "settings",
			frecencyByResultId: { a: { count: 10, lastTs: new Date(now).toISOString() } },
			now,
		});
		expect(ranked[0].id).toBe("a");
	});

	it("returns an empty array for empty/non-array input", () => {
		expect(rankResults([], { query: "x" })).toEqual([]);
		expect(rankResults(undefined, { query: "x" })).toEqual([]);
	});
});
