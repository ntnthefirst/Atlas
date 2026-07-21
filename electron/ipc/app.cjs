// ---------------------------------------------------------------------------
// App-level IPC handlers (app:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change.
// Covers process/platform info, the launch/file-icon/file-picker trio, and
// the update-check surface (which reads/writes the persisted update
// preferences and talks to GitHub releases).
//
// `platform` (electron/platform/index.cjs) and `compareVersionStrings`
// (electron/services/version.cjs) are required directly, the same way
// sessions.cjs requires `scoped` directly, rather than threaded through
// `deps` -- both are plain imported modules main.cjs never reassigns, so
// there's nothing getter-shaped about them.
//
// `getUpdatePreferences` IS a getter, though, because `updatePreferences` is
// a `let` main.cjs reassigns every time preferences load or save (see
// `loadUpdatePreferences`/`saveUpdatePreferences` there) -- a value capture
// here would freeze it at whatever it was when this module was required,
// long before it's ever loaded from disk.
//
// `saveUpdatePreferences`, `fetchReleases`, and `performInAppUpdate` are
// passed as plain values: each is a `function` declaration in main.cjs that
// is never reassigned, so (unlike `updatePreferences` itself) there is no
// stale-capture risk in holding onto them directly. They stay defined in
// main.cjs -- only the IPC handler registrations that call them moved here.
//
// `isWindows` is likewise a plain value: it's a `const` computed once from
// `process.platform` and never reassigned.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, dialog } = require("electron");
const platform = require("../platform/index.cjs");
const { compareVersionStrings } = require("../services/version.cjs");

function register(ipcMain, deps) {
	const { getUpdatePreferences, saveUpdatePreferences, fetchReleases, performInAppUpdate, isWindows } = deps;

	ipcMain.handle("app:launch", async (_event, command) => {
		if (!command || !command.trim()) {
			throw new Error("Command is required.");
		}
		// WP-0.6: the actual spawn() call now lives behind the platform
		// adapter (electron/platform/win32.cjs). `supported: false` here would
		// mean this build is running on a platform Atlas doesn't support (D10)
		// -- handled explicitly rather than silently reporting success.
		const result = await platform.launch(command);
		if (!result.supported) {
			throw new Error("Launching apps is not supported on this platform.");
		}
		return true;
	});

	ipcMain.handle("app:platform", () => process.platform);

	ipcMain.handle("app:setAccent", (_event, value) => {
		// Relay the accent change to every window so the whole app updates live.
		for (const browserWindow of BrowserWindow.getAllWindows()) {
			if (!browserWindow.isDestroyed()) {
				browserWindow.webContents.send("accent:changed", value);
			}
		}
		return true;
	});

	ipcMain.handle("app:pickFile", async (event) => {
		const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const result = await dialog.showOpenDialog(ownerWindow, {
			properties: ["openFile"],
			filters: isWindows
				? [
						{ name: "Programs", extensions: ["exe", "bat", "cmd"] },
						{ name: "All files", extensions: ["*"] },
					]
				: [{ name: "All files", extensions: ["*"] }],
		});
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return result.filePaths[0];
	});

	ipcMain.handle("app:getFileIcon", async (_event, filePath) => {
		if (!filePath) return null;
		// A quoted path (the common case — paths with spaces, e.g. under
		// "Program Files", get auto-quoted when picked) keeps everything
		// between the quotes intact. An unquoted command may have trailing
		// arguments after the first space, which get dropped.
		const trimmed = filePath.trim();
		const quotedMatch = trimmed.match(/^"([^"]+)"/);
		const target = quotedMatch ? quotedMatch[1] : trimmed.split(" ")[0];
		try {
			const icon = await app.getFileIcon(target, { size: "normal" });
			return icon.isEmpty() ? null : icon.toDataURL();
		} catch {
			return null;
		}
	});

	ipcMain.handle("app:version", () => {
		return app.getVersion();
	});

	ipcMain.handle("app:getUpdatePreferences", () => {
		return getUpdatePreferences();
	});

	ipcMain.handle("app:setUpdatePreferences", (_event, nextPreferences) => {
		return saveUpdatePreferences(nextPreferences);
	});

	ipcMain.handle("app:checkUpdates", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: getUpdatePreferences().includeBeta;
		const localVersion = app.getVersion();

		try {
			const releases = await fetchReleases(includePrerelease);
			const latestRelease = releases[0] ?? null;
			if (!latestRelease) {
				return {
					hasUpdate: false,
					local: localVersion,
					latest: null,
					error: "No published releases available",
				};
			}

			const isOutdated = compareVersionStrings(latestRelease.version, localVersion) > 0;

			return {
				hasUpdate: isOutdated,
				local: localVersion,
				latest: latestRelease.version,
				releaseUrl: latestRelease.url,
				publishedAt: latestRelease.publishedAt,
				downloadUrl: isOutdated ? (latestRelease.installerUrl ?? undefined) : undefined,
			};
		} catch (error) {
			return {
				hasUpdate: false,
				local: localVersion,
				latest: null,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle("app:releaseHistory", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: getUpdatePreferences().includeBeta;

		try {
			const releases = await fetchReleases(includePrerelease);

			return { releases };
		} catch (error) {
			return {
				releases: [],
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle("app:downloadAndInstallUpdate", async (_event, options = {}) => {
		const includePrerelease =
			typeof options?.includePrerelease === "boolean"
				? options.includePrerelease
				: getUpdatePreferences().includeBeta;
		return performInAppUpdate(includePrerelease);
	});
}

module.exports = { register };
