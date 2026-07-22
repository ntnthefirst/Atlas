import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	upsertFindings,
	listFindingsForEnvironment,
	listAllFindings,
	getFinding,
	getFindingEvidence,
	purgeFindingEvidence,
	deleteFinding,
} from "./store.cjs";

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pattern-miner-store-test-"));
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

function sampleFinding(overrides = {}) {
	return {
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
}

describe("upsertFindings -- an unstorable finding must not destroy the run", () => {
	// miner.cjs collects EVERY environment bucket's findings and calls
	// upsertFindings ONCE, in a single transaction. `findings.environment_id`
	// is NOT NULL (migration 012), but the miner genuinely produces a "no
	// environment" bucket for events recorded outside any environment. Without
	// the null guard that combination throws mid-transaction and discards every
	// other environment's results too -- so this fixture deliberately puts the
	// null finding FIRST, where an abort would take the good ones down with it.
	it("skips a null-environment finding and still stores every other bucket's findings", async () => {
		const db = await createDb();
		const result = upsertFindings(db, [
			sampleFinding({ environmentId: null }),
			sampleFinding({ environmentId: "env-a" }),
			sampleFinding({ environmentId: "env-b" }),
		]);

		expect(result).toEqual({ created: 2, updated: 0 });
		expect(listFindingsForEnvironment(db, "env-a").length).toBe(1);
		expect(listFindingsForEnvironment(db, "env-b").length).toBe(1);
	});

	it("skips an undefined-environment finding the same way", async () => {
		const db = await createDb();
		const result = upsertFindings(db, [
			sampleFinding({ environmentId: undefined }),
			sampleFinding({ environmentId: "env-a" }),
		]);

		expect(result).toEqual({ created: 1, updated: 0 });
		expect(listFindingsForEnvironment(db, "env-a").length).toBe(1);
	});
});

describe("upsertFindings", () => {
	it("creates a new finding row plus its evidence rows", async () => {
		const db = await createDb();
		const result = upsertFindings(db, [sampleFinding()]);
		expect(result).toEqual({ created: 1, updated: 0 });

		const findings = listFindingsForEnvironment(db, "env-a");
		expect(findings.length).toBe(1);
		expect(findings[0].status).toBe("new");
		expect(findings[0].trigger).toEqual({ type: "app.focus", subject: "Editor" });
		expect(findings[0].occurrences).toBe(12);

		const evidence = getFindingEvidence(db, findings[0].id);
		expect(evidence).toEqual([
			{ triggerEventId: 1, followEventId: 2 },
			{ triggerEventId: 3, followEventId: 4 },
		]);
	});

	it("UPDATEs an existing finding's stats in place on a re-run, rather than duplicating the row", async () => {
		const db = await createDb();
		upsertFindings(db, [sampleFinding({ occurrences: 12, trials: 15 })]);
		const firstId = listFindingsForEnvironment(db, "env-a")[0].id;

		const result = upsertFindings(db, [sampleFinding({ occurrences: 20, trials: 24, confidence: 0.83 })]);
		expect(result).toEqual({ created: 0, updated: 1 });

		const findings = listFindingsForEnvironment(db, "env-a");
		expect(findings.length).toBe(1); // still exactly one row
		expect(findings[0].id).toBe(firstId); // same identity
		expect(findings[0].occurrences).toBe(20); // stats refreshed
		expect(findings[0].confidence).toBe(0.83);
	});

	it("replaces evidence wholesale on a re-run rather than accumulating it", async () => {
		const db = await createDb();
		upsertFindings(db, [
			sampleFinding({
				evidence: [
					{ triggerEventId: 1, followEventId: 2 },
					{ triggerEventId: 3, followEventId: 4 },
				],
			}),
		]);
		const id = listFindingsForEnvironment(db, "env-a")[0].id;

		upsertFindings(db, [sampleFinding({ evidence: [{ triggerEventId: 100, followEventId: 101 }] })]);
		const evidence = getFindingEvidence(db, id);
		expect(evidence).toEqual([{ triggerEventId: 100, followEventId: 101 }]);
	});

	it("keeps two different pattern identities as two separate rows, even in the same environment", async () => {
		const db = await createDb();
		upsertFindings(db, [
			sampleFinding({ follow: { type: "app.focus", subject: "Server" } }),
			sampleFinding({ follow: { type: "app.focus", subject: "Docs" } }),
		]);
		expect(listFindingsForEnvironment(db, "env-a").length).toBe(2);
	});

	it("keeps the same trigger/follow pair as two separate rows across two different environments", async () => {
		const db = await createDb();
		upsertFindings(db, [sampleFinding({ environmentId: "env-a" }), sampleFinding({ environmentId: "env-b" })]);
		expect(listFindingsForEnvironment(db, "env-a").length).toBe(1);
		expect(listFindingsForEnvironment(db, "env-b").length).toBe(1);
		expect(listAllFindings(db).length).toBe(2);
	});

	it("matches a NULL subject correctly (not just non-null equality) when deciding create vs. update", async () => {
		const db = await createDb();
		upsertFindings(db, [
			sampleFinding({ trigger: { type: "session.start", subject: null }, follow: { type: "session.stop", subject: null } }),
		]);
		expect(listAllFindings(db).length).toBe(1);

		upsertFindings(db, [
			sampleFinding({
				trigger: { type: "session.start", subject: null },
				follow: { type: "session.stop", subject: null },
				occurrences: 99,
			}),
		]);
		const findings = listAllFindings(db);
		expect(findings.length).toBe(1); // matched the existing NULL-subject row, not a duplicate
		expect(findings[0].occurrences).toBe(99);
	});

	it("skips a malformed entry rather than aborting the whole batch", async () => {
		const db = await createDb();
		const result = upsertFindings(db, [null, sampleFinding()]);
		expect(result).toEqual({ created: 1, updated: 0 });
	});
});

describe("purgeFindingEvidence (WP-3.4's purge hook)", () => {
	it("removes every evidence row for a finding WITHOUT deleting the finding itself", async () => {
		const db = await createDb();
		upsertFindings(db, [sampleFinding()]);
		const finding = listAllFindings(db)[0];
		expect(getFindingEvidence(db, finding.id).length).toBe(2);

		const removed = purgeFindingEvidence(db, finding.id);
		expect(removed).toBe(2);
		expect(getFindingEvidence(db, finding.id)).toEqual([]);

		// The finding itself, and its summary stats, must still be there.
		const stillThere = getFinding(db, finding.id);
		expect(stillThere).not.toBeNull();
		expect(stillThere.occurrences).toBe(finding.occurrences);
		expect(stillThere.confidence).toBe(finding.confidence);
	});

	it("is a safe no-op for a finding with no evidence left", async () => {
		const db = await createDb();
		upsertFindings(db, [sampleFinding()]);
		const finding = listAllFindings(db)[0];
		purgeFindingEvidence(db, finding.id);
		expect(purgeFindingEvidence(db, finding.id)).toBe(0);
	});
});

describe("deleteFinding", () => {
	it("removes both the finding and its evidence", async () => {
		const db = await createDb();
		upsertFindings(db, [sampleFinding()]);
		const finding = listAllFindings(db)[0];

		const deleted = deleteFinding(db, finding.id);
		expect(deleted).toBe(true);
		expect(getFinding(db, finding.id)).toBeNull();
		expect(getFindingEvidence(db, finding.id)).toEqual([]);
	});

	it("returns false for an id that doesn't exist", async () => {
		const db = await createDb();
		expect(deleteFinding(db, "not-a-real-id")).toBe(false);
	});
});
