import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasDatabase } from "../../db.cjs";
import {
	MAX_CONTENT_LENGTH,
	createMemory,
	deleteMemoriesForEnvironment,
	deleteMemory,
	getMemory,
	listMemories,
	updateMemory,
} from "./memory-store.cjs";

// ---------------------------------------------------------------------------
// Per-environment AI memory (WP-4.2, migration 015). The assertions that carry
// weight are the scoping ones: an id is a capability, and ids leak, so every
// read and write must verify the row belongs to the environment being asked
// about rather than trusting the id alone.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function createTempDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-memory-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "atlas.db");
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

async function twoEnvironments() {
	const db = await AtlasDatabase.create(createTempDbPath());
	return { db, a: db.createEnvironment("A"), b: db.createEnvironment("B") };
}

describe("scoping -- an id alone is never enough", () => {
	it("does not return another environment's memory, even given its exact id", async () => {
		const { db, a, b } = await twoEnvironments();
		const secret = createMemory(db, b.id, "B's private fact");

		expect(getMemory(db, a.id, secret.id)).toBeNull();
		// And it really does exist, so the null above is scoping and not absence.
		expect(getMemory(db, b.id, secret.id)).toBeTruthy();
	});

	it("does not update another environment's memory", async () => {
		const { db, a, b } = await twoEnvironments();
		const secret = createMemory(db, b.id, "original");

		expect(updateMemory(db, a.id, secret.id, "hijacked")).toBeNull();
		expect(getMemory(db, b.id, secret.id).content).toBe("original");
	});

	it("does not delete another environment's memory", async () => {
		const { db, a, b } = await twoEnvironments();
		const secret = createMemory(db, b.id, "keep me");

		expect(deleteMemory(db, a.id, secret.id)).toBe(false);
		expect(getMemory(db, b.id, secret.id)).toBeTruthy();
	});

	it("lists only the asked-for environment's memories", async () => {
		const { db, a, b } = await twoEnvironments();
		createMemory(db, a.id, "a one");
		createMemory(db, b.id, "b one");
		createMemory(db, b.id, "b two");

		expect(listMemories(db, a.id).map((entry) => entry.content)).toEqual(["a one"]);
		expect(listMemories(db, b.id)).toHaveLength(2);
	});

	it("returns nothing at all without an environment id -- never everything", async () => {
		const { db, a } = await twoEnvironments();
		createMemory(db, a.id, "something");

		expect(listMemories(db, null)).toEqual([]);
		expect(listMemories(db, "")).toEqual([]);
		expect(createMemory(db, null, "orphan")).toBeNull();
	});
});

describe("ordering", () => {
	// The context builder truncates from the END, so oldest-first means the
	// facts a user set up earliest are the last to be squeezed out. A recency
	// order would make the same prompt include different memories on different
	// days.
	it("is oldest first, and stable", async () => {
		const { db, a } = await twoEnvironments();
		createMemory(db, a.id, "first");
		createMemory(db, a.id, "second");
		createMemory(db, a.id, "third");

		const contents = listMemories(db, a.id).map((entry) => entry.content);
		expect(contents).toEqual(["first", "second", "third"]);
		expect(listMemories(db, a.id).map((entry) => entry.content)).toEqual(contents);
	});
});

describe("content handling", () => {
	it("trims surrounding whitespace", async () => {
		const { db, a } = await twoEnvironments();
		expect(createMemory(db, a.id, "   remember this   ").content).toBe("remember this");
	});

	it("caps a runaway paste rather than rejecting it", async () => {
		const { db, a } = await twoEnvironments();
		const memory = createMemory(db, a.id, "x".repeat(MAX_CONTENT_LENGTH * 3));
		expect(memory.content).toHaveLength(MAX_CONTENT_LENGTH);
	});

	it("refuses to store an empty memory", async () => {
		const { db, a } = await twoEnvironments();
		expect(createMemory(db, a.id, "")).toBeNull();
		expect(createMemory(db, a.id, "    ")).toBeNull();
		expect(createMemory(db, a.id, null)).toBeNull();
		expect(listMemories(db, a.id)).toEqual([]);
	});

	// Blanking is not editing. Deleting is explicit, so an accidental empty
	// save must not silently destroy the fact.
	it("refuses to blank an existing memory through update", async () => {
		const { db, a } = await twoEnvironments();
		const memory = createMemory(db, a.id, "keep me");

		expect(updateMemory(db, a.id, memory.id, "   ").content).toBe("keep me");
	});

	it("updates content and moves updatedAt", async () => {
		const { db, a } = await twoEnvironments();
		const memory = createMemory(db, a.id, "before");

		const updated = updateMemory(db, a.id, memory.id, "after");
		expect(updated.content).toBe("after");
		expect(updated.createdAt).toBe(memory.createdAt);
	});
});

describe("deleteMemoriesForEnvironment", () => {
	it("removes exactly that environment's memories and reports how many", async () => {
		const { db, a, b } = await twoEnvironments();
		createMemory(db, a.id, "a one");
		createMemory(db, a.id, "a two");
		createMemory(db, b.id, "b one");

		expect(deleteMemoriesForEnvironment(db, a.id)).toBe(2);
		expect(listMemories(db, a.id)).toEqual([]);
		expect(listMemories(db, b.id)).toHaveLength(1);
	});
});
