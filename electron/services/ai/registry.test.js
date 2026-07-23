import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviders, describeProvider, listProviderIds, getProvider, describeAll } from "./registry.cjs";

// ---------------------------------------------------------------------------
// WP-4.1's fourth acceptance criterion -- "adding a provider requires no
// changes outside its own module" -- tested the only way it can honestly be
// tested: by writing a NEW provider file into a directory and checking it is
// registered, without any list being edited.
//
// `loadProviders(dir)` takes its directory precisely so this is possible.
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeProviderDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-registry-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

function writeProvider(dir, name, source) {
	fs.writeFileSync(path.join(dir, `${name}.cjs`), source, "utf8");
}

const VALID_PROVIDER = `
"use strict";
module.exports = {
	id: "fixture",
	label: "Fixture Provider",
	defaultModel: "fixture-1",
	capabilities: { streaming: false, tools: true },
	complete: async () => ({ text: "hello" }),
};
`;

describe("loadProviders -- discovery, not a list", () => {
	// THE criterion.
	it("registers a provider that is only ever added as a file", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "fixture", VALID_PROVIDER);

		const { providers, problems } = loadProviders(dir);

		expect(problems).toEqual([]);
		expect(providers.has("fixture")).toBe(true);
		expect(providers.get("fixture").label).toBe("Fixture Provider");
	});

	it("registers several, in a stable order", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "bbb", VALID_PROVIDER.replace(/fixture/g, "bbb"));
		writeProvider(dir, "aaa", VALID_PROVIDER.replace(/fixture/g, "aaa"));

		expect([...loadProviders(dir).providers.keys()]).toEqual(["aaa", "bbb"]);
	});

	it("ignores files that are not .cjs modules", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "fixture", VALID_PROVIDER);
		fs.writeFileSync(path.join(dir, "notes.md"), "not a provider", "utf8");
		fs.writeFileSync(path.join(dir, "data.json"), "{}", "utf8");

		const { providers, problems } = loadProviders(dir);
		expect(providers.size).toBe(1);
		expect(problems).toEqual([]);
	});

	// One bad module must cost you that module and nothing else.
	it("keeps the good providers when one fails to load", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "good", VALID_PROVIDER.replace(/fixture/g, "good"));
		writeProvider(dir, "broken", `throw new Error("boom");`);

		const { providers, problems } = loadProviders(dir);

		expect(providers.has("good")).toBe(true);
		expect(providers.has("broken")).toBe(false);
		expect(problems).toHaveLength(1);
		expect(problems[0].file).toBe("broken.cjs");
	});

	it("rejects a module that does not meet the contract, naming what is wrong", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "incomplete", `module.exports = { id: "incomplete" };`);

		const { providers, problems } = loadProviders(dir);

		expect(providers.size).toBe(0);
		expect(problems[0].error).toMatch(/label/);
		expect(problems[0].error).toMatch(/complete/);
	});

	// A capability is a promise about behaviour; claiming one without the
	// function behind it would make every caller's degrade-check a lie.
	it("rejects a module claiming streaming with no stream function", () => {
		const dir = makeProviderDir();
		writeProvider(
			dir,
			"liar",
			VALID_PROVIDER.replace(/fixture/g, "liar").replace("streaming: false", "streaming: true"),
		);

		const { providers, problems } = loadProviders(dir);
		expect(providers.size).toBe(0);
		expect(problems[0].error).toMatch(/streaming/);
	});

	it("refuses a second module claiming an id already taken", () => {
		const dir = makeProviderDir();
		writeProvider(dir, "aaa", VALID_PROVIDER.replace(/fixture/g, "clash"));
		writeProvider(dir, "bbb", VALID_PROVIDER.replace(/fixture/g, "clash"));

		const { providers, problems } = loadProviders(dir);
		expect(providers.size).toBe(1);
		expect(problems[0].error).toMatch(/duplicate/);
	});

	it("normalizes capabilities, dropping flags this build does not know", () => {
		const dir = makeProviderDir();
		writeProvider(
			dir,
			"odd",
			VALID_PROVIDER.replace(/fixture/g, "odd").replace(
				"capabilities: { streaming: false, tools: true }",
				'capabilities: { tools: true, telepathy: true, streaming: "yes" }',
			),
		);

		const provider = loadProviders(dir).providers.get("odd");
		expect(provider.capabilities).toEqual({ streaming: false, tools: true });
	});

	it("reports a missing directory instead of throwing", () => {
		const { providers, problems } = loadProviders(path.join(os.tmpdir(), "atlas-no-such-provider-dir"));
		expect(providers.size).toBe(0);
		expect(problems).toHaveLength(1);
	});
});

describe("the real provider directory", () => {
	it("registers the three shipped providers and nothing broken", () => {
		expect(listProviderIds().sort()).toEqual(["anthropic", "google", "openai"]);
	});

	it("has every shipped provider claiming both streaming and tools", () => {
		for (const id of listProviderIds()) {
			expect(getProvider(id).capabilities, id).toEqual({ streaming: true, tools: true });
		}
	});
});

describe("describeProvider -- the renderer-safe shape", () => {
	// The boundary that matters: this is what crosses IPC, so anything
	// key-shaped or endpoint-shaped must not be in it.
	it("exposes only id, label, defaultModel and capabilities", () => {
		const description = describeProvider(getProvider("anthropic"));
		expect(Object.keys(description).sort()).toEqual(["capabilities", "defaultModel", "id", "label"]);
	});

	it("carries no functions, keys, endpoints or headers", () => {
		const serialized = JSON.stringify(describeAll());
		expect(serialized).not.toMatch(/api[._-]?key/i);
		expect(serialized).not.toMatch(/https?:\/\//);
		expect(serialized).not.toMatch(/authorization/i);
		for (const description of describeAll()) {
			for (const value of Object.values(description)) {
				expect(typeof value).not.toBe("function");
			}
		}
	});

	it("returns null rather than throwing for a provider that isn't registered", () => {
		expect(describeProvider(getProvider("nope"))).toBeNull();
	});
});
