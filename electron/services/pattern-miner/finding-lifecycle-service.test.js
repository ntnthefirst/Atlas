import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import * as patternMinerStore from "./store.cjs";
import * as smartFunctionsStore from "../smart-functions/store.cjs";
import {
	markSuggested,
	acceptFinding,
	ignoreFinding,
	resurfaceDueFindings,
	sweepExpiredFindings,
	migratedFromKeyFor,
} from "./finding-lifecycle-service.cjs";

// ---------------------------------------------------------------------------
// The finding lifecycle's stateful half (WP-3.4), driven against a REAL
// temp-file database -- never %APPDATA%/Atlas or Atlas-Dev, see afterEach.
// This is also where the purge's own promise gets its database-level proof:
// "removes findings_evidence rows WITHOUT touching the events rows they
// referenced" (see the "acceptFinding -- the purge" describe block below).
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-finding-lifecycle-test-"));
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

// Inserts a real `events` row (migration 003) -- used so the purge test can
// prove those rows survive, not just that findings_evidence shrinks.
function insertEvent(db, { id, ts, type, subject = null, environmentId = null }) {
	db.run("INSERT INTO events (id, ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)", [
		id,
		ts,
		environmentId,
		type,
		subject,
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

describe("markSuggested", () => {
	it("promotes a 'new' finding to 'suggested', stamping suggestedAt", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		expect(finding.status).toBe("new");

		const result = markSuggested(db, finding.id, { now: Date.parse("2026-01-01T00:00:00Z") });
		expect(result.ok).toBe(true);
		expect(result.finding.status).toBe("suggested");
		expect(result.finding.suggestedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("rejects an unknown finding id", async () => {
		const db = await createDb();
		const result = markSuggested(db, "not-a-real-id");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_found");
	});

	it("is a legal no-op (still ok) when already suggested", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		markSuggested(db, finding.id);
		const again = markSuggested(db, finding.id);
		expect(again.ok).toBe(true);
		expect(again.finding.status).toBe("suggested");
	});
});

describe("acceptFinding -- produces a real, editable smart function", () => {
	it("creates a rule through smart-functions' own store, scoped to the finding's environment", async () => {
		const db = await createDb();
		const finding = seedFinding(db, { environmentId: "env-a" });
		markSuggested(db, finding.id);

		const result = acceptFinding(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.rule).toBeTruthy();
		expect(result.rule.environmentId).toBe("env-a");
		expect(result.rule.trigger).toEqual({ type: "app.launched", processName: "Editor" });
		expect(result.rule.actions).toEqual([{ type: "launchApp", command: "Server" }]);
		expect(result.rule.enabled).toBe(true);
		expect(result.rule.source).toBe("user");

		// It must be a REAL row in smart_functions, findable through the exact
		// same store WP-3.2's editor will use -- not a parallel representation.
		const persisted = smartFunctionsStore.getRule(db, result.rule.id);
		expect(persisted).toEqual(result.rule);

		// Editable exactly like a hand-made rule.
		const edited = smartFunctionsStore.updateRule(db, result.rule.id, { label: "My renamed automation" });
		expect(edited.label).toBe("My renamed automation");
	});

	it("auto-promotes a 'new' finding through 'suggested' on the way to accepted (no separate markSuggested call required)", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		expect(finding.status).toBe("new");

		const result = acceptFinding(db, finding.id);
		expect(result.ok).toBe(true);
		const updated = patternMinerStore.getFinding(db, finding.id);
		expect(updated.status).toBe("accepted");
		expect(updated.suggestedAt).not.toBeNull();
		expect(updated.acceptedRuleId).toBe(result.rule.id);
		expect(updated.decidedAt).not.toBeNull();
	});

	it("respects environment scoping -- the rule never leaks into a different environment's listing", async () => {
		const db = await createDb();
		const finding = seedFinding(db, { environmentId: "env-a" });
		const result = acceptFinding(db, finding.id);

		const rulesForA = smartFunctionsStore.listRulesForEnvironment(db, "env-a");
		const rulesForB = smartFunctionsStore.listRulesForEnvironment(db, "env-b");
		expect(rulesForA.map((r) => r.id)).toContain(result.rule.id);
		expect(rulesForB.map((r) => r.id)).not.toContain(result.rule.id);
	});

	it("fails cleanly (unsupported_pattern) for a finding whose event types have no rule translation, without touching the finding's status or creating any rule", async () => {
		const db = await createDb();
		const finding = seedFinding(db, {
			trigger: { type: "task.create", subject: "task-1" },
			follow: { type: "note.create", subject: "note-1" },
		});
		markSuggested(db, finding.id);

		const before = smartFunctionsStore.listAllRules(db).length;
		const result = acceptFinding(db, finding.id);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("unsupported_pattern");
		expect(smartFunctionsStore.listAllRules(db).length).toBe(before);

		const stillSuggested = patternMinerStore.getFinding(db, finding.id);
		expect(stillSuggested.status).toBe("suggested");
	});

	it("rejects an unknown finding id", async () => {
		const db = await createDb();
		const result = acceptFinding(db, "not-a-real-id");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_found");
	});
});

describe("acceptFinding -- idempotency (must never create two rules)", () => {
	it("a second accept on an already-accepted finding is rejected, and only one rule ever exists", async () => {
		const db = await createDb();
		const finding = seedFinding(db);

		const first = acceptFinding(db, finding.id);
		expect(first.ok).toBe(true);

		const second = acceptFinding(db, finding.id);
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("invalid_transition");

		const rulesWithThisMigratedFrom = smartFunctionsStore.listAllRules(db).filter(
			(rule) => rule.migratedFrom === migratedFromKeyFor(finding.id),
		);
		expect(rulesWithThisMigratedFrom.length).toBe(1);
	});

	it("defense-in-depth: if a rule with this finding's migratedFrom key already exists (e.g. a prior crash left the finding un-marked), acceptFinding reuses it rather than inserting a duplicate", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		markSuggested(db, finding.id);

		const preExisting = smartFunctionsStore.createRule(db, {
			label: "Pre-existing rule",
			environmentId: finding.environmentId,
			trigger: { type: "app.launched", processName: "Editor" },
			actions: [{ type: "launchApp", command: "Server" }],
			migratedFrom: migratedFromKeyFor(finding.id),
		});

		const result = acceptFinding(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.rule.id).toBe(preExisting.id);
		expect(result.alreadyExisted).toBe(true);

		const rulesWithThisMigratedFrom = smartFunctionsStore.listAllRules(db).filter(
			(rule) => rule.migratedFrom === migratedFromKeyFor(finding.id),
		);
		expect(rulesWithThisMigratedFrom.length).toBe(1);

		const updatedFinding = patternMinerStore.getFinding(db, finding.id);
		expect(updatedFinding.status).toBe("accepted");
	});
});

describe("acceptFinding -- the purge", () => {
	it("removes this finding's evidence rows but leaves the events rows they referenced completely untouched", async () => {
		const db = await createDb();
		insertEvent(db, { id: 1, ts: "2026-01-01T00:00:00Z", type: "app.focus", subject: "Editor", environmentId: "env-a" });
		insertEvent(db, { id: 2, ts: "2026-01-01T00:01:00Z", type: "app.focus", subject: "Server", environmentId: "env-a" });
		insertEvent(db, { id: 3, ts: "2026-01-02T00:00:00Z", type: "app.focus", subject: "Editor", environmentId: "env-a" });
		insertEvent(db, { id: 4, ts: "2026-01-02T00:01:00Z", type: "app.focus", subject: "Server", environmentId: "env-a" });
		// An UNRELATED event, to prove the purge doesn't touch the events table
		// at large either.
		insertEvent(db, { id: 5, ts: "2026-01-03T00:00:00Z", type: "task.create", subject: "task-9", environmentId: "env-a" });

		const finding = seedFinding(db, {
			evidence: [
				{ triggerEventId: 1, followEventId: 2 },
				{ triggerEventId: 3, followEventId: 4 },
			],
		});
		expect(patternMinerStore.getFindingEvidence(db, finding.id).length).toBe(2);
		const eventCountBefore = db.first("SELECT COUNT(*) AS count FROM events").count;
		expect(eventCountBefore).toBe(5);

		const result = acceptFinding(db, finding.id);
		expect(result.ok).toBe(true);
		expect(result.purgedEvidenceCount).toBe(2);

		// The purge, verified in the database: evidence is gone...
		expect(patternMinerStore.getFindingEvidence(db, finding.id)).toEqual([]);
		const evidenceRowCount = db.first("SELECT COUNT(*) AS count FROM findings_evidence").count;
		expect(evidenceRowCount).toBe(0);

		// ...but every event row it referenced -- and every other event row --
		// is still there, byte-for-byte, exactly as inserted.
		const eventCountAfter = db.first("SELECT COUNT(*) AS count FROM events").count;
		expect(eventCountAfter).toBe(5);
		for (const id of [1, 2, 3, 4, 5]) {
			const row = db.first("SELECT * FROM events WHERE id = ?", [id]);
			expect(row).not.toBeNull();
		}
		const editorEvent = db.first("SELECT * FROM events WHERE id = 1");
		expect(editorEvent.type).toBe("app.focus");
		expect(editorEvent.subject).toBe("Editor");

		// The finding itself survives the purge with its summary stats intact.
		const survivingFinding = patternMinerStore.getFinding(db, finding.id);
		expect(survivingFinding).not.toBeNull();
		expect(survivingFinding.status).toBe("accepted");
		expect(survivingFinding.occurrences).toBe(finding.occurrences);
		expect(survivingFinding.confidence).toBe(finding.confidence);
	});

	it("a re-mining pass after acceptance does not resurrect the purged evidence", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		acceptFinding(db, finding.id);
		expect(patternMinerStore.getFindingEvidence(db, finding.id)).toEqual([]);

		// The SAME pattern gets re-detected by a later mining run -- this must
		// refresh the finding's stats but must NOT silently undo the purge.
		patternMinerStore.upsertFindings(db, [
			{
				environmentId: "env-a",
				patternType: "sequential_co_occurrence",
				trigger: { type: "app.focus", subject: "Editor" },
				follow: { type: "app.focus", subject: "Server" },
				windowMinutes: 30,
				occurrences: 99,
				trials: 100,
				confidence: 0.99,
				baselineProbability: 0.1,
				lift: 9,
				pValue: 0.00001,
				evidence: [{ triggerEventId: 999, followEventId: 1000 }],
			},
		]);

		expect(patternMinerStore.getFindingEvidence(db, finding.id)).toEqual([]);
		const refreshed = patternMinerStore.getFinding(db, finding.id);
		expect(refreshed.occurrences).toBe(99); // stats DID refresh
		expect(refreshed.status).toBe("accepted"); // status untouched by mining
	});
});

describe("ignoreFinding -- increasing back-off", () => {
	it("suppresses on the first ignore and records ignoreCount = 1", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		const now = Date.parse("2026-01-01T00:00:00Z");

		const result = ignoreFinding(db, finding.id, { now });
		expect(result.ok).toBe(true);
		expect(result.ignoreCount).toBe(1);
		expect(Date.parse(result.suppressedUntil)).toBeGreaterThan(now);

		const updated = patternMinerStore.getFinding(db, finding.id);
		expect(updated.status).toBe("ignored");
		expect(updated.ignoreCount).toBe(1);
	});

	it("each successive ignore (after resurfacing) suppresses for LONGER than the previous one", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		const t0 = Date.parse("2026-01-01T00:00:00Z");

		const firstIgnore = ignoreFinding(db, finding.id, { now: t0 });
		const firstWindowMs = Date.parse(firstIgnore.suppressedUntil) - t0;

		// Jump past the first suppression window and resurface.
		const t1 = Date.parse(firstIgnore.suppressedUntil) + 1000;
		resurfaceDueFindings(db, { now: t1 });
		expect(patternMinerStore.getFinding(db, finding.id).status).toBe("suggested");

		const secondIgnore = ignoreFinding(db, finding.id, { now: t1 });
		expect(secondIgnore.ok).toBe(true);
		expect(secondIgnore.ignoreCount).toBe(2);
		const secondWindowMs = Date.parse(secondIgnore.suppressedUntil) - t1;

		expect(secondWindowMs).toBeGreaterThan(firstWindowMs);
	});

	it("rejects ignoring a finding that is still inside its current suppression window", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		const t0 = Date.parse("2026-01-01T00:00:00Z");
		ignoreFinding(db, finding.id, { now: t0 });

		// Try again a moment later, well before the (>=24h default) window ends.
		const result = ignoreFinding(db, finding.id, { now: t0 + 1000 });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("invalid_transition");

		const updated = patternMinerStore.getFinding(db, finding.id);
		expect(updated.ignoreCount).toBe(1); // unchanged -- the second attempt never counted
	});

	it("rejects ignoring an already-accepted finding", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		acceptFinding(db, finding.id);

		const result = ignoreFinding(db, finding.id);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("invalid_transition");
	});

	it("rejects an unknown finding id", async () => {
		const db = await createDb();
		const result = ignoreFinding(db, "not-a-real-id");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_found");
	});
});

describe("resurfaceDueFindings", () => {
	it("resurfaces only ignored findings whose suppression window has elapsed, leaving still-suppressed ones alone", async () => {
		const db = await createDb();
		const dueFinding = seedFinding(db, { follow: { type: "app.focus", subject: "Server" } });
		const notDueFinding = seedFinding(db, { follow: { type: "app.focus", subject: "Docs" } });
		const t0 = Date.parse("2026-01-01T00:00:00Z");
		// notDueFinding is ignored ten days LATER than dueFinding (same ignore
		// count/back-off duration for both) purely so its suppression window
		// ends later in wall-clock time -- letting the sweep below land strictly
		// between the two windows.
		const t0Later = t0 + 10 * 24 * 60 * 60 * 1000;

		const dueResult = ignoreFinding(db, dueFinding.id, { now: t0 });
		const notDueResult = ignoreFinding(db, notDueFinding.id, { now: t0Later });

		// Sweep at a moment strictly between "dueFinding's window already
		// elapsed" and "notDueFinding's window still has time left" -- an
		// actively opposing fixture, not just "sweep way in the future".
		const sweepAt = Date.parse(dueResult.suppressedUntil) + 1000;
		expect(sweepAt).toBeLessThan(Date.parse(notDueResult.suppressedUntil));

		const result = resurfaceDueFindings(db, { now: sweepAt });
		expect(result.findingIds).toContain(dueFinding.id);
		expect(result.findingIds).not.toContain(notDueFinding.id);

		expect(patternMinerStore.getFinding(db, dueFinding.id).status).toBe("suggested");
		expect(patternMinerStore.getFinding(db, notDueFinding.id).status).toBe("ignored");
	});

	it("is a safe no-op when nothing is ignored", async () => {
		const db = await createDb();
		seedFinding(db);
		const result = resurfaceDueFindings(db, { now: Date.now() });
		expect(result).toEqual({ resurfacedCount: 0, findingIds: [] });
	});
});

describe("sweepExpiredFindings", () => {
	const config = { expiryDays: 14 };

	it("expires a suggested finding whose expiry window has elapsed, and leaves a fresh one alone", async () => {
		const db = await createDb();
		const staleFinding = seedFinding(db, { follow: { type: "app.focus", subject: "Server" } });
		const freshFinding = seedFinding(db, { follow: { type: "app.focus", subject: "Docs" } });

		const longAgo = Date.parse("2026-01-01T00:00:00Z");
		const recently = Date.parse("2026-01-20T00:00:00Z");
		markSuggested(db, staleFinding.id, { now: longAgo });
		markSuggested(db, freshFinding.id, { now: recently });

		const sweepAt = Date.parse("2026-01-20T00:00:00Z"); // 19 days after staleFinding, 0 after freshFinding
		const result = sweepExpiredFindings(db, { now: sweepAt, config });

		expect(result.findingIds).toContain(staleFinding.id);
		expect(result.findingIds).not.toContain(freshFinding.id);
		expect(patternMinerStore.getFinding(db, staleFinding.id).status).toBe("expired");
		expect(patternMinerStore.getFinding(db, freshFinding.id).status).toBe("suggested");
	});

	it("NEVER expires an already-accepted finding, even with a very old suggestedAt", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		const longAgo = Date.parse("2026-01-01T00:00:00Z");
		markSuggested(db, finding.id, { now: longAgo });
		acceptFinding(db, finding.id, { now: longAgo });

		const sweepAt = Date.parse("2026-06-01T00:00:00Z"); // months later
		const result = sweepExpiredFindings(db, { now: sweepAt, config });

		expect(result.findingIds).not.toContain(finding.id);
		expect(patternMinerStore.getFinding(db, finding.id).status).toBe("accepted");
	});

	it("expires a finding that was never explicitly suggested, using its createdAt", async () => {
		const db = await createDb();
		const finding = seedFinding(db);
		expect(finding.status).toBe("new");
		expect(finding.suggestedAt).toBeNull();

		// created_at is "now" at seed time; sweep far enough in the future.
		const sweepAt = Date.now() + 20 * 24 * 60 * 60 * 1000;
		const result = sweepExpiredFindings(db, { now: sweepAt, config });
		expect(result.findingIds).toContain(finding.id);
		expect(patternMinerStore.getFinding(db, finding.id).status).toBe("expired");
	});
});
