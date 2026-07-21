const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const { fetchJson } = require("./http.cjs");
const { compareVersionStrings, normalizeReleaseList } = require("./version.cjs");
const {
	UPDATE_PREFS_FILE,
	defaultUpdatePreferences,
	normalizeUpdatePreferences,
} = require("../config/update-prefs.cjs");

// ---------------------------------------------------------------------------
// Update checking + in-app install, and the persisted update preferences.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Unlike the
// ipc/*.cjs modules, this one needs no deps object: everything it touches
// (`app`, `autoUpdater`, `fs`/`path`, and the other services/config modules
// it requires) is either a stateless Electron API or a module main.cjs never
// reassigns, so there is nothing to thread through from main.cjs's scope.
//
// `updatePreferences` itself is owned here now instead of in main.cjs -- it
// is a `let` this module reassigns on every load/save, exactly as it was a
// `let` main.cjs reassigned before. main.cjs (and ipc/app.cjs, via the deps
// it's handed) reads it only through the exported `getUpdatePreferences()`
// function, which -- like the getter deps used elsewhere in this refactor --
// always returns the current value rather than one captured at require time.
//
// `autoUpdater` is required here AND still separately in main.cjs (which
// keeps `autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit
// = true;` in app.whenReady() -- out of scope for this extraction). That's
// safe: electron-updater's module cache hands back the same singleton either
// way, so both call sites mutate the one real autoUpdater, same as before.
// ---------------------------------------------------------------------------

const GITHUB_OWNER = "ntnthefirst";
const GITHUB_REPO = "Atlas";

let updatePreferences = { ...defaultUpdatePreferences };

function getUpdatePreferences() {
	return updatePreferences;
}

function getUpdatePrefsPath() {
	return path.join(app.getPath("userData"), UPDATE_PREFS_FILE);
}

function loadUpdatePreferences() {
	try {
		const rawContent = fs.readFileSync(getUpdatePrefsPath(), "utf8");
		const parsed = JSON.parse(rawContent);
		updatePreferences = normalizeUpdatePreferences(parsed);
	} catch {
		updatePreferences = { ...defaultUpdatePreferences };
	}

	return updatePreferences;
}

function saveUpdatePreferences(nextValue) {
	updatePreferences = normalizeUpdatePreferences(nextValue);

	try {
		fs.writeFileSync(getUpdatePrefsPath(), JSON.stringify(updatePreferences, null, 2), "utf8");
	} catch {
		// Non-blocking: update checks should still work with in-memory preferences.
	}

	return updatePreferences;
}

async function fetchReleases(includePrerelease) {
	const releaseList = await fetchJson(
		`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
	);
	return normalizeReleaseList(releaseList, includePrerelease);
}

async function checkLatestGitHubVersion(includePrerelease) {
	const localVersion = app.getVersion();

	try {
		const releases = await fetchReleases(includePrerelease);
		const latestRelease = releases[0];
		if (!latestRelease) {
			return;
		}

		if (compareVersionStrings(latestRelease.version, localVersion) > 0) {
			console.log(`[Atlas] New version available: ${latestRelease.tag} (local: v${localVersion}).`);
		}
	} catch {
		console.log("[Atlas] Version check skipped (offline or GitHub unavailable). Continuing startup.");
	}
}

async function performInAppUpdate(includePrerelease) {
	if (!app.isPackaged) {
		return {
			started: false,
			error: "In-app install is only available in packaged builds.",
		};
	}

	try {
		autoUpdater.allowPrerelease = includePrerelease;
		autoUpdater.allowDowngrade = includePrerelease;
		autoUpdater.autoDownload = true;

		const result = await autoUpdater.checkForUpdates();
		if (!result?.downloadPromise) {
			return {
				started: false,
				error: "No update download started.",
			};
		}

		await result.downloadPromise;
		setImmediate(() => {
			autoUpdater.quitAndInstall(false, true);
		});

		return { started: true };
	} catch (error) {
		return {
			started: false,
			error: error instanceof Error ? error.message : "Unknown update error",
		};
	}
}

module.exports = {
	getUpdatePreferences,
	loadUpdatePreferences,
	saveUpdatePreferences,
	fetchReleases,
	checkLatestGitHubVersion,
	performInAppUpdate,
};
