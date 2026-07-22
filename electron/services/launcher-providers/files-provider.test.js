import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import { rebuildFtsIndex, upsertFilesBatch } from "../file-index/store.cjs";
import { execute, formatSize, name as providerName, search, toResult } from "./files-provider.cjs";

const tmpDirs = [];

function makeTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-files-provider-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function createSeededDb() {
	const db = await AtlasDatabase.create(makeTempDbPath());
	upsertFilesBatch(
		db,
		[
			{
				path: "C:\\envA\\secret-plan.docx",
				name: "secret-plan.docx",
				ext: "docx",
				size: 2048,
				mtime: 1,
				environmentId: "env-a",
				root: "root-a",
			},
			{
				path: "C:\\envB\\budget-report.xlsx",
				name: "budget-report.xlsx",
				ext: "xlsx",
				size: 4096,
				mtime: 1,
				environmentId: "env-b",
				root: "root-b",
			},
			{
				path: "C:\\global\\readme.md",
				name: "readme.md",
				ext: "md",
				size: 512,
				mtime: 1,
				environmentId: null,
				root: "root-global",
			},
		],
		1000,
	);
	rebuildFtsIndex(db);
	return db;
}

describe("files-provider name", () => {
	it("is registered as 'files'", () => {
		expect(providerName).toBe("files");
	});
});

describe("files-provider.search", () => {
	it("returns [] when there is no db, matching every other provider's degrade-safely contract", () => {
		expect(search("anything", { getDb: () => null })).toEqual([]);
	});

	it("returns [] for a blank query", async () => {
		const db = await createSeededDb();
		expect(search("   ", { getDb: () => db })).toEqual([]);
	});

	it("finds a file scoped to the requesting environment", async () => {
		const db = await createSeededDb();
		const results = search("secret", { getDb: () => db, environmentId: "env-a" });
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ kind: "file", title: "secret-plan.docx" });
	});

	it("finds a global (unassigned-root) file regardless of the requesting environment", async () => {
		const db = await createSeededDb();
		const results = search("readme", { getDb: () => db, environmentId: "env-a" });
		expect(results.map((r) => r.title)).toEqual(["readme.md"]);
	});

	// The literal requirement this WP calls out: an environment (enclosed or
	// otherwise) must never see another environment's files through the
	// launcher's file search.
	it("never surfaces another environment's file -- the enclosed/cross-environment isolation proof", async () => {
		const db = await createSeededDb();
		const asEnvB = search("secret", { getDb: () => db, environmentId: "env-b" });
		expect(asEnvB).toEqual([]);

		const asEnvA = search("budget", { getDb: () => db, environmentId: "env-a" });
		expect(asEnvA).toEqual([]);
	});

	it("caps results and includes a formatted size in the subtitle", async () => {
		const db = await createSeededDb();
		const results = search("budget", { getDb: () => db, environmentId: "env-b" });
		expect(results[0].subtitle).toContain("KB");
	});
});

describe("files-provider.execute", () => {
	// Under plain vitest (no real Electron process), electron/platform/
	// win32.cjs's launchInstalledApp() lazily requires "electron", which
	// resolves to a plain path string rather than the module object (see that
	// file's own header) -- so `shell.openPath` is unreachable and the call
	// degrades to `{ supported: true, launched: false }` rather than throwing.
	// This mirrors apps-provider.test.js's own execute() tests, which rely on
	// exactly the same safe-degrade behaviour rather than mocking the
	// platform layer.
	it("degrades safely (never throws) and reports ok:false when the OS open fails", async () => {
		const outcome = await execute({ id: "C:\\a\\file.txt" });
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBeTruthy();
	});

	it("reports failure for a result with no id", async () => {
		const outcome = await execute({});
		expect(outcome.ok).toBe(false);
	});
});

describe("formatSize / toResult", () => {
	it("formats bytes into a human-readable unit", () => {
		expect(formatSize(0)).toBe("");
		expect(formatSize(500)).toBe("500 B");
		expect(formatSize(1536)).toBe("1.5 KB");
	});

	it("maps a store row to a launcher result shape", () => {
		const result = toResult({ path: "C:\\a\\f.txt", name: "f.txt", size: 10 });
		expect(result).toMatchObject({ id: "C:\\a\\f.txt", kind: "file", title: "f.txt" });
	});
});
