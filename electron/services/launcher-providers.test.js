import { describe, expect, it } from "vitest";
import { search, execute, STUB_RESULTS } from "./launcher-providers.cjs";

describe("launcher-providers.cjs (WP-2.1 stub)", () => {
	it("returns the full stub list for an empty/blank query", () => {
		expect(search("")).toEqual(STUB_RESULTS);
		expect(search("   ")).toEqual(STUB_RESULTS);
		expect(search()).toEqual(STUB_RESULTS);
	});

	it("filters case-insensitively on title", () => {
		const results = search("SETTINGS");
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("stub-open-settings");
	});

	it("filters case-insensitively on subtitle", () => {
		const results = search("focus");
		expect(results.some((r) => r.id === "stub-start-focus")).toBe(true);
	});

	it("returns an empty array when nothing matches", () => {
		expect(search("xyzzy-no-such-result")).toEqual([]);
	});

	it("never mutates the underlying stub list", () => {
		const results = search("task");
		results.push({ id: "intruder", kind: "action", title: "intruder" });
		expect(STUB_RESULTS.some((r) => r.id === "intruder")).toBe(false);
	});

	it("execute() reports ok:true and echoes the modifier for a known id", () => {
		const result = execute("stub-new-task", { modifier: "mod" });
		expect(result).toEqual({ ok: true, resultId: "stub-new-task", title: "Create a new task", modifier: "mod" });
	});

	it("execute() reports ok:false for an unknown id, without throwing", () => {
		const result = execute("not-a-real-id");
		expect(result.ok).toBe(false);
		expect(result.title).toBeNull();
	});
});
