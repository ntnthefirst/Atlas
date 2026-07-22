// ---------------------------------------------------------------------------
// Windows platform implementation (WP-0.6).
//
// The single place any `powershell.exe` string is allowed to exist in this
// codebase. Every OS-level query Atlas needs -- what's focused, what's
// running, what's installed, how loaded the machine is, launching a program
// -- comes from here. Before this package, three separate files each grew
// their own `execFile("powershell.exe", ...)` call (activity-tracker.cjs,
// system-info.cjs, and a direct `spawn()` in main.cjs); every later
// OS-touching package (the launcher, the app index, the file indexer,
// context detection) would otherwise have grown a fourth, fifth, sixth. This
// file is that logic, moved essentially unchanged -- see the git history of
// activity-tracker.cjs and system-info.cjs for the pre-refactor originals if
// the "why does this script look like that" question ever comes up.
//
// D10 (IMPLEMENTATION-PLAN.md) made this Windows-only for now. Nothing here
// is written to also run on macOS -- when that day comes, a `darwin.cjs`
// sibling implements the same five functions and `index.cjs` picks it up.
// Until then, `unsupported.cjs` covers every other platform honestly.
//
// Every PowerShell script returns JSON on stdout, which is why each of them
// has a small pure parsing function next to it (`parse*Output`) -- those are
// exported and unit-tested with fixture strings, since they're the one part
// of this file that doesn't require an actual Windows process to exercise.
//
// Measured spawn cost (see the throwaway script used for WP-0.6's manual
// verification, run on this dev machine): a single `getForegroundWindow()`
// round-trip through powershell.exe averaged ~734ms over 8 back-to-back
// calls (range ~690-1670ms, the high end being a cold first spawn). The
// tracker polls every 1500ms (activity-tracker.cjs), so this one call alone
// already burns roughly half of every poll interval's budget -- it was
// already meaningful overhead before this refactor and remains exactly that
// overhead after it (this package moves the call, it does not change its
// cost). A native module (e.g. a small N-API addon calling
// GetForegroundWindow directly, which would be sub-millisecond) is worth
// prioritizing before the poll interval is ever tightened further.
// ---------------------------------------------------------------------------

"use strict";

const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PLATFORM = "win32";

// -- getForegroundWindow() ---------------------------------------------------
// Moved unchanged from electron/activity-tracker.cjs.

const WINDOWS_FOREGROUND_PROCESS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
"@

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  @{ processName = "Unknown"; title = ""; label = "Unknown" } | ConvertTo-Json -Compress
  exit
}

$windowProcessId = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId) | Out-Null

$titleBuffer = New-Object System.Text.StringBuilder 1024
[Win32]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity) | Out-Null
$title = $titleBuffer.ToString().Trim()

try {
	$proc = Get-Process -Id $windowProcessId -ErrorAction Stop
  $processName = if ([string]::IsNullOrWhiteSpace($proc.ProcessName)) { "Unknown" } else { $proc.ProcessName }
	$label = if ([string]::IsNullOrWhiteSpace($title)) { $processName } else { $title }
  @{ processName = $processName; title = $title; label = $label } | ConvertTo-Json -Compress
} catch {
  if ([string]::IsNullOrWhiteSpace($title)) {
    @{ processName = "Unknown"; title = ""; label = "Unknown" } | ConvertTo-Json -Compress
  } else {
    @{ processName = "Unknown"; title = $title; label = $title } | ConvertTo-Json -Compress
  }
}
`;

// Pure and exported so it can be unit-tested with fixture stdout strings
// without spawning powershell.exe. Mirrors the pre-WP-0.6 parsing in
// activity-tracker.cjs exactly -- same three branches (empty stdout, valid
// JSON, unparseable JSON), same "Unknown" fallbacks for those Windows-side
// edge cases (a genuinely unidentifiable window is a different situation
// from "this platform isn't supported at all", and is not what D10's
// anti-pattern is about -- see unsupported.cjs).
function parseForegroundWindowOutput(stdout) {
	const value = (stdout || "").trim();
	if (!value) {
		return { supported: true, processName: "Unknown", title: "", label: "Unknown" };
	}

	try {
		const parsed = JSON.parse(value);
		const processName = parsed?.processName?.trim() || "Unknown";
		const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
		return {
			supported: true,
			processName,
			title,
			label: parsed?.label?.trim() || processName,
		};
	} catch {
		return { supported: true, processName: "Unknown", title: "", label: value || "Unknown" };
	}
}

async function getForegroundWindow() {
	const { stdout } = await execFileAsync("powershell.exe", [
		"-NoProfile",
		"-Command",
		WINDOWS_FOREGROUND_PROCESS_SCRIPT,
	]);
	return parseForegroundWindowOutput(stdout);
}

// -- isIgnoredProcessName() --------------------------------------------------
// Not part of the five-method interface (index.cjs), but exposed alongside
// it: *which* process names are "a shell, not a real foreground app" is
// Windows-specific data (macOS's equivalent list is a completely different
// set of process names), while *whether* an ignored process should be
// excluded from activity tracking is Atlas tracking policy that stays in
// activity-tracker.cjs. Keeping the data here means a future darwin.cjs
// supplies its own list rather than the tracker growing an if/else per OS.

const IGNORED_PROCESS_NAMES = new Set(["powershell", "pwsh", "cmd", "windowsterminal"]);

function isIgnoredProcessName(processName) {
	const value = (processName || "").toLowerCase();
	return IGNORED_PROCESS_NAMES.has(value);
}

// -- listRunningApps() / listInstalledApps() ---------------------------------
// Both scripts return the same shape (`{ name, path }[]`), so they share one
// parser.

// Lists distinct top-level, visible application windows (not browser tabs --
// one entry per running process that owns a visible window), with the path
// to its executable so the result can double as an app-icon/launch-command
// source. Moved unchanged from electron/system-info.cjs.
const LIST_WINDOWS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  public static List<uint> ListVisibleProcessIds() {
    var ids = new List<uint>();
    EnumWindows((hWnd, lParam) => {
      if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid != 0 && !ids.Contains(pid)) ids.Add(pid);
      }
      return true;
    }, IntPtr.Zero);
    return ids;
  }
}
"@

$ids = [WinEnum]::ListVisibleProcessIds()
$results = @()
foreach ($id in $ids) {
  try {
    $proc = Get-Process -Id $id -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($proc.ProcessName)) { continue }
    $name = $proc.ProcessName
    if ($name -in @("ApplicationFrameHost", "TextInputHost", "ShellExperienceHost", "SearchHost", "StartMenuExperienceHost", "Atlas")) { continue }
    $path = $null
    try { $path = $proc.Path } catch { $path = $null }
    $results += [PSCustomObject]@{ name = $name; path = $path }
  } catch {}
}
$results | Sort-Object name -Unique | ConvertTo-Json -Compress
`;

// Shared by listRunningApps() -- the PowerShell script above emits the same
// `{ name, path }[]` JSON shape (ConvertTo-Json emits a bare object rather
// than a one-element array when exactly one result comes back, hence the
// Array.isArray normalization).
function parseAppListOutput(stdout) {
	const value = (stdout || "").trim();
	if (!value) {
		return [];
	}
	const parsed = JSON.parse(value);
	const list = Array.isArray(parsed) ? parsed : [parsed];
	return list.filter((item) => item && item.name).map((item) => ({ name: item.name, path: item.path || null }));
}

async function listRunningApps() {
	try {
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", LIST_WINDOWS_SCRIPT]);
		return { supported: true, apps: parseAppListOutput(stdout) };
	} catch {
		// Matches the pre-WP-0.6 behaviour in system-info.cjs: a transient
		// failure (e.g. a process exiting mid-enumeration) yields an empty
		// list, not a thrown error -- this is still a supported platform, the
		// query itself just came up empty.
		return { supported: true, apps: [] };
	}
}

// -- listInstalledApps() -------------------------------------------------
// WP-0.6 shipped a registry-only scrape here. WP-2.4 (the launcher's "apps"
// provider) broadens it to primarily read Get-StartApps -- the very same
// source the Windows Start Menu's own search box reads from, and the
// "cleanest single source" for finding a large majority of what's installed
// in ONE call: it lists every Start Menu shortcut (classic desktop apps) AND
// every installed UWP/Store app, each with an AppID. That AppID is either a
// full filesystem path (almost always to the .lnk shortcut Get-StartApps
// itself is reading) for a classic app, or a "PackageFamilyName!AppId"
// identity that isn't a filesystem path at all for a UWP/Store one -- see
// resolveStartAppPath() below, which tells the two apart, and this file's
// launchInstalledApp() for why that distinction is exactly what deciding HOW
// to launch each one needs.
//
// The pre-existing registry-uninstall-keys scrape still runs alongside it
// (same query, same SystemComponent filter as WP-0.6), purely to catch
// whatever a Start Menu scan alone would miss -- an install that never
// created a Start Menu shortcut. Both sources come back from the SAME
// PowerShell invocation (one spawn, not two -- spawning powershell.exe is the
// expensive part, see this file's header); everything past that -- pulling a
// launchable path out of a registry entry's DisplayIcon, deciding what counts
// as a duplicate, classifying classic vs UWP -- happens in plain, pure JS
// (buildInstalledAppList() below), specifically so that logic is
// unit-testable against fixture arrays without spawning anything real.
const LIST_INSTALLED_APPS_SCRIPT = `
$startApps = Get-StartApps | Select-Object @{Name='name';Expression={$_.Name}}, @{Name='appId';Expression={$_.AppID}}

$uninstallPaths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$registryApps = Get-ItemProperty -Path $uninstallPaths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object @{Name='name';Expression={$_.DisplayName}}, @{Name='displayIcon';Expression={$_.DisplayIcon}}

@{ startApps = @($startApps); registryApps = @($registryApps) } | ConvertTo-Json -Compress -Depth 4
`;

// Pure and exported so it can be unit-tested with fixture stdout strings.
// `ConvertTo-Json` drops the array wrapper for a single-element collection
// (same quirk parseAppListOutput above guards against), so each of
// startApps/registryApps is independently re-wrapped into an array.
function parseInstalledAppsRawOutput(stdout) {
	const value = (stdout || "").trim();
	if (!value) {
		return { startApps: [], registryApps: [] };
	}
	try {
		const parsed = JSON.parse(value);
		const toArray = (maybeArrayOrObject) => {
			if (Array.isArray(maybeArrayOrObject)) return maybeArrayOrObject;
			return maybeArrayOrObject ? [maybeArrayOrObject] : [];
		};
		return { startApps: toArray(parsed?.startApps), registryApps: toArray(parsed?.registryApps) };
	} catch {
		return { startApps: [], registryApps: [] };
	}
}

// A classic app's Get-StartApps AppID is a real filesystem path; a UWP/Store
// app's is a package identity ("PackageFamilyName!AppId") with no such shape.
// Deciding which is which is also, not coincidentally, exactly what
// launchInstalledApp() needs to decide HOW to launch something: a real
// filesystem path gets the "classic" (shell.openPath) treatment; anything
// else falls back to `explorer.exe shell:AppsFolder\<AppID>` (this file's
// own shell:AppsFolder trick) -- the general-purpose launch mechanism for
// ANY AppUserModelID Explorer's virtual Apps folder can resolve, valid for
// every entry Get-StartApps itself produces, not only true UWP packages.
//
// The wrinkle (found by this WP's own real-machine verification --
// scripts/verify-installed-apps.cjs -- not a hypothetical): Get-StartApps
// does NOT always render a classic app's path with a plain drive letter.
// Plenty of ordinary desktop installs come back as e.g.
// "{6D809377-6AF0-444B-8957-A3773F02200E}\7-Zip\7zFM.exe" -- a KNOWNFOLDERID
// GUID (that one is FOLDERID_ProgramFilesX64, i.e. "Program Files") standing
// in for the drive-letter prefix. Left unresolved, every one of these was
// being misclassified as "uwp" -- still launchable (shell:AppsFolder handles
// it), but with no icon and a wrong subtitle, and on this dev machine that
// was the SHAPE MOST desktop apps actually came back in (measured: 212 of
// 251 total apps, before this fix). resolveStartAppPath() below resolves the
// known-folder GUIDs that actually hold installed applications back to a
// real absolute path (via the same environment variables Windows itself
// publishes for each), so those apps get properly classified as classic --
// see this WP's final report for the measured before/after counts.
const KNOWN_FOLDER_PATH_PATTERN = /^\{([0-9a-fA-F-]{36})\}\\(.*)$/;

// Deliberately NOT the full KNOWNFOLDERID list (that runs into the hundreds,
// most of which no application is ever installed under) -- just the handful
// that actually hold installed applications, each mapped to the plain
// environment variable(s) Windows itself sets for that folder (first
// non-empty one wins; e.g. a 32-bit process still gets the real 64-bit
// Program Files path via ProgramW6432).
const KNOWN_FOLDER_ENV_VARS = {
	"6d809377-6af0-444b-8957-a3773f02200e": ["ProgramW6432", "ProgramFiles"], // FOLDERID_ProgramFilesX64
	"7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e": ["ProgramFiles(x86)"], // FOLDERID_ProgramFilesX86
	"905e63b6-c1bf-494e-b29c-65b732d3d21a": ["ProgramFiles"], // FOLDERID_ProgramFiles
	"f7f1ed05-9f6d-47a2-aaae-29d317c6f066": ["CommonProgramW6432", "CommonProgramFiles"], // FOLDERID_ProgramFilesCommonX64
	"de974d24-d9c6-4d3e-bf91-f4455120b917": ["CommonProgramFiles(x86)"], // FOLDERID_ProgramFilesCommonX86
	"6365d5a7-0f0d-45e5-87f6-0da56b6a4f7d": ["CommonProgramFiles"], // FOLDERID_ProgramFilesCommon
	"62ab5d82-fdc1-4dc3-a9dd-070d1d495d97": ["ProgramData", "ALLUSERSPROFILE"], // FOLDERID_ProgramData
	"f38bf404-1d43-42f2-9305-67de0b28fc23": ["SystemRoot", "windir"], // FOLDERID_Windows
};
// FOLDERID_UserProgramFiles (per-user installs, e.g. VS Code/Chrome/Discord
// under %LocalAppData%\Programs) has no plain env var of its own -- it's
// always LOCALAPPDATA + "\Programs", handled as a special case below rather
// than forced into the table above.
const USER_PROGRAM_FILES_GUID = "5cd7aee2-2219-4a67-b85d-6c9ce15660cb";

// Pure and exported so it's unit-testable without depending on this
// process's real environment variables (tests inject their own via
// `env` -- see win32.test.js). Returns a real, absolute, directly-openable
// path for anything recognizable as a filesystem path (plain drive-letter,
// OR a resolvable known-folder-GUID-relative one); `null` for anything else
// (a true UWP PackageFamilyName!AppId, or a known-folder GUID this table
// doesn't cover) -- the signal buildInstalledAppList() uses to classify
// classic vs uwp.
function resolveStartAppPath(appId, env = process.env) {
	if (typeof appId !== "string" || !appId) {
		return null;
	}
	if (/^[a-zA-Z]:\\/.test(appId)) {
		return appId; // already a plain absolute path
	}
	const match = appId.match(KNOWN_FOLDER_PATH_PATTERN);
	if (!match) {
		return null; // not a recognizable file-path shape at all
	}
	const [, guid, relativePath] = match;
	const normalizedGuid = guid.toLowerCase();
	const basePath =
		normalizedGuid === USER_PROGRAM_FILES_GUID
			? env.LOCALAPPDATA
				? `${env.LOCALAPPDATA}\\Programs`
				: null
			: (KNOWN_FOLDER_ENV_VARS[normalizedGuid] || []).map((name) => env[name]).find(Boolean) ?? null;
	return basePath ? `${basePath}\\${relativePath}` : null;
}

function normalizeAppName(name) {
	return typeof name === "string" ? name.trim().toLowerCase() : "";
}

// A registry uninstall entry's DisplayIcon is often "C:\...\app.exe,0" (a
// trailing ",<icon resource index>") or quoted, or simply absent/pointing at
// a bare .dll/.ico with no associated executable. Resolved to a real,
// directly-launchable .exe path when possible; `null` otherwise so a
// registry-only entry with no reliable launch target is left out of the
// merged list entirely rather than shown as a dead result (see
// buildInstalledAppList() below).
function resolveRegistryLaunchPath(displayIcon) {
	if (typeof displayIcon !== "string" || !displayIcon.trim()) {
		return null;
	}
	const withoutIconIndex = displayIcon.trim().replace(/,-?\d+$/, "");
	const unquoted = withoutIconIndex.replace(/^"(.*)"$/, "$1").trim();
	return unquoted.toLowerCase().endsWith(".exe") ? unquoted : null;
}

// Pure merge/dedup/classify pass -- unit-tested directly against fixture
// `startApps`/`registryApps` arrays (parseInstalledAppsRawOutput()'s own
// return shape) and an injected `env`, no PowerShell (or dependency on this
// process's real environment variables) required. Get-StartApps entries
// always win a name collision (registry entries only fill genuine gaps);
// within each source, later duplicates of an already-seen name are dropped
// rather than producing repeat launcher results for the same app.
function buildInstalledAppList(startApps, registryApps, env = process.env) {
	const apps = [];
	const seenNames = new Set();

	for (const entry of Array.isArray(startApps) ? startApps : []) {
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const appId = typeof entry?.appId === "string" ? entry.appId.trim() : "";
		const normalized = normalizeAppName(name);
		if (!name || !appId || seenNames.has(normalized)) {
			continue;
		}
		const resolvedPath = resolveStartAppPath(appId, env);
		apps.push({ name, kind: resolvedPath ? "classic" : "uwp", appId, path: resolvedPath });
		seenNames.add(normalized);
	}

	for (const entry of Array.isArray(registryApps) ? registryApps : []) {
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const normalized = normalizeAppName(name);
		if (!name || seenNames.has(normalized)) {
			continue;
		}
		const launchPath = resolveRegistryLaunchPath(entry?.displayIcon);
		if (!launchPath) {
			continue; // no reliable launch target -- leave it out rather than fabricate one
		}
		apps.push({ name, kind: "classic", appId: launchPath, path: launchPath });
		seenNames.add(normalized);
	}

	return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstalledApps() {
	try {
		const { stdout } = await execFileAsync("powershell.exe", [
			"-NoProfile",
			"-Command",
			LIST_INSTALLED_APPS_SCRIPT,
		]);
		const { startApps, registryApps } = parseInstalledAppsRawOutput(stdout);
		return { supported: true, apps: buildInstalledAppList(startApps, registryApps) };
	} catch {
		return { supported: true, apps: [] };
	}
}

// -- getSystemStats() ---------------------------------------------------------
// Moved unchanged from electron/system-info.cjs. No PowerShell involved --
// `os.cpus()`/`os.totalmem()`/`os.freemem()` are plain Node APIs -- but it
// stays gated behind the same win32/unsupported seam as everything else so
// the interface has one uniform mental model (win32 -> real numbers, anything
// else -> an honest `unsupported`) rather than a partial-support matrix where
// some methods quietly work everywhere and others don't.

// CPU load is a delta over time, not an instantaneous reading -- os.cpus()
// only exposes cumulative tick counters since boot. Keeping the previous
// snapshot at module scope lets each poll (the renderer polls every couple
// of seconds) compute the percentage busy since the last poll.
let previousCpuSnapshot = null;

function snapshotCpuTicks() {
	const cpus = os.cpus();
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		idle += cpu.times.idle;
		for (const value of Object.values(cpu.times)) total += value;
	}
	return { idle, total };
}

function getCpuLoadPercent() {
	const next = snapshotCpuTicks();
	if (!previousCpuSnapshot) {
		previousCpuSnapshot = next;
		return 0;
	}
	const idleDelta = next.idle - previousCpuSnapshot.idle;
	const totalDelta = next.total - previousCpuSnapshot.total;
	previousCpuSnapshot = next;
	if (totalDelta <= 0) return 0;
	return Math.round((1 - idleDelta / totalDelta) * 100);
}

function getMemoryUsagePercent() {
	const total = os.totalmem();
	const free = os.freemem();
	if (total <= 0) return 0;
	return Math.round(((total - free) / total) * 100);
}

async function getSystemStats() {
	return { supported: true, cpuPercent: getCpuLoadPercent(), memoryPercent: getMemoryUsagePercent() };
}

// -- launch() -----------------------------------------------------------------
// Moved unchanged from the `app:launch` handler in main.cjs. `shell: true`
// is what lets callers pass shell built-ins like `start "" "<url>"` (see
// preload.cjs's `launchApp`), not just bare executable paths.

async function launch(command) {
	spawn(command, {
		shell: true,
		detached: true,
		stdio: "ignore",
	});
	return { supported: true, launched: true };
}

// -- launchInstalledApp() -----------------------------------------------------
// WP-2.4: launches one entry from listInstalledApps()'s own `apps` array --
// takes the exact `{ kind, path, appId }` shape those entries carry (see
// buildInstalledAppList() above), so the "apps" launcher provider never has
// to build a shell command string of its own (see this file's header: that's
// exactly the classic Windows-shell-quoting bug source this package exists
// to keep in ONE place).
//
// Classic apps go through Electron's own `shell.openPath` -- a plain string
// handed straight to the OS, no shell involved at all, so a path containing
// spaces (nearly every "Program Files" install) needs no quoting/escaping of
// its own; it also transparently resolves a .lnk shortcut's target, working
// directory, and arguments exactly like double-clicking it in Explorer would.
// `electron` is required lazily (inside the function, not at module scope) so
// that requiring this file outside a real Electron process (e.g. this
// module's own unit tests, which run under plain Node/vitest) never touches
// it -- `require("electron")` outside Electron's own process resolves to a
// plain path STRING, not the module object, and every test that exercises
// this file only does so through its pure parsing/classification functions.
//
// UWP/Store (and any other non-file AppID) apps go through the
// `explorer.exe shell:AppsFolder\<AppID>` trick instead -- Explorer's own
// virtual "Apps" folder, which resolves ANY AppUserModelID to its
// registered launch behaviour. Passed as a single argv entry (not a shell
// string), so -- unlike `launch()` above -- no `shell: true` and no quoting
// question at all.
async function launchInstalledApp(target) {
	if (!target || typeof target !== "object") {
		return { supported: true, launched: false };
	}

	if (target.kind === "uwp") {
		if (!target.appId) {
			return { supported: true, launched: false };
		}
		spawn("explorer.exe", [`shell:AppsFolder\\${target.appId}`], {
			detached: true,
			stdio: "ignore",
		});
		return { supported: true, launched: true };
	}

	if (!target.path) {
		return { supported: true, launched: false };
	}
	try {
		const { shell } = require("electron");
		const openPathError = await shell.openPath(target.path);
		return { supported: true, launched: !openPathError };
	} catch {
		return { supported: true, launched: false };
	}
}

module.exports = {
	PLATFORM,
	getForegroundWindow,
	listRunningApps,
	listInstalledApps,
	getSystemStats,
	launch,
	launchInstalledApp,
	isIgnoredProcessName,
	// Exported for unit tests (fixture-string parsing, no real process spawn).
	parseForegroundWindowOutput,
	parseAppListOutput,
	parseInstalledAppsRawOutput,
	resolveStartAppPath,
	resolveRegistryLaunchPath,
	buildInstalledAppList,
};
