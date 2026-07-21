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

// New in WP-0.6: no prior implementation existed to move. Enumerates the
// registry's "Programs and Features" uninstall keys -- the same source
// Control Panel itself reads -- across both HKLM views (32- and 64-bit) and
// HKCU (per-user installs). `SystemComponent` entries are filtered out
// because those are shared runtime pieces (VC++ redistributables, driver
// packages) rather than things a user would ever want to launch. Deliberately
// minimal: WP-2.x's app index is where a real ranked, deduplicated,
// icon-aware launcher surface gets built -- this only has to be an honest,
// real list, not a polished one.
const LIST_INSTALLED_APPS_SCRIPT = `
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$results = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object @{Name='name';Expression={$_.DisplayName}}, @{Name='path';Expression={$_.InstallLocation}} |
  Sort-Object name -Unique
$results | ConvertTo-Json -Compress
`;

// Shared by listRunningApps() and listInstalledApps() -- both PowerShell
// scripts emit the same `{ name, path }[]` JSON shape (ConvertTo-Json emits a
// bare object rather than a one-element array when exactly one result comes
// back, hence the Array.isArray normalization).
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

async function listInstalledApps() {
	try {
		const { stdout } = await execFileAsync("powershell.exe", [
			"-NoProfile",
			"-Command",
			LIST_INSTALLED_APPS_SCRIPT,
		]);
		return { supported: true, apps: parseAppListOutput(stdout) };
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

module.exports = {
	PLATFORM,
	getForegroundWindow,
	listRunningApps,
	listInstalledApps,
	getSystemStats,
	launch,
	isIgnoredProcessName,
	// Exported for unit tests (fixture-string parsing, no real process spawn).
	parseForegroundWindowOutput,
	parseAppListOutput,
};
