import { describe, expect, it } from "vitest";
import {
	PLATFORM,
	getForegroundWindow,
	listRunningApps,
	listInstalledApps,
	getSystemStats,
	launch,
	isIgnoredProcessName,
} from "./unsupported.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS -- same reasoning as the other electron/**/*.test.js
// suites.
//
// The whole point of this module (WP-0.6 / D10) is that every method returns
// an explicit, honest "I don't know" -- never a value that could be mistaken
// for real data (the pre-WP-0.6 anti-pattern was literally returning the
// string "Unknown" for a non-Windows foreground app, indistinguishable from a
// real window titled "Unknown"). These tests pin that shape down exactly.

describe("unsupported.cjs -- every method reports supported: false, never fabricated data (D10)", () => {
	it("identifies itself", () => {
		expect(PLATFORM).toBe("unsupported");
	});

	it("getForegroundWindow() returns only { supported: false } -- no processName/title/label to mistake for real data", async () => {
		const result = await getForegroundWindow();
		expect(result).toEqual({ supported: false });
		expect(result).not.toHaveProperty("processName");
		expect(result).not.toHaveProperty("label");
	});

	it("listRunningApps() returns an empty list, not a thrown error or fabricated apps", async () => {
		await expect(listRunningApps()).resolves.toEqual({ supported: false, apps: [] });
	});

	it("listInstalledApps() returns an empty list", async () => {
		await expect(listInstalledApps()).resolves.toEqual({ supported: false, apps: [] });
	});

	it("getSystemStats() returns null stats, not zeroed/fabricated numbers that look like a real 0% reading", async () => {
		await expect(getSystemStats()).resolves.toEqual({ supported: false, cpuPercent: null, memoryPercent: null });
	});

	it("launch() never actually spawns anything and reports it didn't", async () => {
		await expect(launch("notepad.exe")).resolves.toEqual({ supported: false, launched: false });
	});

	it("isIgnoredProcessName() has no known shell-name data for a platform with no implementation", () => {
		expect(isIgnoredProcessName("powershell")).toBe(false);
		expect(isIgnoredProcessName("cmd")).toBe(false);
		expect(isIgnoredProcessName(undefined)).toBe(false);
	});
});
