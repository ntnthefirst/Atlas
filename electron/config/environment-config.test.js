import { describe, expect, it } from "vitest";
import {
	CONFIG_VERSION,
	AI_PROVIDERS,
	defaultEnvironmentConfig,
	normalizeEnvironmentConfig,
	upgradeEnvironmentConfig,
	parseEnvironmentConfig,
	serializeEnvironmentConfig,
	applyConfigPatch,
} from "./environment-config.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS -- importing environment-config.cjs across that
// boundary works, while the reverse does not: vitest's CJS entrypoint
// deliberately throws.

describe("defaultEnvironmentConfig", () => {
	it("returns a full, valid document with no seed at all", () => {
		const config = defaultEnvironmentConfig();
		expect(config).toEqual({
			version: 1,
			appearance: { accent: null, theme: "system" },
			notchLayoutId: null,
			ai: { defaultProvider: null, systemPrompt: "" },
			integrations: {},
			startupBehaviour: { autoStartSession: false, launchApps: [] },
		});
	});

	it("seeds appearance.accent from the environment's existing accent column", () => {
		const config = defaultEnvironmentConfig({ accent: "#ff8800" });
		expect(config.appearance.accent).toBe("#ff8800");
	});

	it("does not invent an accent when the environment never had one", () => {
		const config = defaultEnvironmentConfig({ accent: null });
		expect(config.appearance.accent).toBeNull();
	});

	it("ignores icon/preset -- they have no slot in this schema, only accent is seeded", () => {
		const config = defaultEnvironmentConfig({ icon: "book", preset: "study", accent: "#10b981" });
		expect(config.appearance.accent).toBe("#10b981");
		expect(config).not.toHaveProperty("icon");
		expect(config).not.toHaveProperty("preset");
	});

	it("returns fresh objects each call -- mutating the result cannot corrupt a later call", () => {
		const first = defaultEnvironmentConfig();
		first.integrations.foo = true;
		first.startupBehaviour.launchApps.push("notepad.exe");

		const second = defaultEnvironmentConfig();
		expect(second.integrations).toEqual({});
		expect(second.startupBehaviour.launchApps).toEqual([]);
	});
});

describe("parseEnvironmentConfig -- defensive parsing", () => {
	it("returns seeded defaults for null", () => {
		expect(parseEnvironmentConfig(null, { accent: "#3b82f6" }).appearance.accent).toBe("#3b82f6");
	});

	it("returns seeded defaults for undefined", () => {
		expect(parseEnvironmentConfig(undefined, { accent: "#3b82f6" }).appearance.accent).toBe("#3b82f6");
	});

	it("returns seeded defaults for an empty or whitespace-only string", () => {
		expect(parseEnvironmentConfig("", { accent: "#3b82f6" }).appearance.accent).toBe("#3b82f6");
		expect(parseEnvironmentConfig("   ", { accent: "#3b82f6" }).appearance.accent).toBe("#3b82f6");
	});

	it("returns defaults, never throws, for non-object input (number, boolean, array)", () => {
		expect(() => parseEnvironmentConfig(42)).not.toThrow();
		expect(parseEnvironmentConfig(42)).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig(true)).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig([1, 2, 3])).toEqual(defaultEnvironmentConfig());
	});

	it("returns defaults, never throws, for invalid JSON", () => {
		expect(() => parseEnvironmentConfig("{not valid json")).not.toThrow();
		expect(parseEnvironmentConfig("{not valid json")).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig("undefined")).toEqual(defaultEnvironmentConfig());
	});

	it("returns defaults for valid JSON that parses to a non-object (a string, number, array, null)", () => {
		expect(parseEnvironmentConfig(JSON.stringify("just a string"))).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig(JSON.stringify(123))).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig(JSON.stringify([1, 2, 3]))).toEqual(defaultEnvironmentConfig());
		expect(parseEnvironmentConfig(JSON.stringify(null), { accent: "#3b82f6" }).appearance.accent).toBe("#3b82f6");
	});

	it("fills in missing fields with defaults, keeping the fields that were present", () => {
		const result = parseEnvironmentConfig(JSON.stringify({ notchLayoutId: "layout-1" }), { accent: "#3b82f6" });
		expect(result.notchLayoutId).toBe("layout-1");
		expect(result.appearance).toEqual({ accent: "#3b82f6", theme: "system" });
		expect(result.ai).toEqual({ defaultProvider: null, systemPrompt: "" });
		expect(result.integrations).toEqual({});
		expect(result.startupBehaviour).toEqual({ autoStartSession: false, launchApps: [] });
	});

	it("falls back per-field on wrong-typed values instead of discarding the whole document", () => {
		const result = parseEnvironmentConfig(
			JSON.stringify({
				appearance: { accent: 12345, theme: "not-a-theme" },
				notchLayoutId: 999,
				ai: { defaultProvider: "not-a-provider", systemPrompt: 42 },
				integrations: "not an object",
				startupBehaviour: { autoStartSession: "yes", launchApps: "not an array" },
			}),
			{ accent: "#3b82f6" },
		);

		expect(result.appearance).toEqual({ accent: "#3b82f6", theme: "system" });
		expect(result.notchLayoutId).toBeNull();
		expect(result.ai).toEqual({ defaultProvider: null, systemPrompt: "" });
		expect(result.integrations).toEqual({});
		expect(result.startupBehaviour).toEqual({ autoStartSession: false, launchApps: [] });
	});

	it("accepts an explicit accent of null as a deliberate 'no accent' value, distinct from a missing/malformed one", () => {
		const result = parseEnvironmentConfig(JSON.stringify({ appearance: { accent: null } }), {
			accent: "#3b82f6",
		});
		expect(result.appearance.accent).toBeNull();
	});

	it("accepts every documented theme value", () => {
		for (const theme of ["light", "dark", "system"]) {
			expect(parseEnvironmentConfig(JSON.stringify({ appearance: { theme } })).appearance.theme).toBe(theme);
		}
	});

	it("accepts every documented AI provider, and rejects an unknown one", () => {
		for (const provider of AI_PROVIDERS) {
			expect(
				parseEnvironmentConfig(JSON.stringify({ ai: { defaultProvider: provider } })).ai.defaultProvider,
			).toBe(provider);
		}
		expect(
			parseEnvironmentConfig(JSON.stringify({ ai: { defaultProvider: "bogus-provider" } })).ai.defaultProvider,
		).toBeNull();
	});

	it("drops non-boolean entries from integrations but keeps valid boolean ones", () => {
		const result = parseEnvironmentConfig(
			JSON.stringify({ integrations: { calendar: true, email: "yes", slack: 1, notes: false } }),
		);
		expect(result.integrations).toEqual({ calendar: true, notes: false });
	});

	it("filters non-string entries out of startupBehaviour.launchApps and trims strings", () => {
		const result = parseEnvironmentConfig(
			JSON.stringify({ startupBehaviour: { launchApps: ["  notepad.exe  ", 42, null, "code ."] } }),
		);
		expect(result.startupBehaviour.launchApps).toEqual(["notepad.exe", "code ."]);
	});

	it("round-trips a fully-populated config through serialize -> parse unchanged", () => {
		const original = {
			version: 1,
			appearance: { accent: "#7d53de", theme: "dark" },
			notchLayoutId: "layout-42",
			ai: { defaultProvider: "anthropic", systemPrompt: "Be concise." },
			integrations: { calendar: true, email: false },
			startupBehaviour: { autoStartSession: true, launchApps: ["code .", "notepad.exe"] },
		};

		const roundTripped = parseEnvironmentConfig(serializeEnvironmentConfig(original));
		expect(roundTripped).toEqual(original);
	});
});

describe("normalizeEnvironmentConfig", () => {
	it("is equivalent to parsing an already-plain-object document", () => {
		const raw = { notchLayoutId: "abc" };
		expect(normalizeEnvironmentConfig(raw, { accent: "#111111" })).toEqual(
			parseEnvironmentConfig(JSON.stringify(raw), { accent: "#111111" }),
		);
	});

	it("treats a non-object as an empty document rather than throwing", () => {
		expect(() => normalizeEnvironmentConfig("nope")).not.toThrow();
		expect(normalizeEnvironmentConfig("nope")).toEqual(defaultEnvironmentConfig());
	});
});

describe("version upgrade path", () => {
	it("stamps a version-less document (pre-dating this schema) up to CONFIG_VERSION", () => {
		const upgraded = upgradeEnvironmentConfig({ notchLayoutId: "abc" });
		expect(upgraded.version).toBe(CONFIG_VERSION);
		expect(upgraded.notchLayoutId).toBe("abc");
	});

	it("treats an explicit version: 0 the same as a missing version", () => {
		const upgraded = upgradeEnvironmentConfig({ version: 0, notchLayoutId: "xyz" });
		expect(upgraded.version).toBe(CONFIG_VERSION);
		expect(upgraded.notchLayoutId).toBe("xyz");
	});

	it("leaves an already-current-version document's other fields alone", () => {
		const upgraded = upgradeEnvironmentConfig({ version: 1, notchLayoutId: "already-current" });
		expect(upgraded).toEqual({ version: 1, notchLayoutId: "already-current" });
	});

	it("pins a document from a newer, unrecognized future version down to CONFIG_VERSION rather than rejecting it", () => {
		const upgraded = upgradeEnvironmentConfig({ version: 99, notchLayoutId: "from-the-future" });
		expect(upgraded.version).toBe(CONFIG_VERSION);
	});

	it("never loops forever regardless of a malformed/non-numeric version", () => {
		expect(() => upgradeEnvironmentConfig({ version: "not-a-number" })).not.toThrow();
		expect(upgradeEnvironmentConfig({ version: "not-a-number" }).version).toBe(CONFIG_VERSION);
		expect(() => upgradeEnvironmentConfig({ version: -5 })).not.toThrow();
		expect(upgradeEnvironmentConfig({ version: -5 }).version).toBe(CONFIG_VERSION);
	});

	it("end-to-end: a hand-edited version-less document parses successfully and lands on CONFIG_VERSION", () => {
		const legacyLooking = JSON.stringify({ notchLayoutId: "layout-9", ai: { systemPrompt: "hi" } });
		const parsed = parseEnvironmentConfig(legacyLooking);
		expect(parsed.version).toBe(CONFIG_VERSION);
		expect(parsed.notchLayoutId).toBe("layout-9");
		expect(parsed.ai.systemPrompt).toBe("hi");
	});
});

describe("applyConfigPatch", () => {
	it("shallow-merges a single nested field, leaving its siblings untouched", () => {
		const current = defaultEnvironmentConfig({ accent: "#3b82f6" });
		const patched = applyConfigPatch(current, { appearance: { theme: "dark" } });
		expect(patched.appearance).toEqual({ accent: "#3b82f6", theme: "dark" });
	});

	it("leaves sections absent from the patch completely untouched", () => {
		const current = applyConfigPatch(defaultEnvironmentConfig(), {
			ai: { defaultProvider: "anthropic", systemPrompt: "Be terse." },
			startupBehaviour: { autoStartSession: true, launchApps: ["code ."] },
		});

		const patched = applyConfigPatch(current, { appearance: { theme: "dark" } });
		expect(patched.ai).toEqual({ defaultProvider: "anthropic", systemPrompt: "Be terse." });
		expect(patched.startupBehaviour).toEqual({ autoStartSession: true, launchApps: ["code ."] });
	});

	it("replaces notchLayoutId only when the patch actually includes the key (even as null)", () => {
		const current = applyConfigPatch(defaultEnvironmentConfig(), { notchLayoutId: "layout-1" });
		expect(applyConfigPatch(current, {}).notchLayoutId).toBe("layout-1");
		expect(applyConfigPatch(current, { notchLayoutId: null }).notchLayoutId).toBeNull();
		expect(applyConfigPatch(current, { notchLayoutId: "layout-2" }).notchLayoutId).toBe("layout-2");
	});

	it("merges integrations onto the existing map rather than replacing it wholesale", () => {
		const current = applyConfigPatch(defaultEnvironmentConfig(), { integrations: { calendar: true } });
		const patched = applyConfigPatch(current, { integrations: { email: true } });
		expect(patched.integrations).toEqual({ calendar: true, email: true });
	});

	it("re-normalizes the merged result, so an invalid value inside the patch cannot reach storage", () => {
		const current = defaultEnvironmentConfig({ accent: "#3b82f6" });
		const patched = applyConfigPatch(current, { appearance: { theme: "not-a-real-theme" } });
		expect(patched.appearance.theme).toBe("system");
	});

	it("falls back an invalid patched accent to the environment's PRE-patch accent, never to a blank default", () => {
		const current = defaultEnvironmentConfig({ accent: "#7d53de" });
		const patched = applyConfigPatch(current, { appearance: { accent: 12345 } });
		expect(patched.appearance.accent).toBe("#7d53de");
	});

	it("returns the config unchanged for a non-object patch", () => {
		const current = defaultEnvironmentConfig({ accent: "#3b82f6" });
		expect(applyConfigPatch(current, null)).toEqual(current);
		expect(applyConfigPatch(current, "nope")).toEqual(current);
		expect(applyConfigPatch(current, undefined)).toEqual(current);
	});

	it("is idempotent -- applying an empty patch changes nothing", () => {
		const current = applyConfigPatch(defaultEnvironmentConfig({ accent: "#3b82f6" }), {
			ai: { defaultProvider: "google" },
		});
		expect(applyConfigPatch(current, {})).toEqual(current);
	});
});
