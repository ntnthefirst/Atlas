import { describe, expect, it, vi, afterEach } from "vitest";
import {
	name as providerName,
	matchApps,
	toResult,
	resolveExecuteTarget,
	attachIcons,
	search,
	execute,
	init,
	_setCachedAppsForTest,
	_resetForTest,
} from "./apps-provider.cjs";
import { createLauncherProviderRegistry } from "./index.cjs";

// ---------------------------------------------------------------------------
// The "apps" provider (WP-2.4). Every test here works against an INJECTED
// fixture app list (via _setCachedAppsForTest()) and, where icons are
// involved, an injected FAKE icon extractor -- never real enumeration
// (win32.cjs's listInstalledApps(), a PowerShell spawn) and never Electron's
// real app.getFileIcon. See electron/platform/win32.test.js for the
// enumeration-side pure-logic tests (parseInstalledAppsRawOutput,
// classifyAppId, buildInstalledAppList) this provider builds on.
// ---------------------------------------------------------------------------

afterEach(() => {
	_resetForTest();
});

const CHROME = { name: "Google Chrome", kind: "classic", appId: "C:\\Chrome\\chrome.exe", path: "C:\\Chrome\\chrome.exe" };
const CODE = { name: "Visual Studio Code", kind: "classic", appId: "C:\\VSCode\\Code.exe", path: "C:\\VSCode\\Code.exe" };
const CALCULATOR = { name: "Calculator", kind: "uwp", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", path: null };

describe("apps-provider -- matchApps() (pure)", () => {
	it("returns every app for a blank query", () => {
		expect(matchApps([CHROME, CODE], "")).toEqual([CHROME, CODE]);
	});

	it("filters case-insensitively on name substring", () => {
		expect(matchApps([CHROME, CODE, CALCULATOR], "code")).toEqual([CODE]);
		expect(matchApps([CHROME, CODE, CALCULATOR], "CHROME")).toEqual([CHROME]);
	});

	it("matches a substring anywhere in the name, not just a prefix", () => {
		expect(matchApps([CHROME], "chro")).toEqual([CHROME]);
	});

	it("returns [] when nothing matches", () => {
		expect(matchApps([CHROME, CODE], "nonexistent")).toEqual([]);
	});

	it("caps results at MAX_RESULTS (8)", () => {
		const apps = Array.from({ length: 20 }, (_, i) => ({ name: `App ${i}`, kind: "classic", appId: `C:\\app${i}.exe`, path: `C:\\app${i}.exe` }));
		expect(matchApps(apps, "app")).toHaveLength(8);
	});

	it("tolerates a non-array app list", () => {
		expect(matchApps(undefined, "x")).toEqual([]);
		expect(matchApps(null, "x")).toEqual([]);
	});
});

describe("apps-provider -- toResult() (pure)", () => {
	it("maps a classic app to a launcher result shape", () => {
		expect(toResult(CHROME)).toEqual({
			id: "C:\\Chrome\\chrome.exe",
			kind: "app",
			title: "Google Chrome",
			subtitle: "App",
		});
	});

	it("labels a uwp app's subtitle distinctly", () => {
		expect(toResult(CALCULATOR)).toEqual({
			id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
			kind: "app",
			title: "Calculator",
			subtitle: "App (Store)",
		});
	});
});

describe("apps-provider -- resolveExecuteTarget() (pure)", () => {
	it("resolves a classic app's launch target", () => {
		expect(resolveExecuteTarget(CHROME)).toEqual({ kind: "classic", path: "C:\\Chrome\\chrome.exe", appId: "C:\\Chrome\\chrome.exe" });
	});

	it("resolves a uwp app's launch target with a null path", () => {
		expect(resolveExecuteTarget(CALCULATOR)).toEqual({
			kind: "uwp",
			path: null,
			appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
		});
	});

	it("returns null for a missing app (e.g. no longer in the cache)", () => {
		expect(resolveExecuteTarget(null)).toBeNull();
		expect(resolveExecuteTarget(undefined)).toBeNull();
	});
});

describe("apps-provider -- attachIcons() (icon plumbing, injected extractor)", () => {
	it("attaches an icon for a classic app via the injected extractor", async () => {
		const extractIcon = vi.fn(async () => "data:image/png;base64,FAKE");
		const [result] = await attachIcons([toResult(CHROME)], [CHROME], extractIcon);
		expect(result.icon).toBe("data:image/png;base64,FAKE");
		expect(extractIcon).toHaveBeenCalledWith("C:\\Chrome\\chrome.exe");
	});

	it("never calls the extractor for a uwp app (no filesystem path) -- icon is null", async () => {
		const extractIcon = vi.fn(async () => "data:image/png;base64,SHOULD_NOT_BE_CALLED");
		const [result] = await attachIcons([toResult(CALCULATOR)], [CALCULATOR], extractIcon);
		expect(result.icon).toBeNull();
		expect(extractIcon).not.toHaveBeenCalled();
	});

	it("memoizes by path -- a second app at the same query only extracts once", async () => {
		const extractIcon = vi.fn(async () => "data:image/png;base64,ONE");
		await attachIcons([toResult(CHROME)], [CHROME], extractIcon);
		await attachIcons([toResult(CHROME)], [CHROME], extractIcon);
		expect(extractIcon).toHaveBeenCalledTimes(1);
	});

	it("degrades to icon: null (never throws/rejects) when the extractor itself throws", async () => {
		const extractIcon = vi.fn(async () => {
			throw new Error("icon extraction blew up");
		});
		const [result] = await attachIcons([toResult(CHROME)], [CHROME], extractIcon);
		expect(result.icon).toBeNull();
	});
});

describe("apps-provider -- search() (composition, injected cache + extractor)", () => {
	it("returns matched apps with icons attached", async () => {
		_setCachedAppsForTest([CHROME, CODE, CALCULATOR]);
		const extractIcon = vi.fn(async () => "data:image/png;base64,X");
		const results = await search("code", {}, extractIcon);
		expect(results).toEqual([{ id: "C:\\VSCode\\Code.exe", kind: "app", title: "Visual Studio Code", subtitle: "App", icon: "data:image/png;base64,X" }]);
	});

	it("returns [] before any enumeration has populated the cache", async () => {
		_setCachedAppsForTest([]);
		const results = await search("anything", {}, vi.fn());
		expect(results).toEqual([]);
	});

	it("never scopes by environmentId -- installed apps are a system resource (WP-2.4)", async () => {
		_setCachedAppsForTest([CHROME]);
		const extractIcon = vi.fn(async () => null);
		const resultsEnvA = await search("chrome", { environmentId: "env-a" }, extractIcon);
		const resultsEnvB = await search("chrome", { environmentId: "env-b" }, extractIcon);
		expect(resultsEnvA.map((r) => r.id)).toEqual(resultsEnvB.map((r) => r.id));
	});
});

describe("apps-provider -- execute() (injected cache, fake platform launch)", () => {
	it("reports ok:false for an id no longer in the cache", async () => {
		_setCachedAppsForTest([]);
		const outcome = await execute({ id: "C:\\gone.exe" });
		expect(outcome.ok).toBe(false);
	});

	it("reports ok:false without throwing for a missing/undefined result", async () => {
		_setCachedAppsForTest([CHROME]);
		const outcome = await execute(undefined);
		expect(outcome.ok).toBe(false);
	});
});

describe("apps-provider -- end to end through the registry (namespacing + routing)", () => {
	it("searches, namespaces, and routes execute() back to this provider", async () => {
		_setCachedAppsForTest([CHROME]);
		const registry = createLauncherProviderRegistry();
		registry.registerProvider({
			name: "apps",
			search: (query, context) => search(query, context, async () => null),
			execute,
		});

		const results = await registry.search("chrome", { environmentId: "env-1" });
		const appResult = results.find((r) => r.providerName === "apps");
		expect(appResult).toBeDefined();
		expect(appResult.id).toBe("apps::C:\\Chrome\\chrome.exe");
		expect(appResult.icon).toBeNull();
	});
});

describe("apps-provider -- module shape", () => {
	it("registers under the name 'apps' with search/execute/init", () => {
		expect(providerName).toBe("apps");
		expect(typeof search).toBe("function");
		expect(typeof execute).toBe("function");
		expect(typeof init).toBe("function");
	});
});
