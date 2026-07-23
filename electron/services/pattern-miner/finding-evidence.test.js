import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import * as patternMinerStore from "./store.cjs";
import { acceptFinding, moveFinding } from "./finding-lifecycle-service.cjs";
import { resolveFindingEvidence } from "./finding-evidence.cjs";

// ---------------------------------------------------------------------------
// WP-3.6's "the user can see the evidence behind a finding -- which events
// produced it", against a REAL temp-file database (never %APPDATA%/Atlas or
// Atlas-Dev; see afterEach).
//
// The assertions worth having here are not "it returns rows" but the three
// genuinely different EMPTY cases, because getting those wrong is how a
// deliberate, promised purge ends up looking like a bug to the user (or, worse,
// how a bug ends up looking like a deliberate purge).
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-finding-evidence-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

function insertEvent(db, { id, ts, type, subject = null, environmentId = "env-a" }) {
	db.run(
		"INSERT INTO events (id, ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
		[id, ts, environmentId, type, subject],
	);
}

function insertEnvironment(db, id, isolationMode = "connected") {
	db.run("INSERT INTO environments (id, name, created_at, isolation_mode) VALUES (?, ?, ?, ?)", [
		id,
		id,
		new Date().toISOString(),
		isolationMode,
	]);
}

function seedFinding(db, overrides = {}) {
	const base = {
		environmentId: "env-a",
		patternType: "sequential_co_occurrence",
		trigger: { type: "app.focus", subject: "Editor" },
		follow: { type: "app.focus", subject: "Server" },
		windowMinutes: 30,
		occurrences: 12,
		trials: 15,
		confidence: 0.8,
		baselineProbability: 0.1,
		lift: 8,
		pValue: 0.0001,
		evidence: [
			{ triggerEventId: 1, followEventId: 2 },
			{ triggerEventId: 3, followEventId: 4 },
		],
		...overrides,
	};
	patternMinerStore.upsertFindings(db, [base]);
	return patternMinerStore.listFindingsForEnvironment(db, base.environmentId)[0];
}

function seedFourEvents(db) {
	insertEvent(db, { id: 1, ts: "2026-01-01T09:00:00.000Z", type: "app.focus", subject: "Editor" });
	insertEvent(db, { id: 2, ts: "2026-01-01T09:05:00.000Z", type: "app.focus", subject: "Server" });
	insertEvent(db, { id: 3, ts: "2026-01-02T09:00:00.000Z", type: "app.focus", subject: "Editor" });
	insertEvent(db, { id: 4, ts: "2026-01-02T09:05:00.000Z", type: "app.focus", subject: "Server" });
}

describe("resolveFindingEvidence", () => {
	it("resolves each stored pair back to the real events, in order", async () => {
		const db = await createDb();
		seedFourEvents(db);
		const finding = seedFinding(db);

		const result = resolveFindingEvidence(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.reason).toBeNull();
		expect(result.pairs).toHaveLength(2);
		expect(result.pairs[0].triggerEvent.subject).toBe("Editor");
		expect(result.pairs[0].triggerEvent.ts).toBe("2026-01-01T09:00:00.000Z");
		expect(result.pairs[0].followEvent.subject).toBe("Server");
		expect(result.pairs[1].triggerEvent.ts).toBe("2026-01-02T09:00:00.000Z");
	});

	it("keeps the pair when only one side has been pruned, rather than dropping both", async () => {
		const db = await createDb();
		seedFourEvents(db);
		const finding = seedFinding(db);
		// The event log's own retention pruning, simulated: the follow event of
		// the first pair ages out while its trigger survives.
		db.run("DELETE FROM events WHERE id = 2");

		const result = resolveFindingEvidence(db, finding.id);
		expect(result.pairs).toHaveLength(2);
		expect(result.pairs[0].triggerEvent.subject).toBe("Editor");
		expect(result.pairs[0].followEvent).toBeNull();
		expect(result.pairs[1].followEvent.subject).toBe("Server");
	});

	// -- The three distinct empty cases --------------------------------------

	it("reports an unknown finding as not_found, never as an empty evidence list", async () => {
		const db = await createDb();
		const result = resolveFindingEvidence(db, "no-such-finding");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_found");
		expect(result.pairs).toEqual([]);
	});

	it("reports an accepted finding's missing evidence as the deliberate purge it is", async () => {
		const db = await createDb();
		seedFourEvents(db);
		const finding = seedFinding(db);
		expect(resolveFindingEvidence(db, finding.id).pairs).toHaveLength(2);

		const accepted = acceptFinding(db, finding.id, { now: Date.now() });
		expect(accepted.ok).toBe(true);

		const result = resolveFindingEvidence(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("purged_on_accept");
		expect(result.pairs).toEqual([]);
	});

	it("reports a non-accepted finding with no evidence as no_evidence, a different thing entirely", async () => {
		const db = await createDb();
		const finding = seedFinding(db, { evidence: [] });

		const result = resolveFindingEvidence(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("no_evidence");
		expect(result.pairs).toEqual([]);
	});

	// -- The isolation consequence of a move ---------------------------------
	// This is the boundary WP-3.6's move operation has to hold: after a finding
	// crosses into another environment, its drill-down must not still be able
	// to read the events of the environment it came from.
	it("cannot drill down into the source environment's events after a move", async () => {
		const db = await createDb();
		insertEnvironment(db, "env-a");
		insertEnvironment(db, "env-b");
		seedFourEvents(db);
		const finding = seedFinding(db);
		expect(resolveFindingEvidence(db, finding.id).pairs).toHaveLength(2);

		const moved = moveFinding(db, finding.id, "env-b");
		expect(moved.ok).toBe(true);

		const result = resolveFindingEvidence(db, finding.id);
		expect(result.pairs).toEqual([]);
		expect(result.reason).toBe("no_evidence");
		// And the events themselves are untouched -- the boundary is enforced by
		// severing the finding's link to them, never by deleting the user's own
		// activity log.
		expect(db.first("SELECT COUNT(*) AS count FROM events").count).toBe(4);
	});

	it("never throws on a missing db or a missing id", async () => {
		const db = await createDb();
		expect(resolveFindingEvidence(null, "x").reason).toBe("not_found");
		expect(resolveFindingEvidence(db, null).reason).toBe("not_found");
		expect(resolveFindingEvidence(db, "").reason).toBe("not_found");
	});
});
