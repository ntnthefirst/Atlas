const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const WINDOWS_FOREGROUND_PROCESS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport(\"user32.dll\")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport(\"user32.dll\")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
"@

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  @{ processName = \"Unknown\"; title = \"\"; label = \"Unknown\" } | ConvertTo-Json -Compress
  exit
}

$windowProcessId = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId) | Out-Null

$titleBuffer = New-Object System.Text.StringBuilder 1024
[Win32]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity) | Out-Null
$title = $titleBuffer.ToString().Trim()

try {
	$proc = Get-Process -Id $windowProcessId -ErrorAction Stop
  $processName = if ([string]::IsNullOrWhiteSpace($proc.ProcessName)) { \"Unknown\" } else { $proc.ProcessName }
	$label = if ([string]::IsNullOrWhiteSpace($title)) { $processName } else { $title }
  @{ processName = $processName; title = $title; label = $label } | ConvertTo-Json -Compress
} catch {
  if ([string]::IsNullOrWhiteSpace($title)) {
    @{ processName = \"Unknown\"; title = \"\"; label = \"Unknown\" } | ConvertTo-Json -Compress
  } else {
    @{ processName = \"Unknown\"; title = $title; label = $title } | ConvertTo-Json -Compress
  }
}
`;

class ActivityTracker {
	constructor(db) {
		this.db = db;
		this.intervalId = null;
		this.currentAppName = "Unknown";
		this.currentSessionId = null;
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
	}

	clearCurrentSession() {
		this.currentSessionId = null;
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
		if (!this.currentSessionId) {
			return;
		}

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
			return;
		}

		if (openBlock.app_name !== appName) {
			this.db.closeOpenActivityBlock(session.id, now);
			this.db.createActivityBlock(session.id, appName, now);
		}
	}

	closeOpenBlockNow(sessionId) {
		this.db.closeOpenActivityBlock(sessionId, new Date().toISOString());
	}
}

module.exports = {
	ActivityTracker,
};
