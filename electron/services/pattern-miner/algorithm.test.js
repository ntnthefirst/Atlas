import { describe, expect, it } from "vitest";
import {
	binomialSurvival,
	logChoose,
	keyOf,
	parseKey,
	mineSequentialPatterns,
	mineBuckets,
	normalizeThresholds,
} from "./algorithm.cjs";

// ---------------------------------------------------------------------------
// The pure mining algorithm (WP-3.3). Every fixture here is a plain literal
// event array -- no worker, no database, no Electron runtime. Two families of
// test are the load-bearing ones for this WP's acceptance criteria and are
// written to genuinely OPPOSE each other (see the file's own comments at each
// one): a seeded, planted pattern must be found; a battery of random event
// streams, at several densities and type counts, must produce EXACTLY ZERO
// findings. A miner that never finds anything would trivially pass the
// second family alone -- both are required together.
//
// A deterministic PRNG (mulberry32) is used everywhere randomness is needed,
// never Math.random(), so every test run is bit-for-bit repeatable.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
	let a = seed;
	return function random() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

function iso(ms) {
	return new Date(ms).toISOString();
}

let nextId = 1;
function resetIds() {
	nextId = 1;
}
function ev(ms, type, subject = null) {
	return { id: nextId++, ts: iso(ms), type, subject };
}

// -- Deterministic PRNG-based event stream builders -------------------------

// Plants a genuine "B follows A within window" pattern, `days` times, mixed
// with unrelated noise events -- what a real detectable workflow looks like.
function buildSeededPattern({ days = 40, followDelayMs = 5 * 60 * 1000, noisePerDay = 4, seed = 1 } = {}) {
	resetIds();
	const rand = mulberry32(seed);
	const events = [];
	for (let day = 0; day < days; day += 1) {
		const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
		const aTime = dayBase + Math.floor(rand() * 6 * 60 * 60 * 1000);
		events.push(ev(aTime, "app.focus", "Editor"));
		events.push(ev(aTime + followDelayMs, "app.focus", "Server"));
		for (let n = 0; n < noisePerDay; n += 1) {
			const noiseTime = dayBase + Math.floor(rand() * 24 * 60 * 60 * 1000);
			events.push(ev(noiseTime, "noise", `n${n % 3}`));
		}
	}
	return events.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

function buildRandomStream({ seed, numTypes, numEvents, spanDays, numSubjects = 0 }) {
	resetIds();
	const rand = mulberry32(seed);
	const spanMs = spanDays * 24 * 60 * 60 * 1000;
	const events = [];
	for (let i = 0; i < numEvents; i += 1) {
		const t = BASE_MS + Math.floor(rand() * spanMs);
		const type = `type${Math.floor(rand() * numTypes)}`;
		const subject = numSubjects > 0 && rand() < 0.5 ? `subj${Math.floor(rand() * numSubjects)}` : null;
		events.push({ id: i + 1, ts: iso(t), type, subject });
	}
	return events;
}

describe("logChoose / binomialSurvival", () => {
	it("logChoose is symmetric: C(n, k) == C(n, n-k)", () => {
		expect(logChoose(20, 6)).toBeCloseTo(logChoose(20, 14), 8);
		expect(logChoose(100, 0)).toBeCloseTo(0, 8);
		expect(logChoose(100, 100)).toBeCloseTo(0, 8);
	});

	it("binomialSurvival(n, 0, p) is always 1 -- P(X >= 0) is certain", () => {
		expect(binomialSurvival(50, 0, 0.3)).toBe(1);
	});

	it("binomialSurvival(n, k, p) is 0 once k exceeds n", () => {
		expect(binomialSurvival(10, 11, 0.5)).toBe(0);
	});

	it("matches a hand-checkable small case: P(X >= 1) for Binomial(1, 0.25) is exactly 0.25", () => {
		expect(binomialSurvival(1, 1, 0.25)).toBeCloseTo(0.25, 10);
	});

	it("is monotonically non-increasing in k for a fixed n, p", () => {
		const values = [0, 5, 10, 20, 40, 60].map((k) => binomialSurvival(100, k, 0.3));
		for (let i = 1; i < values.length; i += 1) {
			expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
		}
	});

	it("agrees closely between the exact path and the large-n normal-approximation path", () => {
		// n = 2000 is the exact/approximation boundary (EXACT_BINOMIAL_MAX_N) --
		// compare a case just under it against just over it with the same
		// n*p, n*k ratios; they should be close, not just both "small".
		const exact = binomialSurvival(2000, 700, 0.3);
		const approx = binomialSurvival(2400, 840, 0.3); // same k/n and p
		expect(Math.abs(exact - approx)).toBeLessThan(0.01);
	});
});

describe("keyOf / parseKey", () => {
	it("round-trips type + subject", () => {
		const key = keyOf("app.focus", "VSCode");
		expect(parseKey(key)).toEqual({ type: "app.focus", subject: "VSCode" });
	});

	it("round-trips a null/missing subject", () => {
		const key = keyOf("session.start", null);
		expect(parseKey(key)).toEqual({ type: "session.start", subject: null });
	});

	it("never collides two different (type, subject) pairs", () => {
		const a = keyOf("app.focus", "");
		const b = keyOf("app.focus", null);
		expect(a).toBe(b); // "" and null both mean "no subject" -- same key, deliberately
		const c = keyOf("app", ".focus:VSCode");
		const d = keyOf("app.focus", "VSCode");
		expect(c).not.toBe(d);
	});
});

describe("normalizeThresholds", () => {
	it("falls back to defaults for missing/malformed input", () => {
		const t = normalizeThresholds(undefined);
		expect(t.windowMinutes).toBeGreaterThan(0);
		expect(t.minOccurrences).toBeGreaterThanOrEqual(2);
		expect(t.minConfidence).toBeGreaterThan(0);
		expect(t.minLift).toBeGreaterThanOrEqual(1);
	});
});

describe("mineSequentialPatterns -- the seeded-pattern criterion", () => {
	it("detects a clearly planted, repeated sequential pattern", () => {
		const events = buildSeededPattern({ days: 40 });
		const findings = mineSequentialPatterns(events, {});

		expect(findings.length).toBe(1); // exactly the planted pair -- not the noise, not its own reverse
		const [finding] = findings;
		expect(finding.trigger).toEqual({ type: "app.focus", subject: "Editor" });
		expect(finding.follow).toEqual({ type: "app.focus", subject: "Server" });
		expect(finding.occurrences).toBeGreaterThanOrEqual(35); // real, non-vacuous count (not 0, not 1)
		expect(finding.confidence).toBeGreaterThan(0.9);
		expect(finding.lift).toBeGreaterThan(2);
		expect(finding.pValue).toBeLessThan(0.001);
		expect(finding.evidence.length).toBe(finding.occurrences);
	});

	it("never reports the reverse direction as its own separate (weaker) finding", () => {
		const events = buildSeededPattern({ days: 40 });
		const findings = mineSequentialPatterns(events, {});
		const reversed = findings.find((f) => f.trigger.subject === "Server" && f.follow.subject === "Editor");
		expect(reversed).toBeUndefined();
	});

	it("evidence event ids are real ids drawn from the input, correctly ordered (trigger before follow)", () => {
		const events = buildSeededPattern({ days: 40 });
		const byId = new Map(events.map((e) => [e.id, e]));
		const [finding] = mineSequentialPatterns(events, {});
		expect(finding.evidence.length).toBeGreaterThan(0);
		for (const { triggerEventId, followEventId } of finding.evidence) {
			const trigger = byId.get(triggerEventId);
			const follow = byId.get(followEventId);
			expect(trigger).toBeDefined();
			expect(follow).toBeDefined();
			expect(Date.parse(follow.ts)).toBeGreaterThan(Date.parse(trigger.ts));
		}
	});

	// The fixture that actively OPPOSES the seeded-pattern test above: the same
	// shape of data, deliberately weakened below each gate in turn, must
	// produce NOTHING. A miner that always finds something would pass the test
	// above but fail every one of these.
	//
	// This one is deliberately built so it is NOT also caught by the simpler
	// "Editor/Server barely occur at all" shape: Editor occurs 6 times and
	// Server occurs 5 times overall (both comfortably clearing the candidate
	// pre-filter's own `count >= minOccurrences` check on EACH side), and
	// confidence (4/5 = 0.8) and lift/p-value all clear their own gates too --
	// only the raw occurrence count (k=4, one short of the default K=5) is
	// what must reject this pair. An earlier version of this test used a
	// too-sparse fixture where Editor/Server's OWN total counts were already
	// below minOccurrences, which the candidate pre-filter (a separate, EARLIER
	// check) rejects on its own -- that version kept passing even with the
	// trial-level `k < minOccurrences` gate deleted entirely, i.e. it was
	// vacuous. Confirmed by deliberately deleting that gate: only THIS
	// fixture's shape actually caught it.
	it("finds nothing when B follows A one time short of minOccurrences, even though confidence/lift/p-value all clear", () => {
		resetIds();
		const events = [];
		const editorDays = [0, 10, 20, 30, 40, 50];
		const followedDays = new Set([0, 10, 20, 30]); // 4 of 6 -- confidence 4/5 = 0.8 once censoring drops the trailing trial
		for (const day of editorDays) {
			const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
			events.push(ev(dayBase, "app.focus", "Editor"));
			if (followedDays.has(day)) {
				events.push(ev(dayBase + 5 * 60000, "app.focus", "Server"));
			}
		}
		// One more standalone Server, far from any Editor, so Server's own total
		// count (5) clears the candidate pre-filter without adding a 5th real
		// "follow".
		events.push(ev(BASE_MS + 5 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000, "app.focus", "Server"));
		// Padding noise -- distinct singleton subjects, so none of them can
		// themselves become a candidate (each occurs only once).
		for (let i = 0; i < 25; i += 1) {
			events.push(ev(BASE_MS + i * 2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000, "noise", `n${i}`));
		}

		const findings = mineSequentialPatterns(events.sort((a, b) => (a.ts < b.ts ? -1 : 1)), {});
		expect(findings.find((f) => f.trigger.subject === "Editor" && f.follow.subject === "Server")).toBeUndefined();
	});

	it("finds nothing when B follows A too rarely to clear minConfidence", () => {
		resetIds();
		const rand = mulberry32(99);
		const events = [];
		for (let day = 0; day < 60; day += 1) {
			const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
			events.push(ev(dayBase, "app.focus", "Editor"));
			// B follows only 1 day in 5 -- confidence ~0.2, well under the default 0.6.
			if (day % 5 === 0) {
				events.push(ev(dayBase + 5 * 60 * 1000, "app.focus", "Server"));
			}
			for (let n = 0; n < 4; n += 1) {
				events.push(ev(dayBase + Math.floor(rand() * 24 * 60 * 60 * 1000), "noise", `n${n}`));
			}
		}
		const findings = mineSequentialPatterns(events, {});
		expect(findings.find((f) => f.trigger.subject === "Editor" && f.follow.subject === "Server")).toBeUndefined();
	});

	it("finds nothing when B falls outside the configured window", () => {
		const events = buildSeededPattern({ days: 40, followDelayMs: 45 * 60 * 1000 }); // 45min > default 30min window
		const findings = mineSequentialPatterns(events, {});
		expect(findings.find((f) => f.trigger.subject === "Editor" && f.follow.subject === "Server")).toBeUndefined();
	});

	// Deliberately dense enough that IF self-pairs were allowed, this would
	// clear every other gate easily (confirmed below by disabling the
	// keyA===keyB guard directly: it then reports occurrences=120, confidence
	// 0.8, lift ~8 -- a clean pass). A second, unrelated frequent key
	// ("noise"/"other") is included too, since with only ONE distinct
	// candidate key `mineSequentialPatterns` bails out at its own
	// "fewer than 2 candidates" guard before ever reaching the self-pair
	// check at all -- an earlier version of this test had only one key and
	// stayed "passing" with the self-pair guard entirely deleted, i.e. it
	// was vacuous for two independent reasons at once.
	it("excludes self-pairs even when a type/subject trivially 'follows' itself, densely, many times", () => {
		resetIds();
		const events = [];
		for (let day = 0; day < 30; day += 1) {
			const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
			for (let burst = 0; burst < 5; burst += 1) {
				events.push(ev(dayBase + burst * 60_000, "task.create", "same"));
			}
			events.push(ev(dayBase + 12 * 60 * 60 * 1000, "noise", "other"));
		}
		const findings = mineSequentialPatterns(events, {});
		expect(findings.find((f) => f.trigger.type === "task.create" && f.follow.type === "task.create")).toBeUndefined();
	});
});

describe("mineSequentialPatterns -- the null-model / lift guard", () => {
	// The exact scenario the WP's brief warns about: A and B are BOTH simply
	// frequent (independent Poisson-ish processes), so a naive
	// support+confidence-only miner finds "B follows A" constantly. This
	// fixture is built so naive confidence is verifiably high (asserted
	// below) -- proving this is a genuine trap, not an accidentally-weak one
	// -- and then asserts the real miner still returns nothing.
	it("rejects a pair with high naive confidence but no real lift over chance", () => {
		resetIds();
		const rand = mulberry32(7);
		const spanDays = 90;
		const events = [];
		for (let t = 0; t < spanDays * 24 * 60; t += 12) {
			if (rand() < 0.9) {
				events.push({
					id: nextId++,
					ts: iso(BASE_MS + (t + rand() * 5) * 60000),
					type: "app.focus",
					subject: "A",
				});
			}
		}
		for (let t = 0; t < spanDays * 24 * 60; t += 15) {
			if (rand() < 0.9) {
				events.push({
					id: nextId++,
					ts: iso(BASE_MS + (t + rand() * 5) * 60000),
					type: "app.focus",
					subject: "B",
				});
			}
		}
		events.sort((a, b) => (a.ts < b.ts ? -1 : 1));

		// Prove this is a genuine trap: naive confidence (ignoring lift/p-value
		// entirely) is well above the default minConfidence threshold.
		const aTimes = events.filter((e) => e.subject === "A").map((e) => Date.parse(e.ts));
		const bTimes = events.filter((e) => e.subject === "B").map((e) => Date.parse(e.ts));
		let hits = 0;
		for (const a of aTimes) {
			if (bTimes.some((b) => b > a && b <= a + 30 * 60000)) {
				hits += 1;
			}
		}
		const naiveConfidence = hits / aTimes.length;
		expect(naiveConfidence).toBeGreaterThan(0.9); // the trap is real

		const findings = mineSequentialPatterns(events, {});
		expect(findings).toEqual([]); // the real miner is not fooled by it
	});
});

describe("mineSequentialPatterns -- censoring at the observed data's end", () => {
	it("does not penalize confidence for an A occurrence too close to the end of the data to evaluate", () => {
		resetIds();
		const events = [];
		// 20 clean repeats, comfortably clearing every threshold.
		for (let day = 0; day < 20; day += 1) {
			const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
			events.push(ev(dayBase, "app.focus", "Editor"));
			events.push(ev(dayBase + 5 * 60 * 1000, "app.focus", "Server"));
			for (let n = 0; n < 4; n += 1) {
				events.push(ev(dayBase + (n + 1) * 60 * 60 * 1000, "noise", `n${n}`));
			}
		}
		// One final A occurrence right at the very end of the observed data,
		// with NO time left for B to plausibly follow -- must be excluded from
		// trials entirely (censored), not counted as a damaging "miss".
		const lastMs = Date.parse(events[events.length - 1].ts);
		events.push(ev(lastMs + 60_000, "app.focus", "Editor"));

		const findings = mineSequentialPatterns(events, {});
		const finding = findings.find((f) => f.trigger.subject === "Editor" && f.follow.subject === "Server");
		expect(finding).toBeDefined();
		expect(finding.trials).toBe(20); // the trailing, censored A occurrence is NOT counted
		expect(finding.occurrences).toBe(20);
		expect(finding.confidence).toBe(1);
	});
});

describe("mineSequentialPatterns -- zero findings from random event data", () => {
	// The direct opposite of the seeded-pattern tests above: purely random
	// event streams, at several densities and type/subject counts, all
	// generated with a fixed, deterministic seed (never Math.random(), so this
	// can never flake). EVERY one of these must produce exactly zero findings.
	const configs = [
		{ numTypes: 3, numEvents: 500, spanDays: 7, numSubjects: 0 },
		{ numTypes: 5, numEvents: 2000, spanDays: 30, numSubjects: 3 },
		{ numTypes: 8, numEvents: 5000, spanDays: 90, numSubjects: 5 },
		{ numTypes: 15, numEvents: 8000, spanDays: 90, numSubjects: 8 },
		{ numTypes: 20, numEvents: 3000, spanDays: 14, numSubjects: 10 },
		{ numTypes: 4, numEvents: 12000, spanDays: 90, numSubjects: 0 },
	];

	for (const config of configs) {
		it(`produces zero findings for ${JSON.stringify(config)}, across 10 seeds`, () => {
			let total = 0;
			for (let seed = 1; seed <= 10; seed += 1) {
				const events = buildRandomStream({ seed, ...config });
				const findings = mineSequentialPatterns(events, {});
				total += findings.length;
			}
			expect(total).toBe(0);
		});
	}
});

describe("mineBuckets -- environment isolation", () => {
	// Plants a pattern that ONLY exists when two environments' events are
	// merged together (A in environment 1, B in environment 2, interleaved in
	// time) -- proving the merged case genuinely WOULD be detected (so the
	// isolated-case zero result below is not just "the algorithm can't find
	// this shape"), then proves mineBuckets, fed the SAME events as two
	// separate buckets, finds nothing for that cross-environment pair.
	function buildCrossEnvironmentEvents() {
		resetIds();
		const env1 = [];
		const env2 = [];
		for (let day = 0; day < 40; day += 1) {
			const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
			env1.push(ev(dayBase + 60 * 60000, "app.focus", "X"));
			env2.push(ev(dayBase + 65 * 60000, "app.focus", "Y"));
			for (let n = 0; n < 4; n += 1) {
				env1.push(ev(dayBase + (n + 2) * 60 * 60000, "noise1", `n${n}`));
				env2.push(ev(dayBase + (n + 2) * 60 * 60000, "noise2", `n${n}`));
			}
		}
		return { env1, env2 };
	}

	it("DOES find the pattern if two environments' events are (incorrectly) merged into one bucket", () => {
		const { env1, env2 } = buildCrossEnvironmentEvents();
		const merged = [...env1, ...env2].sort((a, b) => (a.ts < b.ts ? -1 : 1));
		const findings = mineSequentialPatterns(merged, {});
		expect(findings.find((f) => f.trigger.subject === "X" && f.follow.subject === "Y")).toBeDefined();
	});

	it("finds NOTHING for that cross-environment pair when mined as two isolated buckets", () => {
		const { env1, env2 } = buildCrossEnvironmentEvents();
		const findings = mineBuckets(
			[
				{ environmentId: "env-1", events: env1 },
				{ environmentId: "env-2", events: env2 },
			],
			{},
		);
		expect(findings.find((f) => f.trigger.subject === "X" || f.follow.subject === "Y")).toBeUndefined();
	});

	it("still finds each environment's OWN internal pattern, correctly tagged, alongside the isolation above", () => {
		resetIds();
		const env1 = buildSeededPattern({ days: 40, seed: 11 });
		const env2 = buildSeededPattern({ days: 40, seed: 12 });
		const findings = mineBuckets(
			[
				{ environmentId: "env-1", events: env1 },
				{ environmentId: "env-2", events: env2 },
			],
			{},
		);
		expect(findings.length).toBe(2);
		expect(findings.every((f) => f.trigger.subject === "Editor" && f.follow.subject === "Server")).toBe(true);
		expect(new Set(findings.map((f) => f.environmentId))).toEqual(new Set(["env-1", "env-2"]));
	});
});
