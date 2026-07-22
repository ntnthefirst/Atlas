"use strict";

// ---------------------------------------------------------------------------
// The pattern miner's worker-thread half (WP-3.3) -- runs inside a
// worker_threads Worker, never on the main thread. Mirrors the exact split
// electron/services/file-index/crawler.cjs + crawl-worker.cjs already use,
// for the same reason stated there: node-sqlite3-wasm has exactly ONE
// database connection, owned by the main process, and a worker thread can
// NEVER open or touch it. This file NEVER requires node-sqlite3-wasm,
// electron/db.cjs, or anything that opens a database connection.
//
// -- What crosses the thread boundary, and why -------------------------------
// electron/services/pattern-miner/miner.cjs (the main-thread half) queries
// `events` with an indexed, environment-scoped query (idx_events_environment_ts,
// see migration 003 and 012's own headers) and ships PLAIN, already-stripped
// records over -- `{ id, ts, type, subject }` only (no `payload`, no
// `sessionId`, no `environmentId` on the record itself, since a whole
// message is already scoped to one environment bucket -- see "one bucket per
// message" below). This is both less data to structured-clone across the
// thread boundary and, per this project's own privacy discipline (see
// event-log.cjs's header), no reason to hand a worker thread anything this
// computation doesn't need.
//
// -- One bucket per message, chunked, not one giant message ------------------
// A single environment's events over 90 days can be large enough that
// shipping them in ONE structured-clone message is wasteful (a big message
// blocks the event loop briefly on both ends while it's cloned, and holds two
// full copies in memory -- main's query result AND the worker's copy -- at
// once). Instead, miner.cjs pages each bucket's events (event-log.cjs's own
// cursor-based `listEventsForMining`, a few thousand rows per page) and posts
// one `{ type: "events", environmentId, events, isLast }` message per page;
// this file accumulates pages for that `environmentId` in a Map until a page
// arrives with `isLast: true`, mines THAT bucket's full accumulated event
// list the moment it is complete, replies with that bucket's findings, and
// then immediately drops its buffer for that environmentId -- so at most one
// bucket's full event list is ever held in memory here at a time, regardless
// of how many environments a run covers.
//
// -- Isolation is structural, not a message-protocol promise -----------------
// Mining itself is delegated entirely to algorithm.cjs's mineSequentialPatterns
// (called once per completed bucket, with ONLY that bucket's own events) --
// this file never merges two environmentId's accumulated events together, and
// algorithm.cjs's own mineSequentialPatterns has no parameter through which it
// could even see another bucket's data. See algorithm.cjs's header for the
// full isolation argument.
// ---------------------------------------------------------------------------

const { parentPort, isMainThread } = require("node:worker_threads");
const { mineSequentialPatterns } = require("./algorithm.cjs");

// Runs the miner against however many buckets are handed to it in one call
// -- an array of `{ environmentId, events }`, one entry per environment
// (including the `null`/"no environment" bucket) -- and returns
// `Array<finding & { environmentId }>`. Exposed as a plain function (not only
// reachable through postMessage) so a test can call this directly with a
// literal buckets array, with no real Worker involved at all -- mirrors
// crawl-worker.cjs's own `runCrawl` being callable outside a real thread.
function mineBucketsBatch(buckets, thresholds) {
	const results = [];
	for (const bucket of Array.isArray(buckets) ? buckets : []) {
		if (!bucket || typeof bucket !== "object") {
			continue;
		}
		const environmentId = bucket.environmentId ?? null;
		const findings = mineSequentialPatterns(bucket.events, thresholds);
		for (const finding of findings) {
			results.push({ ...finding, environmentId });
		}
	}
	return results;
}

// -- Real worker-thread entry point ------------------------------------------
// Only runs when this file is loaded as an actual `new Worker(__filename)`
// (see miner.cjs) -- requiring this file from anywhere else (its own unit
// tests, or miner.cjs importing `mineBucketsBatch` for a fake-worker test)
// leaves `isMainThread` true and `parentPort` null, so none of this block
// ever executes there.
if (!isMainThread && parentPort) {
	// environmentId (the JS value `null` included) -> accumulated events across
	// however many "events" pages have arrived so far for that bucket.
	const pending = new Map();
	let thresholds = {};

	function bucketKeyFor(environmentId) {
		// Map keys compare by SameValueZero, so the JS value `null` is already
		// a perfectly fine, distinct key from any string environment id -- no
		// string-coercion sentinel needed.
		return environmentId;
	}

	parentPort.on("message", (message) => {
		if (!message || typeof message !== "object") {
			return;
		}

		if (message.type === "config") {
			thresholds = message.thresholds || {};
			return;
		}

		if (message.type === "events") {
			const key = bucketKeyFor(message.environmentId ?? null);
			const existing = pending.get(key) ?? [];
			existing.push(...(Array.isArray(message.events) ? message.events : []));
			pending.set(key, existing);

			if (message.isLast) {
				const events = pending.get(key) ?? [];
				pending.delete(key); // free this bucket's memory immediately -- see header
				let findings = [];
				try {
					findings = mineSequentialPatterns(events, thresholds);
				} catch (error) {
					parentPort.postMessage({
						type: "error",
						environmentId: message.environmentId ?? null,
						message: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				parentPort.postMessage({
					type: "bucket-done",
					environmentId: message.environmentId ?? null,
					findings,
				});
			}
			return;
		}

		if (message.type === "run-complete") {
			// Any bucket that never got an isLast page (a protocol error on the
			// main-thread side) is simply dropped, never mined partially -- a
			// half-received bucket producing "findings" from incomplete data
			// would be worse than producing none.
			pending.clear();
			parentPort.postMessage({ type: "done" });
		}
	});
}

module.exports = { mineBucketsBatch, mineSequentialPatterns };
