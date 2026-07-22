import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { mineBucketsBatch } from "./mine-worker.cjs";

// ---------------------------------------------------------------------------
// mineBucketsBatch() itself is exercised directly (fast, deterministic, no
// real worker thread) -- one integration test at the bottom spins an actual
// `Worker` against this exact file to prove the parentPort message wiring
// (accumulate-pages-per-bucket, "bucket-done" on isLast, "run-complete" ->
// "done") actually works end-to-end, mirroring crawl-worker.test.js's own
// "as a real worker thread" test for the file-index crawler.
// ---------------------------------------------------------------------------

function iso(ms) {
	return new Date(ms).toISOString();
}

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

function buildBucketEvents(days) {
	const events = [];
	let id = 1;
	for (let day = 0; day < days; day += 1) {
		const dayBase = BASE_MS + day * 24 * 60 * 60 * 1000;
		events.push({ id: id++, ts: iso(dayBase), type: "app.focus", subject: "Editor" });
		events.push({ id: id++, ts: iso(dayBase + 5 * 60 * 1000), type: "app.focus", subject: "Server" });
		for (let n = 0; n < 4; n += 1) {
			events.push({ id: id++, ts: iso(dayBase + (n + 1) * 60 * 60 * 1000), type: "noise", subject: `n${n}` });
		}
	}
	return events;
}

describe("mineBucketsBatch", () => {
	it("mines multiple independent buckets and tags each finding with its own environmentId", () => {
		const buckets = [
			{ environmentId: "env-a", events: buildBucketEvents(40) },
			{ environmentId: null, events: buildBucketEvents(40) },
		];
		const findings = mineBucketsBatch(buckets, {});
		expect(findings.length).toBe(2);
		expect(new Set(findings.map((f) => f.environmentId))).toEqual(new Set(["env-a", null]));
	});

	it("returns an empty array for an empty/malformed buckets input", () => {
		expect(mineBucketsBatch([], {})).toEqual([]);
		expect(mineBucketsBatch(null, {})).toEqual([]);
		expect(mineBucketsBatch([null, undefined, 42], {})).toEqual([]);
	});
});

describe("mine-worker.cjs as a real worker thread", () => {
	it("accumulates paged events per bucket and replies bucket-done, then done on run-complete", async () => {
		const workerPath = path.join(__dirname, "mine-worker.cjs");
		const worker = new Worker(workerPath);

		const events = buildBucketEvents(40);
		const pageSize = 30; // forces multiple "events" pages for this one bucket

		const messages = await new Promise((resolve, reject) => {
			const collected = [];
			const timeout = setTimeout(() => {
				worker.terminate();
				reject(new Error("mine worker did not finish in time"));
			}, 10_000);

			worker.on("message", (message) => {
				collected.push(message);
				if (message.type === "done" || message.type === "error") {
					clearTimeout(timeout);
					resolve(collected);
				}
			});
			worker.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});

			worker.postMessage({ type: "config", thresholds: {} });
			for (let offset = 0; offset < events.length; offset += pageSize) {
				const page = events.slice(offset, offset + pageSize);
				const isLast = offset + pageSize >= events.length;
				worker.postMessage({ type: "events", environmentId: "env-a", events: page, isLast });
			}
			worker.postMessage({ type: "run-complete" });
		});
		await worker.terminate();

		const bucketDone = messages.find((m) => m.type === "bucket-done");
		expect(bucketDone).toBeDefined();
		expect(bucketDone.environmentId).toBe("env-a");
		expect(bucketDone.findings.length).toBe(1);
		expect(bucketDone.findings[0].trigger).toEqual({ type: "app.focus", subject: "Editor" });
		expect(bucketDone.findings[0].follow).toEqual({ type: "app.focus", subject: "Server" });

		expect(messages.some((m) => m.type === "done")).toBe(true);
	});
});
