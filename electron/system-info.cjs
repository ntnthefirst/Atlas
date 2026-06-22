const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// CPU load is a delta over time, not an instantaneous reading — os.cpus()
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

function getSystemStats() {
	return { cpuPercent: getCpuLoadPercent(), memoryPercent: getMemoryUsagePercent() };
}

// Lists distinct top-level, visible application windows (not browser tabs —
// one entry per running process that owns a visible window), with the path
// to its executable so the result can double as an app-icon/launch-command
// source. Windows-only: there's no equivalent Win32 call on other platforms.
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

async function listOpenApps() {
	if (process.platform !== "win32") return [];
	try {
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", LIST_WINDOWS_SCRIPT]);
		const value = stdout.trim();
		if (!value) return [];
		const parsed = JSON.parse(value);
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list
			.filter((item) => item && item.name)
			.map((item) => ({ name: item.name, path: item.path || null }));
	} catch {
		return [];
	}
}

module.exports = { getSystemStats, listOpenApps };
