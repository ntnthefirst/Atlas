const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme } = require("electron");

const { AtlasDatabase } = require("./db.cjs");
const { ActivityTracker } = require("./activity-tracker.cjs");

let mainWindow = null;
let miniWindow = null;
let welcomeWindow = null;
let tray = null;
let isQuitting = false;
let db = null;
let tracker = null;

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

function createMainWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
		return mainWindow;
	}

	const iconPath = isDev
		? path.join(__dirname, "..", "src", "assets", "logosmall.png")
		: path.join(__dirname, "..", "dist", "assets", "logosmall.png");

	mainWindow = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 1080,
		minHeight: 700,
		backgroundColor: "#070707",
		icon: iconPath,
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: isWindows
			? {
					color: "#2a2a2a",
					symbolColor: "#e2e2e2",
					height: 49,
				}
			: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL("http://localhost:5173");
	} else {
		mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
	}

	mainWindow.on("close", (event) => {
		if (isQuitting) {
			return;
		}
		const hasActiveSession = Boolean(db && db.getActiveSession());
		if (hasActiveSession || miniWindow) {
			event.preventDefault();
			if (hasActiveSession) {
				createMiniWindow();
			}
			mainWindow.hide();
			ensureTray();
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	applyNativeTheme(
		nativeTheme.themeSource === "system" ? "system" : nativeTheme.shouldUseDarkColors ? "dark" : "light",
	);

	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.close();
	}

	return mainWindow;
}

function createWelcomeWindow() {
	if (welcomeWindow && !welcomeWindow.isDestroyed()) {
		welcomeWindow.show();
		welcomeWindow.focus();
		return welcomeWindow;
	}

	welcomeWindow = new BrowserWindow({
		width: 520,
		height: 760,
		minWidth: 460,
		minHeight: 660,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		title: "Atlas - Welkom",
		backgroundColor: "#070707",
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: isMac,
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		titleBarOverlay: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		welcomeWindow.loadURL("http://localhost:5173?mode=welcome");
	} else {
		welcomeWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
			query: { mode: "welcome" },
		});
	}

	welcomeWindow.on("closed", () => {
		welcomeWindow = null;
	});

	if (miniWindow && !miniWindow.isDestroyed()) {
		miniWindow.destroy();
	}

	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.destroy();
	}

	return welcomeWindow;
}

function hasAnyMaps() {
	return Boolean(db && db.listMaps().length > 0);
}

function openPrimaryWindowByMapState() {
	if (hasAnyMaps()) {
		createMainWindow();
		return;
	}
	createWelcomeWindow();
}

function applyNativeTheme(theme) {
	if (!mainWindow || !isWindows) {
		return;
	}

	if (theme === "system") {
		nativeTheme.themeSource = "system";
		const systemTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
		applyNativeTheme(systemTheme);
		return;
	}

	nativeTheme.themeSource = theme;
	if (theme === "light") {
		mainWindow.setTitleBarOverlay({
			color: "#f7f7f7",
			symbolColor: "#4a4a4a",
			height: 49,
		});
		return;
	}

	mainWindow.setTitleBarOverlay({
		color: "#2a2a2a",
		symbolColor: "#e2e2e2",
		height: 49,
	});
}

nativeTheme.on("updated", () => {
	if (nativeTheme.themeSource === "system") {
		applyNativeTheme("system");
	}
});

function getTrayIcon() {
	const svgPath = isDev
		? path.join(__dirname, "..", "public", "favicon.svg")
		: path.join(__dirname, "..", "dist", "favicon.svg");
	const icon = nativeImage.createFromPath(svgPath);
	if (!icon.isEmpty()) {
		return icon.resize({ width: 16, height: 16 });
	}
	return nativeImage.createFromDataURL(
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z6xQAAAAASUVORK5CYII=",
	);
}

function showMainWindow() {
	if (!hasAnyMaps()) {
		createWelcomeWindow();
		return;
	}

	if (!mainWindow) {
		createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	mainWindow.show();
	mainWindow.focus();
}

function createMiniWindow() {
	if (miniWindow) {
		miniWindow.show();
		miniWindow.focus();
		return miniWindow;
	}

	miniWindow = new BrowserWindow({
		width: 320,
		height: 168,
		minWidth: 290,
		minHeight: 150,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		autoHideMenuBar: true,
		transparent: true,
		backgroundColor: "#00000000",
		icon: isDev
			? path.join(__dirname, "..", "src", "assets", "logosmall.png")
			: path.join(__dirname, "..", "dist", "assets", "logosmall.png"),
		frame: false,
		titleBarStyle: "hidden",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		miniWindow.loadURL("http://localhost:5173?mode=mini");
	} else {
		miniWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
			query: { mode: "mini" },
		});
	}

	miniWindow.on("close", (event) => {
		if (isQuitting) {
			return;
		}

		const hasActiveSession = Boolean(db && db.getActiveSession());
		const canRevealMain = Boolean(mainWindow && !mainWindow.isDestroyed());

		if (!hasActiveSession || canRevealMain) {
			if (canRevealMain && mainWindow.isVisible() === false) {
				showMainWindow();
			}
			return;
		}

		event.preventDefault();
	});

	miniWindow.on("closed", () => {
		miniWindow = null;
	});

	ensureTray();
	return miniWindow;
}

function ensureTray() {
	if (tray) {
		return tray;
	}

	tray = new Tray(getTrayIcon());
	tray.setToolTip("Atlas");
	tray.on("double-click", () => {
		showMainWindow();
	});

	const contextMenu = Menu.buildFromTemplate([
		{ label: "Show Atlas", click: () => showMainWindow() },
		{ label: "Open Mini Window", click: () => createMiniWindow() },
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);
	return tray;
}

function wireIpc() {
	ipcMain.handle("map:list", () => db.listMaps());

	ipcMain.handle("map:create", (_event, name) => {
		if (!name || !name.trim()) {
			throw new Error("Map name is required.");
		}
		const createdMap = db.createMap(name.trim());
		openPrimaryWindowByMapState();
		return createdMap;
	});

	ipcMain.handle("map:rename", (_event, mapId, name) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}
		if (!name || !name.trim()) {
			throw new Error("Map name is required.");
		}
		return db.renameMap(mapId, name.trim());
	});

	ipcMain.handle("map:delete", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}
		const deleted = db.deleteMap(mapId);
		openPrimaryWindowByMapState();
		return deleted;
	});

	ipcMain.handle("session:active", () => db.getActiveSession());

	ipcMain.handle("session:start", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id missing.");
		}

		const session = db.startSession(mapId);
		tracker.setCurrentSession(session.id);
		return session;
	});

	ipcMain.handle("session:pause", (_event, sessionId) => {
		const session = db.pauseSession(sessionId);
		tracker.closeOpenBlockNow(sessionId);
		return session;
	});

	ipcMain.handle("session:resume", (_event, sessionId) => db.resumeSession(sessionId));

	ipcMain.handle("session:stop", (_event, sessionId) => {
		tracker.closeOpenBlockNow(sessionId);
		const session = db.stopSession(sessionId);
		tracker.clearCurrentSession();
		if (miniWindow && !miniWindow.isDestroyed()) {
			miniWindow.close();
		}
		return session;
	});

	ipcMain.handle("session:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listSessionsByMap(mapId);
	});

	ipcMain.handle("activity:listBySession", (_event, sessionId) => {
		if (!sessionId) {
			return [];
		}
		return db.listActivityBlocksBySession(sessionId);
	});

	ipcMain.handle("activity:current-app", () => tracker.getCurrentAppName());

	ipcMain.handle("task:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listTasksByMap(mapId);
	});

	ipcMain.handle("task:create", (_event, mapId, title, description) => {
		if (!mapId || !title || !title.trim()) {
			throw new Error("Task map and title are required.");
		}
		return db.createTask(mapId, title.trim(), (description || "").trim());
	});

	ipcMain.handle("task:updateStatus", (_event, taskId, status) => {
		if (!taskId || !status) {
			throw new Error("Task id and status are required.");
		}
		return db.updateTaskStatus(taskId, status);
	});

	ipcMain.handle("note:listByMap", (_event, mapId) => {
		if (!mapId) {
			return [];
		}
		return db.listNotesByMap(mapId);
	});

	ipcMain.handle("note:create", (_event, mapId, content) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		return db.createNote(mapId, (content || "").trim());
	});

	ipcMain.handle("note:update", (_event, noteId, content) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		return db.updateNote(noteId, content || "");
	});

	ipcMain.handle("note:delete", (_event, noteId) => {
		if (!noteId) {
			throw new Error("Note id is required.");
		}
		db.deleteNote(noteId);
		return true;
	});

	ipcMain.handle("notebook:getByMap", (_event, mapId) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		return db.getNotebookByMap(mapId);
	});

	ipcMain.handle("notebook:updateByMap", (_event, mapId, content) => {
		if (!mapId) {
			throw new Error("Map id is required.");
		}
		if (typeof content !== "string") {
			throw new Error("Notebook content must be a string.");
		}
		return db.updateNotebookByMap(mapId, content);
	});

	ipcMain.handle("dashboard:overview", (_event, mapId) => {
		if (!mapId) {
			return {
				totalTodayMs: 0,
				timePerApp: [],
				timePerMap: [],
				quickStats: { sessionsToday: 0, openTasks: 0 },
			};
		}
		return db.getDashboardOverview(mapId);
	});

	ipcMain.handle("app:launch", (_event, command) => {
		if (!command || !command.trim()) {
			throw new Error("Command is required.");
		}
		spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
		});
		return true;
	});

	ipcMain.handle("window:minimize", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? welcomeWindow;
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.minimize();
		}
		return true;
	});

	ipcMain.handle("app:platform", () => process.platform);

	ipcMain.handle("window:setTheme", (_event, theme) => {
		applyNativeTheme(theme);
		return true;
	});

	ipcMain.handle("window:openMini", () => {
		createMiniWindow();
		return true;
	});

	ipcMain.handle("window:resizeMini", (_event, width, height) => {
		if (!miniWindow || miniWindow.isDestroyed()) {
			return false;
		}

		const safeWidth = Math.max(220, Math.min(900, Math.ceil(Number(width) || 0)));
		const safeHeight = Math.max(40, Math.min(260, Math.ceil(Number(height) || 0)));
		miniWindow.setContentSize(safeWidth, safeHeight);
		return true;
	});

	ipcMain.handle("window:showMain", () => {
		showMainWindow();
		return true;
	});

	ipcMain.handle("window:closeMini", () => {
		if (!miniWindow || miniWindow.isDestroyed()) {
			return false;
		}

		const hasActiveSession = Boolean(db && db.getActiveSession());
		const canRevealMain = Boolean(mainWindow && !mainWindow.isDestroyed());
		if (hasActiveSession && canRevealMain && mainWindow.isVisible() === false) {
			showMainWindow();
		}

		miniWindow.close();
		return true;
	});

	ipcMain.handle("window:toggleMaximize", () => {
		if (!mainWindow) {
			return false;
		}
		if (mainWindow.isMaximized()) {
			mainWindow.unmaximize();
			return false;
		}
		mainWindow.maximize();
		return true;
	});

	ipcMain.handle("window:close", (event) => {
		const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? welcomeWindow;
		if (targetWindow && !targetWindow.isDestroyed()) {
			targetWindow.close();
		}
		return true;
	});
}

app.whenReady().then(async () => {
	const iconPath = isDev
		? path.join(__dirname, "..", "src", "assets", "logosmall.png")
		: path.join(__dirname, "..", "dist", "assets", "logosmall.png");

	const dbPath = path.join(app.getPath("userData"), "atlas.db");
	db = await AtlasDatabase.create(dbPath);
	tracker = new ActivityTracker(db);
	tracker.start();

	const activeSession = db.getActiveSession();
	if (activeSession) {
		tracker.setCurrentSession(activeSession.id);
	}

	// Set app icon for dock and taskbar
	if (isMac) {
		app.dock.setIcon(iconPath);
	} else {
		app.setAppUserModelId("com.atlas.app");
	}

	wireIpc();
	openPrimaryWindowByMapState();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			openPrimaryWindowByMapState();
		} else {
			openPrimaryWindowByMapState();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("before-quit", () => {
	isQuitting = true;
	if (tracker) {
		tracker.stop();
	}
});
