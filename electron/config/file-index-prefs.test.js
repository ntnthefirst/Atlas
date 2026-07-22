import { describe, expect, it } from "vitest";
import {
	DEFAULT_EXCLUSIONS,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_FILES,
	DEFAULT_ROOT_IDS,
	defaultFileIndexPreferences,
	defaultRoots,
	normalizeFileIndexPreferences,
} from "./file-index-prefs.cjs";

const HOME = "C:\\Users\\tester";

describe("file-index-prefs", () => {
	it("defaultRoots() seeds Desktop/Documents/Downloads under the given home dir with stable ids", () => {
		const roots = defaultRoots(HOME);
		expect(roots.map((root) => root.id)).toEqual([
			DEFAULT_ROOT_IDS.desktop,
			DEFAULT_ROOT_IDS.documents,
			DEFAULT_ROOT_IDS.downloads,
		]);
		expect(roots.every((root) => root.path.startsWith(HOME))).toBe(true);
		expect(roots.every((root) => root.environmentId === null && root.enabled === true)).toBe(true);
	});

	it("defaultFileIndexPreferences() carries the default exclusion list and caps", () => {
		const prefs = defaultFileIndexPreferences(HOME);
		expect(prefs.exclusions).toEqual([...DEFAULT_EXCLUSIONS]);
		expect(prefs.maxDepth).toBe(DEFAULT_MAX_DEPTH);
		expect(prefs.maxFiles).toBe(DEFAULT_MAX_FILES);
	});

	it("normalizeFileIndexPreferences(null) falls back to full defaults", () => {
		const prefs = normalizeFileIndexPreferences(null, { homeDir: HOME });
		expect(prefs).toEqual(defaultFileIndexPreferences(HOME));
	});

	it("normalizes a well-formed custom root, preserving its id/environmentId/enabled", () => {
		const prefs = normalizeFileIndexPreferences(
			{
				roots: [{ id: "custom:1", label: "Projects", path: "D:\\Projects", environmentId: "env-1", enabled: false }],
				exclusions: ["node_modules"],
				maxDepth: 5,
				maxFiles: 5000,
			},
			{ homeDir: HOME },
		);
		expect(prefs.roots).toEqual([
			{ id: "custom:1", label: "Projects", path: "D:\\Projects", environmentId: "env-1", enabled: false },
		]);
		expect(prefs.exclusions).toEqual(["node_modules"]);
		expect(prefs.maxDepth).toBe(5);
		expect(prefs.maxFiles).toBe(5000);
	});

	it("drops a root with a missing/blank path instead of crashing", () => {
		const prefs = normalizeFileIndexPreferences(
			{ roots: [{ id: "bad" }, { path: "   " }, { path: "D:\\ok" }] },
			{ homeDir: HOME },
		);
		expect(prefs.roots).toHaveLength(1);
		expect(prefs.roots[0].path).toBe("D:\\ok");
	});

	it("drops a root whose id collides with an earlier one in the same list", () => {
		const prefs = normalizeFileIndexPreferences(
			{
				roots: [
					{ id: "dup", path: "D:\\a" },
					{ id: "dup", path: "D:\\b" },
				],
			},
			{ homeDir: HOME },
		);
		expect(prefs.roots).toHaveLength(1);
		expect(prefs.roots[0].path).toBe("D:\\a");
	});

	it("falls back to the full default exclusion list when the stored list is empty", () => {
		const prefs = normalizeFileIndexPreferences({ roots: [], exclusions: [] }, { homeDir: HOME });
		expect(prefs.exclusions).toEqual([...DEFAULT_EXCLUSIONS]);
	});

	it("preserves a user-narrowed exclusion list rather than re-adding removed defaults", () => {
		const prefs = normalizeFileIndexPreferences({ roots: [], exclusions: ["node_modules"] }, { homeDir: HOME });
		expect(prefs.exclusions).toEqual(["node_modules"]);
	});

	it("clamps maxDepth/maxFiles into their valid ranges rather than accepting garbage", () => {
		const prefs = normalizeFileIndexPreferences({ roots: [], maxDepth: -5, maxFiles: 999_999_999 }, { homeDir: HOME });
		expect(prefs.maxDepth).toBeGreaterThanOrEqual(1);
		expect(prefs.maxFiles).toBeLessThanOrEqual(2_000_000);
	});

	it("normalizes environmentId '' / whitespace to null (global)", () => {
		const prefs = normalizeFileIndexPreferences(
			{ roots: [{ path: "D:\\a", environmentId: "   " }] },
			{ homeDir: HOME },
		);
		expect(prefs.roots[0].environmentId).toBeNull();
	});
});
