import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import * as patternMinerStore from "../pattern-miner/store.cjs";
import * as memoryStore from "./memory-store.cjs";
import { buildEnvironmentContext, gatherSources } from "./ai-context.cjs";

// ---------------------------------------------------------------------------
// WP-4.2's second acceptance criterion -- "a test proves an enclosed
// environment's data never enters another's context" -- against a REAL
// temp-file database.
//
// The fixtures below are built to make a leak LOUD: every row in the enclosed
// environment carries the marker string SECRET_MARKER, and the assertions
// check the rendered context text for it directly. A leak of any kind, through
// any section, in any wording, fails.
// ---------------------------------------------------------------------------

const SECRET_MARKER = "ZZ-ENCLOSED-ONLY-ZZ";

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-context-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

const createDb = () => AtlasDatabase.create(createTempDbPath());

function insertEvent(db, environmentId, type, subject) {
	db.run("INSERT INTO events (ts, environment_id, type, subject, payload, session_id) VALUES (?, ?, ?, ?, NULL, NULL)", [
		new Date().toISOString(),
		environmentId,
		type,
		subject,
	]);
}

function seedFinding(db, environmentId, subject) {
	patternMinerStore.upsertFindings(db, [
		{
			environmentId,
			patternType: "sequential_co_occurrence",
			trigger: { type: "app.focus", subject },
			follow: { type: "app.focus", subject: `${subject}-follow` },
			windowMinutes: 30,
			occurrences: 12,
			trials: 15,
			confidence: 0.8,
			baselineProbability: 0.1,
			lift: 8,
			pValue: 0.0001,
			evidence: [],
		},
	]);
}

// Fills an environment with one row of every kind the context builder reads.
function seedEverything(db, environmentId, marker) {
	db.createTask(environmentId, `Task ${marker}`);
	db.createNote(environmentId, `Note ${marker}`);
	memoryStore.createMemory(db, environmentId, `Memory ${marker}`);
	seedFinding(db, environmentId, `App${marker}`);
	insertEvent(db, environmentId, "app.focus", `Focus ${marker}`);
}

describe("isolation -- the criterion", () => {
	async function twoEnvironments(enclosedMode) {
		const db = await createDb();
		const open = db.createEnvironment("Open");
		const secret = db.createEnvironment("Secret");
		db.setEnvironmentIsolationMode(secret.id, enclosedMode);

		seedEverything(db, open.id, "OPEN");
		seedEverything(db, secret.id, SECRET_MARKER);
		return { db, open, secret };
	}

	it("an enclosed environment's data never appears in another environment's context", async () => {
		const { db, open } = await twoEnvironments("enclosed");

		const context = buildEnvironmentContext(db, open.id, { environmentName: "Open" });

		// The whole rendered prompt, checked for the marker in any form.
		expect(context.text).not.toContain(SECRET_MARKER);
		// And the structured sections too, in case a section is ever rendered
		// differently from how it is stored.
		expect(JSON.stringify(context.sections)).not.toContain(SECRET_MARKER);
	});

	// The mirror image: the marker check would pass trivially if the context
	// were simply empty, so prove the fixture really does produce a full one.
	it("the same build DOES contain that environment's own data, so the check above is not vacuous", async () => {
		const { db, open } = await twoEnvironments("enclosed");

		const context = buildEnvironmentContext(db, open.id, { environmentName: "Open" });

		expect(context.text).toContain("Task OPEN");
		expect(context.text).toContain("Note OPEN");
		expect(context.text).toContain("Memory OPEN");
		expect(context.text).toContain("AppOPEN");
	});

	// A connected neighbour must not leak either. Isolation mode governs
	// CROSS-environment aggregates; context is per-environment regardless, and
	// this pins that down so a future "connected environments can share" change
	// cannot quietly widen it.
	it("a CONNECTED environment's data does not enter another's context either", async () => {
		const { db, open } = await twoEnvironments("connected");

		const context = buildEnvironmentContext(db, open.id, { environmentName: "Open" });
		expect(context.text).not.toContain(SECRET_MARKER);
	});

	it("holds in the other direction -- the enclosed environment sees only itself", async () => {
		const { db, secret } = await twoEnvironments("enclosed");

		const context = buildEnvironmentContext(db, secret.id, { environmentName: "Secret" });
		expect(context.text).toContain(SECRET_MARKER);
		expect(context.text).not.toContain("OPEN");
	});

	it("every gathered source list is scoped, not just the rendered text", async () => {
		const { db, open } = await twoEnvironments("enclosed");

		const sources = gatherSources(db, open.id);
		for (const [section, lines] of Object.entries(sources)) {
			expect(JSON.stringify(lines), section).not.toContain(SECRET_MARKER);
		}
	});

	it("builds nothing at all without an environment id -- never 'everything'", async () => {
		const { db } = await twoEnvironments("enclosed");

		const context = buildEnvironmentContext(db, null);
		expect(context.text).toBe("");
		expect(context.sections).toEqual([]);
	});
});

describe("what goes into the context", () => {
	async function seeded() {
		const db = await createDb();
		const environment = db.createEnvironment("Work");
		return { db, environment };
	}

	it("names the environment in the header, so the model knows where it is", async () => {
		const { db, environment } = await seeded();
		db.createTask(environment.id, "Something");

		const context = buildEnvironmentContext(db, environment.id, { environmentName: "Work" });
		expect(context.text).toContain('"Work"');
	});

	it("leaves out tasks that are done, and keeps custom columns", async () => {
		const { db, environment } = await seeded();
		const open = db.createTask(environment.id, "Still open");
		const custom = db.createTask(environment.id, "In review");
		db.updateTaskStatus(custom.id, "review");
		const closed = db.createTask(environment.id, "Finished");
		db.updateTaskStatus(closed.id, "done");

		const context = buildEnvironmentContext(db, environment.id);

		expect(context.text).toContain("Still open");
		// A free-form column must not be mistaken for closed -- this is the bug
		// an allowlist of "open" statuses would have introduced.
		expect(context.text).toContain("In review");
		expect(context.text).not.toContain("Finished");
		expect(open).toBeTruthy();
	});

	it("orders findings by strength, so a squeeze drops the weakest", async () => {
		const { db, environment } = await seeded();
		patternMinerStore.upsertFindings(db, [
			{
				environmentId: environment.id,
				patternType: "sequential_co_occurrence",
				trigger: { type: "app.focus", subject: "Weak" },
				follow: { type: "app.focus", subject: "W2" },
				windowMinutes: 30,
				occurrences: 6,
				trials: 10,
				confidence: 0.6,
				baselineProbability: 0.3,
				lift: 2,
				pValue: 0.01,
				evidence: [],
			},
			{
				environmentId: environment.id,
				patternType: "sequential_co_occurrence",
				trigger: { type: "app.focus", subject: "Strong" },
				follow: { type: "app.focus", subject: "S2" },
				windowMinutes: 30,
				occurrences: 20,
				trials: 22,
				confidence: 0.9,
				baselineProbability: 0.05,
				lift: 18,
				pValue: 0.0001,
				evidence: [],
			},
		]);

		const findings = gatherSources(db, environment.id).findings;
		expect(findings[0]).toContain("Strong");
		expect(findings[1]).toContain("Weak");
	});

	// A note is a serialized notebook canvas, not prose. The naive version put
	// `{"version":1,"viewport":...}` into every prompt, because every
	// environment is created with an empty notebook.
	it("reads the text out of a notebook canvas instead of dumping its JSON", async () => {
		const { db, environment } = await seeded();
		db.updateNotebookByEnvironment(
			environment.id,
			JSON.stringify({
				version: 1,
				viewport: { x: 0, y: 0, zoom: 1 },
				nodes: [
					{ id: "n1", type: "text", x: 0, y: 0, w: 1, h: 1, z: 0, text: "Ship the release" },
					{ id: "n2", type: "media", x: 0, y: 0, w: 1, h: 1, z: 1, dataUrl: "data:image/png;base64,AAAA" },
					{ id: "n3", type: "postit", x: 0, y: 0, w: 1, h: 1, z: 2, text: "Call the printer" },
				],
			}),
		);

		const notes = gatherSources(db, environment.id).notes;
		expect(notes[0]).toBe("Ship the release · Call the printer");
		expect(notes[0]).not.toContain("viewport");
		expect(notes[0]).not.toContain("base64");
	});

	it("contributes nothing for the empty notebook every environment starts with", async () => {
		const { db, environment } = await seeded();

		expect(gatherSources(db, environment.id).notes).toEqual([]);
	});

	it("falls back to flattened plain text for a note that is not a canvas", async () => {
		const { db, environment } = await seeded();
		db.createNote(environment.id, "line one\n\n\n   line two");

		expect(gatherSources(db, environment.id).notes).toContain("line one line two");
	});

	it("produces an empty context for an environment with nothing in it, without throwing", async () => {
		const { db, environment } = await seeded();

		const context = buildEnvironmentContext(db, environment.id, { environmentName: "Work" });
		// The header still renders; no section contributes anything.
		expect(context.sections.every((section) => section.lines.length === 0)).toBe(true);
	});
});
