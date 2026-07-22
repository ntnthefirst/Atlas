// ---------------------------------------------------------------------------
// File index IPC handlers (fileIndex:*) -- WP-2.5.
//
// The Settings surface's whole file-index tab talks to the crawler
// (electron/services/file-index/crawler.cjs) exclusively through this
// module, the same way every other domain's IPC module is a thin wrapper
// around the service/manager main.cjs actually owns.
//
// `crawler` is passed as a plain value, not a getter: main.cjs builds the
// crawler instance ONCE via `createFileIndexCrawler()` (a `const`, never
// reassigned afterward) -- exactly the same reasoning as sessions.cjs's
// `getTracker` being the exception rather than the rule only when the
// underlying binding IS reassigned. `getDb` IS a getter, for the usual
// reason: `db` is a `let` main.cjs reassigns once, well after this module is
// required.
// ---------------------------------------------------------------------------

const { BrowserWindow, dialog } = require("electron");
const { getIndexStats } = require("../services/file-index/store.cjs");

function register(ipcMain, deps) {
	const { crawler, getDb } = deps;

	ipcMain.handle("fileIndex:getPreferences", () => crawler.getPreferences());

	ipcMain.handle("fileIndex:setPreferences", (_event, patch) => crawler.setPreferences(patch || {}));

	ipcMain.handle("fileIndex:startCrawl", () => crawler.startCrawl());

	ipcMain.handle("fileIndex:cancelCrawl", () => crawler.cancelCrawl());

	ipcMain.handle("fileIndex:getStatus", () => crawler.getStatus());

	ipcMain.handle("fileIndex:getStats", () => getIndexStats(getDb()));

	// Folder picker for "add a root" in Settings -- mirrors app:pickFile
	// (electron/ipc/app.cjs) but for a directory instead of a program file.
	ipcMain.handle("fileIndex:pickFolder", async (event) => {
		const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const result = await dialog.showOpenDialog(ownerWindow, { properties: ["openDirectory"] });
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return result.filePaths[0];
	});
}

module.exports = { register };
