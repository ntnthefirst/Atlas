import { describe, expect, it } from "vitest";
import { parseForegroundWindowOutput, parseAppListOutput, isIgnoredProcessName, PLATFORM } from "./win32.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS -- same reasoning as the other electron/**/*.test.js
// suites.
//
// Deliberately does not exercise getForegroundWindow()/listRunningApps()/
// listInstalledApps()/launch() themselves -- those spawn a real
// powershell.exe process, which isn't something a unit test should do (slow,
// environment-dependent, and the WP-0.6 task explicitly calls out testing
// "what is genuinely testable without spawning PowerShell"). What IS
// testable without spawning anything is the parsing/fallback logic around
// that JSON output, which is exported specifically so fixture strings can
// exercise it here. See the throwaway manual-verification script (deleted
// after use) for proof the real spawn path still works.

describe("win32.cjs -- parseForegroundWindowOutput() (moved unchanged from activity-tracker.cjs)", () => {
	it("parses a well-formed JSON payload with both a process name and a title", () => {
		const stdout = '{"processName":"chrome","title":"My Bank Statement - Chrome","label":"My Bank Statement - Chrome"}';
		expect(parseForegroundWindowOutput(stdout)).toEqual({
			supported: true,
			processName: "chrome",
			title: "My Bank Statement - Chrome",
			label: "My Bank Statement - Chrome",
		});
	});

	it("falls back label to processName when the title (and so label) is empty", () => {
		const stdout = '{"processName":"code","title":"","label":"code"}';
		expect(parseForegroundWindowOutput(stdout)).toEqual({
			supported: true,
			processName: "code",
			title: "",
			label: "code",
		});
	});

	it("returns the Windows-side 'Unknown' fallback for empty stdout (still `supported: true` -- this is Windows being unable to identify a window, not the platform being unsupported)", () => {
		expect(parseForegroundWindowOutput("")).toEqual({
			supported: true,
			processName: "Unknown",
			title: "",
			label: "Unknown",
		});
		expect(parseForegroundWindowOutput("   ")).toEqual({
			supported: true,
			processName: "Unknown",
			title: "",
			label: "Unknown",
		});
	});

	it("falls back to the raw trimmed stdout as the label when JSON parsing fails", () => {
		expect(parseForegroundWindowOutput("not json")).toEqual({
			supported: true,
			processName: "Unknown",
			title: "",
			label: "not json",
		});
	});

	it("falls back processName/label to 'Unknown' when JSON parses but processName is blank", () => {
		const stdout = '{"processName":"","title":"","label":""}';
		expect(parseForegroundWindowOutput(stdout)).toEqual({
			supported: true,
			processName: "Unknown",
			title: "",
			label: "Unknown",
		});
	});

	it("tolerates a title field that isn't a string", () => {
		const stdout = '{"processName":"chrome","title":null,"label":"chrome"}';
		expect(parseForegroundWindowOutput(stdout).title).toBe("");
	});
});

describe("win32.cjs -- parseAppListOutput() (moved unchanged from system-info.cjs, shared with listInstalledApps)", () => {
	it("normalizes a single PowerShell result object (ConvertTo-Json omits the array wrapper for one item)", () => {
		const stdout = '{"name":"chrome","path":"C:\\\\Program Files\\\\Chrome\\\\chrome.exe"}';
		expect(parseAppListOutput(stdout)).toEqual([{ name: "chrome", path: "C:\\Program Files\\Chrome\\chrome.exe" }]);
	});

	it("parses a JSON array of results", () => {
		const stdout = '[{"name":"chrome","path":"C:\\\\chrome.exe"},{"name":"code","path":null}]';
		expect(parseAppListOutput(stdout)).toEqual([
			{ name: "chrome", path: "C:\\chrome.exe" },
			{ name: "code", path: null },
		]);
	});

	it("defaults a missing path to null", () => {
		const stdout = '[{"name":"notepad"}]';
		expect(parseAppListOutput(stdout)).toEqual([{ name: "notepad", path: null }]);
	});

	it("filters out entries with no name", () => {
		const stdout = '[{"name":"chrome","path":null},{"path":"C:\\\\orphan.exe"},{}]';
		expect(parseAppListOutput(stdout)).toEqual([{ name: "chrome", path: null }]);
	});

	it("returns an empty list for empty stdout", () => {
		expect(parseAppListOutput("")).toEqual([]);
		expect(parseAppListOutput("   ")).toEqual([]);
	});
});

describe("win32.cjs -- isIgnoredProcessName() (moved from activity-tracker.cjs's isIgnoredProcess)", () => {
	it("ignores known Windows shell/terminal process names", () => {
		expect(isIgnoredProcessName("powershell")).toBe(true);
		expect(isIgnoredProcessName("pwsh")).toBe(true);
		expect(isIgnoredProcessName("cmd")).toBe(true);
		expect(isIgnoredProcessName("windowsterminal")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isIgnoredProcessName("PowerShell")).toBe(true);
		expect(isIgnoredProcessName("CMD")).toBe(true);
	});

	it("does not ignore a real application process", () => {
		expect(isIgnoredProcessName("chrome")).toBe(false);
		expect(isIgnoredProcessName("code")).toBe(false);
	});

	it("does not ignore null/undefined/empty input", () => {
		expect(isIgnoredProcessName(null)).toBe(false);
		expect(isIgnoredProcessName(undefined)).toBe(false);
		expect(isIgnoredProcessName("")).toBe(false);
	});
});

describe("win32.cjs -- module shape", () => {
	it("identifies itself as the win32 implementation", () => {
		expect(PLATFORM).toBe("win32");
	});
});
