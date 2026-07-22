import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { createPatternMiner } from "./miner.cjs";
import { listAllFindings } from "./store.cjs";

// ---------------------------------------------------------------------------
// A real, measured check against this WP's own "90 days of events, under 10
// seconds, off the main thread" acceptance criterion -- run through the
// GENUINE production path: a real temp AtlasDatabase, a real
// `createPatternMiner()`, and a real `worker_threads` Worker (miner.cjs's
// default `createWorker`, not the fake EventEmitter miner.test.js otherwise
// uses) -- exactly the code path main.cjs wires up for `patternMiner:runNow`.
//
// This is not a strict CI gate: the ceiling below is deliberately generous
// (well under the 10s the plan actually asks for) so it catches a genuine
// gross regression without being flaky on whatever machine happens to run
// the suite. The ACTUAL measured numbers are always printed to console.log,
// unconditionally -- per this WP's own brief, a claimed-but-never-measured
// number is exactly the mistake being guarded against here.
//
// -- What "representative" means here ----------------------------------------
// A literal 90-day, single-user event log realistically holds a few thousand
// to a few tens of thousands of events (the event log's own
// DEFAULT_ROW_CAP is 500,000, shared across every environment and every
// event type ever recorded, not per environment). This corpus is deliberately
// heavier than a typical single user: 10 environments, 15,000 EVENTS EACH
// (150,000+ total, close to a third of the app's own all-time hard cap,
// packed into just 90 days) with 7 event types and 30 distinct subjects --
// generating far more candidate (type, subject) pairs for the miner to
// evaluate than a real installation would ever produce in that window. Each
// environment also gets ONE genuine planted pattern, so the run exercises
// the full pipeline (paged reads, worker mining, transactional writes) doing
// real, non-vacuous work, not an early return on a too-small/empty bucket.
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

const TYPES = [
	"app.focus",
	"task.create",
	"task.complete",
	"session.start",
	"session.stop",
	"file.changed",
	"environment.switch",
];
// Kept entirely separate from the planted pattern's own subjects below, so
// noise can never dilute (or accidentally inflate) that pattern's confidence.
const NOISE_SUBJECTS = Array.from({ length: 30 }, (_, i) => `App${i}`).concat([null, null, null]);

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const SPAN_DAYS = 90;
const NUM_ENVIRONMENTS = 10;
const EVENTS_PER_ENVIRONMENT = 15_000;

function buildEnvironmentCorpus(seed, environmentId) {
	const rand = mulberry32(seed);
	const spanMs = SPAN_DAYS * 24 * 60 * 60 * 1000;
	const rows = [];

	for (let i = 0; i < EVENTS_PER_ENVIRONMENT; i += 1) {
		const t = BASE_MS + Math.floor(rand() * spanMs);
		const type = TYPES[Math.floor(rand() * TYPES.length)];
		const subject = NOISE_SUBJECTS[Math.floor(rand() * NOISE_SUBJECTS.length)];
		rows.push({ ts: new Date(t).toISOString(), environmentId, type, subject });
	}

	for (let day = 0; day < SPAN_DAYS; day += 1) {
		const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
		rows.push({ ts: new Date(dayBase + 9 * 60 * 60000).toISOString(), environmentId, type: "app.focus", subject: "PlantedEditor" });
		rows.push({
			ts: new Date(dayBase + 9 * 60 * 60000 + 4 * 60000).toISOString(),
			environmentId,
			type: "app.focus",
			subject: "PlantedServer",
		});
	}

	return rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

const tmpDirs = [];

const createTempDbPath = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pattern-miner-perf-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
};

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("pattern miner performance at 90-day, multi-environment scale (real, measured)", () => {
	it(
		"mines a representative 90-day, ~150k-event, 10-environment corpus in comfortably under 10 seconds, off the main thread",
		async () => {
			const db = await AtlasDatabase.create(createTempDbPath());

			let totalEvents = 0;
			const insertStart = performance.now();
			for (let e = 0; e < NUM_ENVIRONMENTS; e += 1) {
				const rows = buildEnvironmentCorpus(1000 + e, `env-${e}`);
				db.transaction(() => {
					for (const row of rows) {
						db.run(
							"INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, NULL, NULL)",
							[row.ts, row.environmentId, row.type, row.subject],
						);
					}
				});
				totalEvents += rows.length;
			}
			const insertMs = performance.now() - insertStart;

			// The real production factory -- a genuine worker_threads Worker, not
			// the fake EventEmitter miner.test.js otherwise uses.
			const miner = createPatternMiner({ getDb: () => db, getEventLog: () => null });

			const runStart = performance.now();
			const result = await miner.runNow();
			const runMs = performance.now() - runStart;

			console.log(
				`[perf] pattern miner: inserted ${totalEvents} events across ${NUM_ENVIRONMENTS} environments in ${insertMs.toFixed(1)}ms (test setup, not part of the criterion)`,
			);
			console.log(
				`[perf] pattern miner: mining run (real worker thread, real DB) = ${runMs.toFixed(1)}ms for ${totalEvents} events over ${SPAN_DAYS} days`,
			);
			console.log(`[perf] pattern miner: result = ${JSON.stringify(result)}`);

			// Non-vacuous: proves the run actually did the full amount of work
			// this corpus represents, not an early return on an empty/too-small
			// bucket -- a 0-event or 0-finding "fast" run would make the timing
			// number above meaningless.
			expect(result.ok).toBe(true);
			expect(result.environmentsMined).toBe(NUM_ENVIRONMENTS);
			expect(result.eventsScanned).toBe(totalEvents);
			expect(result.findingsCreated).toBe(NUM_ENVIRONMENTS); // exactly the one planted pattern per environment
			expect(listAllFindings(db).length).toBe(NUM_ENVIRONMENTS);

			// Generous, non-flaky ceiling (see this file's header) -- well under
			// the plan's own 10-second criterion.
			const CEILING_MS = 8000;
			expect(runMs, `mining run took ${runMs.toFixed(1)}ms`).toBeLessThan(CEILING_MS);
		},
		60_000,
	);
});
