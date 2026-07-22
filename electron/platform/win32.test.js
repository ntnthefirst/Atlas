import { describe, expect, it } from "vitest";
import {
	parseForegroundWindowOutput,
	parseAppListOutput,
	parseInstalledAppsRawOutput,
	resolveStartAppPath,
	resolveRegistryLaunchPath,
	buildInstalledAppList,
	isIgnoredProcessName,
	PLATFORM,
} from "./win32.cjs";

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

describe("win32.cjs -- parseInstalledAppsRawOutput() (WP-2.4)", () => {
	it("parses the combined startApps/registryApps payload", () => {
		const stdout = JSON.stringify({
			startApps: [{ name: "Notepad++", appId: "C:\\Start Menu\\Notepad++.lnk" }],
			registryApps: [{ name: "7-Zip", displayIcon: "C:\\Program Files\\7-Zip\\7zFM.exe" }],
		});
		expect(parseInstalledAppsRawOutput(stdout)).toEqual({
			startApps: [{ name: "Notepad++", appId: "C:\\Start Menu\\Notepad++.lnk" }],
			registryApps: [{ name: "7-Zip", displayIcon: "C:\\Program Files\\7-Zip\\7zFM.exe" }],
		});
	});

	it("re-wraps a single-element source that PowerShell unwrapped to a bare object", () => {
		const stdout = JSON.stringify({ startApps: { name: "Calculator", appId: "Microsoft.WindowsCalculator!App" }, registryApps: null });
		expect(parseInstalledAppsRawOutput(stdout)).toEqual({
			startApps: [{ name: "Calculator", appId: "Microsoft.WindowsCalculator!App" }],
			registryApps: [],
		});
	});

	it("returns empty arrays for empty stdout or unparsable JSON", () => {
		expect(parseInstalledAppsRawOutput("")).toEqual({ startApps: [], registryApps: [] });
		expect(parseInstalledAppsRawOutput("   ")).toEqual({ startApps: [], registryApps: [] });
		expect(parseInstalledAppsRawOutput("not json")).toEqual({ startApps: [], registryApps: [] });
	});
});

describe("win32.cjs -- resolveStartAppPath() (WP-2.4)", () => {
	it("returns a plain drive-letter path unchanged (the straightforward classic-app shape)", () => {
		expect(resolveStartAppPath("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad++.lnk")).toBe(
			"C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad++.lnk",
		);
		expect(resolveStartAppPath("D:\\Games\\thing.exe")).toBe("D:\\Games\\thing.exe");
	});

	it("returns null for a PackageFamilyName!AppId identity (a true UWP app)", () => {
		expect(resolveStartAppPath("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).toBeNull();
	});

	it("returns null for anything that isn't a real path (e.g. a bare shell AppUserModelID)", () => {
		expect(resolveStartAppPath("Microsoft.Windows.ControlPanel")).toBeNull();
	});

	it("returns null for non-string/missing/empty input rather than throwing", () => {
		expect(resolveStartAppPath(null)).toBeNull();
		expect(resolveStartAppPath(undefined)).toBeNull();
		expect(resolveStartAppPath("")).toBeNull();
	});

	// The wrinkle this WP's own real-machine verification (scripts/
	// verify-installed-apps.cjs) turned up: Get-StartApps often renders a
	// perfectly ordinary classic app's path relative to a KNOWNFOLDERID GUID
	// instead of a plain drive letter (e.g. FOLDERID_ProgramFilesX64,
	// "{6D809377-6AF0-444B-8957-A3773F02200E}", for "Program Files"). An
	// injected fake `env` (rather than this process's real environment
	// variables) keeps these tests deterministic across machines.
	it("resolves a FOLDERID_ProgramFilesX64-relative AppID via ProgramW6432", () => {
		const env = { ProgramW6432: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };
		expect(resolveStartAppPath("{6D809377-6AF0-444B-8957-A3773F02200E}\\7-Zip\\7zFM.exe", env)).toBe(
			"C:\\Program Files\\7-Zip\\7zFM.exe",
		);
	});

	it("resolves a FOLDERID_ProgramFilesX86-relative AppID via ProgramFiles(x86)", () => {
		const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)" };
		expect(resolveStartAppPath("{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Widget\\widget.exe", env)).toBe(
			"C:\\Program Files (x86)\\Widget\\widget.exe",
		);
	});

	it("falls back from ProgramW6432 to ProgramFiles when the former is unset (e.g. a 32-bit process)", () => {
		const env = { ProgramFiles: "C:\\Program Files" };
		expect(resolveStartAppPath("{6D809377-6AF0-444B-8957-A3773F02200E}\\App\\app.exe", env)).toBe("C:\\Program Files\\App\\app.exe");
	});

	it("resolves FOLDERID_UserProgramFiles via LOCALAPPDATA\\Programs (the per-user install location)", () => {
		const env = { LOCALAPPDATA: "C:\\Users\\nat\\AppData\\Local" };
		expect(resolveStartAppPath("{5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}\\Discord\\Discord.exe", env)).toBe(
			"C:\\Users\\nat\\AppData\\Local\\Programs\\Discord\\Discord.exe",
		);
	});

	it("is case-insensitive when matching the GUID", () => {
		const env = { ProgramFiles: "C:\\Program Files" };
		expect(resolveStartAppPath("{905e63b6-c1bf-494e-b29c-65b732d3d21a}\\App\\app.exe", env)).toBe("C:\\Program Files\\App\\app.exe");
	});

	it("returns null for a known-folder-shaped AppID whose GUID isn't in the table", () => {
		expect(resolveStartAppPath("{00000000-0000-0000-0000-000000000000}\\Some\\app.exe", {})).toBeNull();
	});

	it("returns null when the mapped env var(s) are all unset", () => {
		expect(resolveStartAppPath("{6D809377-6AF0-444B-8957-A3773F02200E}\\App\\app.exe", {})).toBeNull();
	});
});

describe("win32.cjs -- resolveRegistryLaunchPath() (WP-2.4)", () => {
	it("resolves a plain .exe DisplayIcon", () => {
		expect(resolveRegistryLaunchPath("C:\\Program Files\\7-Zip\\7zFM.exe")).toBe("C:\\Program Files\\7-Zip\\7zFM.exe");
	});

	it("strips a trailing icon-resource-index suffix", () => {
		expect(resolveRegistryLaunchPath("C:\\Program Files\\App\\app.exe,0")).toBe("C:\\Program Files\\App\\app.exe");
		expect(resolveRegistryLaunchPath("C:\\Program Files\\App\\app.exe,-1")).toBe("C:\\Program Files\\App\\app.exe");
	});

	it("strips surrounding quotes", () => {
		expect(resolveRegistryLaunchPath('"C:\\Program Files\\App\\app.exe"')).toBe("C:\\Program Files\\App\\app.exe");
	});

	it("returns null for a non-.exe icon target (e.g. a bare .dll or .ico with no associated executable)", () => {
		expect(resolveRegistryLaunchPath("C:\\Windows\\System32\\shell32.dll,42")).toBeNull();
	});

	it("returns null for missing/blank input", () => {
		expect(resolveRegistryLaunchPath(null)).toBeNull();
		expect(resolveRegistryLaunchPath("")).toBeNull();
		expect(resolveRegistryLaunchPath("   ")).toBeNull();
	});
});

describe("win32.cjs -- buildInstalledAppList() (WP-2.4)", () => {
	it("classifies Start Apps entries by their AppID shape", () => {
		const apps = buildInstalledAppList(
			[
				{ name: "Notepad++", appId: "C:\\Start Menu\\Notepad++.lnk" },
				{ name: "Calculator", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
			],
			[],
		);
		expect(apps).toEqual([
			{ name: "Calculator", kind: "uwp", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", path: null },
			{ name: "Notepad++", kind: "classic", appId: "C:\\Start Menu\\Notepad++.lnk", path: "C:\\Start Menu\\Notepad++.lnk" },
		]);
	});

	it("adds a registry-only app that has a resolvable launch path", () => {
		const apps = buildInstalledAppList([], [{ name: "7-Zip", displayIcon: "C:\\Program Files\\7-Zip\\7zFM.exe,0" }]);
		expect(apps).toEqual([{ name: "7-Zip", kind: "classic", appId: "C:\\Program Files\\7-Zip\\7zFM.exe", path: "C:\\Program Files\\7-Zip\\7zFM.exe" }]);
	});

	it("drops a registry-only app with no resolvable launch path rather than fabricating one", () => {
		const apps = buildInstalledAppList([], [{ name: "Some Runtime", displayIcon: null }]);
		expect(apps).toEqual([]);
	});

	it("prefers the Start Apps entry over a registry entry with the same name (case-insensitive)", () => {
		const apps = buildInstalledAppList(
			[{ name: "7-Zip", appId: "C:\\Start Menu\\7-Zip.lnk" }],
			[{ name: "7-ZIP", displayIcon: "C:\\Program Files\\7-Zip\\7zFM.exe" }],
		);
		expect(apps).toEqual([{ name: "7-Zip", kind: "classic", appId: "C:\\Start Menu\\7-Zip.lnk", path: "C:\\Start Menu\\7-Zip.lnk" }]);
	});

	it("dedupes duplicate names within the Start Apps list itself", () => {
		const apps = buildInstalledAppList(
			[
				{ name: "Steam", appId: "C:\\Start Menu\\Steam.lnk" },
				{ name: "steam", appId: "C:\\Some\\Other\\Path.lnk" },
			],
			[],
		);
		expect(apps).toHaveLength(1);
		expect(apps[0].appId).toBe("C:\\Start Menu\\Steam.lnk");
	});

	it("skips entries with no name or no AppID", () => {
		const apps = buildInstalledAppList([{ name: "", appId: "C:\\x.lnk" }, { name: "No AppId" }], []);
		expect(apps).toEqual([]);
	});

	it("sorts the merged list alphabetically by name", () => {
		const apps = buildInstalledAppList(
			[
				{ name: "Zebra App", appId: "C:\\z.lnk" },
				{ name: "Alpha App", appId: "C:\\a.lnk" },
			],
			[],
		);
		expect(apps.map((app) => app.name)).toEqual(["Alpha App", "Zebra App"]);
	});

	it("returns an empty list for empty/missing input", () => {
		expect(buildInstalledAppList([], [])).toEqual([]);
		expect(buildInstalledAppList(undefined, undefined)).toEqual([]);
	});

	it("classifies a KNOWNFOLDERID-GUID-relative Start App as classic once resolvable via the injected env", () => {
		const env = { ProgramW6432: "C:\\Program Files" };
		const apps = buildInstalledAppList([{ name: "7-Zip File Manager", appId: "{6D809377-6AF0-444B-8957-A3773F02200E}\\7-Zip\\7zFM.exe" }], [], env);
		expect(apps).toEqual([
			{
				name: "7-Zip File Manager",
				kind: "classic",
				appId: "{6D809377-6AF0-444B-8957-A3773F02200E}\\7-Zip\\7zFM.exe",
				path: "C:\\Program Files\\7-Zip\\7zFM.exe",
			},
		]);
	});

	it("falls back to uwp for a KNOWNFOLDERID-GUID-relative Start App when the env can't resolve it", () => {
		const apps = buildInstalledAppList([{ name: "Mystery App", appId: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Mystery\\app.exe" }], [], {});
		expect(apps).toEqual([{ name: "Mystery App", kind: "uwp", appId: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Mystery\\app.exe", path: null }]);
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
