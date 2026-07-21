const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

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

class ActivityTracker {
	// `eventLog` is optional (defaults to null) so this class stays usable
	// wherever it was constructed before the event log existed; when absent,
	// `recordFocus` below is a no-op.
	constructor(db, eventLog = null) {
		this.db = db;
		this.eventLog = eventLog;
		this.intervalId = null;
		this.currentAppName = "Unknown";
		this.currentSessionId = null;
		this.isSessionActive = false;
		this.isTickInProgress = false;
		// Tracks the last process name an `app.focus` event was recorded for, so
		// the event log gets one event per real app switch rather than one per
		// activity_blocks row (which also splits on window-title changes -- see
		// the comment in tick() below).
		this.lastFocusedProcessName = null;
	}

	start() {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(() => {
			this.tick().catch((error) => {
				console.error("Activity tick error:", error);
			});
		}, 1500);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setCurrentSession(sessionId) {
		this.currentSessionId = sessionId;
		this.isSessionActive = true;
		// A new session is a fresh context for the event log even if the
		// foreground app happens to be the same as the previous session's --
		// without this reset, resuming the same app across a session boundary
		// would silently produce zero app.focus events for the new session.
		this.lastFocusedProcessName = null;
	}

	clearCurrentSession() {
		this.currentSessionId = null;
		this.isSessionActive = false;
		this.lastFocusedProcessName = null;
	}

	getCurrentAppName() {
		return this.currentAppName;
	}

	isIgnoredProcess(processName) {
		const value = (processName || "").toLowerCase();
		return value === "powershell" || value === "pwsh" || value === "cmd" || value === "windowsterminal";
	}

	async getForegroundAppInfo() {
		if (process.platform !== "win32") {
			return { processName: "Unknown", label: "Unknown" };
		}

		const { stdout } = await execFileAsync("powershell.exe", [
			"-NoProfile",
			"-Command",
			WINDOWS_FOREGROUND_PROCESS_SCRIPT,
		]);

		const value = stdout.trim();
		if (!value) {
			return { processName: "Unknown", label: "Unknown" };
		}

		try {
			const parsed = JSON.parse(value);
			return {
				processName: parsed?.processName?.trim() || "Unknown",
				label: parsed?.label?.trim() || parsed?.processName?.trim() || "Unknown",
			};
		} catch {
			return { processName: "Unknown", label: value || "Unknown" };
		}
	}

	async tick() {
		// Safeguard: if session is marked as inactive, do not track
		if (!this.isSessionActive || !this.currentSessionId) {
			return;
		}

		// Prevent concurrent tick operations
		if (this.isTickInProgress) {
			return;
		}

		this.isTickInProgress = true;

		try {
			const session = this.db.getSessionById(this.currentSessionId);
			if (!session || !session.is_active || session.is_paused) {
				return;
			}

			const appInfo = await this.getForegroundAppInfo();
			const now = new Date().toISOString();

			if (this.isIgnoredProcess(appInfo.processName)) {
				this.currentAppName = "No tracked app";
				this.db.closeOpenActivityBlock(session.id, now);
				return;
			}

			const appName = appInfo.label;
			this.currentAppName = appName;
			const openBlock = this.db.getOpenActivityBlock(session.id);

			if (!openBlock) {
				this.db.createActivityBlock(session.id, appName, now);
			} else if (openBlock.app_name !== appName) {
				this.db.closeOpenActivityBlock(session.id, now);
				this.db.createActivityBlock(session.id, appName, now);
			}

			this.recordFocusChange(session, appInfo.processName);
		} finally {
			this.isTickInProgress = false;
		}
	}

	// Event-log signal for WP-0.5. Deliberately independent of the
	// activity_blocks bookkeeping above: `appName` there is `appInfo.label`,
	// which prefers the window *title* when one is present (see
	// getForegroundAppInfo), and title content is exactly what the event log
	// must never store. This only ever records `appInfo.processName` -- a
	// coarse app identity (e.g. "chrome", "Code") -- and only when it actually
	// changes, so re-titling the same app's window doesn't spam the log.
	recordFocusChange(session, processName) {
		const name = processName || "Unknown";
		if (name === this.lastFocusedProcessName) {
			return;
		}
		this.lastFocusedProcessName = name;
		this.eventLog?.record("app.focus", {
			environmentId: session.environment_id,
			sessionId: session.id,
			subject: name,
		});
	}

	closeOpenBlockNow(sessionId) {
		this.db.closeOpenActivityBlock(sessionId, new Date().toISOString());
	}
}

module.exports = {
	ActivityTracker,
};
