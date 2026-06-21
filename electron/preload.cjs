const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
	listMaps: () => ipcRenderer.invoke("map:list"),
	createMap: (name, options) => ipcRenderer.invoke("map:create", name, options),
	renameMap: (mapId, name) => ipcRenderer.invoke("map:rename", mapId, name),
	updateMap: (mapId, fields) => ipcRenderer.invoke("map:update", mapId, fields),
	deleteMap: (mapId) => ipcRenderer.invoke("map:delete", mapId),

	getActiveSession: () => ipcRenderer.invoke("session:active"),
	startSession: (mapId) => ipcRenderer.invoke("session:start", mapId),
	pauseSession: (sessionId) => ipcRenderer.invoke("session:pause", sessionId),
	resumeSession: (sessionId) => ipcRenderer.invoke("session:resume", sessionId),
	stopSession: (sessionId) => ipcRenderer.invoke("session:stop", sessionId),
	deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
	listSessionsByMap: (mapId) => ipcRenderer.invoke("session:listByMap", mapId),

	listActivityBySession: (sessionId) => ipcRenderer.invoke("activity:listBySession", sessionId),
	getCurrentApp: () => ipcRenderer.invoke("activity:current-app"),

	listTasksByMap: (mapId) => ipcRenderer.invoke("task:listByMap", mapId),
	createTask: (mapId, title, description) => ipcRenderer.invoke("task:create", mapId, title, description),
	updateTaskStatus: (taskId, status) => ipcRenderer.invoke("task:updateStatus", taskId, status),

	listNotesByMap: (mapId) => ipcRenderer.invoke("note:listByMap", mapId),
	createNote: (mapId, content) => ipcRenderer.invoke("note:create", mapId, content),
	updateNote: (noteId, content) => ipcRenderer.invoke("note:update", noteId, content),
	deleteNote: (noteId) => ipcRenderer.invoke("note:delete", noteId),
	getNotebookByMap: (mapId) => ipcRenderer.invoke("notebook:getByMap", mapId),
	updateNotebookByMap: (mapId, content) => ipcRenderer.invoke("notebook:updateByMap", mapId, content),

	getDashboardOverview: (mapId) => ipcRenderer.invoke("dashboard:overview", mapId),
	repairCorruptedSessions: () => ipcRenderer.invoke("data:repairCorruptedSessions"),

	launchApp: (command) => ipcRenderer.invoke("app:launch", command),
	getPlatform: () => ipcRenderer.invoke("app:platform"),
	setNativeTheme: (theme) => ipcRenderer.invoke("window:setTheme", theme),
	setAccent: (value) => ipcRenderer.invoke("app:setAccent", value),
	onAccentChanged: (callback) => {
		const listener = (_event, value) => callback(value);
		ipcRenderer.on("accent:changed", listener);
		return () => ipcRenderer.removeListener("accent:changed", listener);
	},
	getAppVersion: () => ipcRenderer.invoke("app:version"),
	checkForUpdates: (options) => ipcRenderer.invoke("app:checkUpdates", options),
	listReleaseHistory: (options) => ipcRenderer.invoke("app:releaseHistory", options),
	getUpdatePreferences: () => ipcRenderer.invoke("app:getUpdatePreferences"),
	setUpdatePreferences: (preferences) => ipcRenderer.invoke("app:setUpdatePreferences", preferences),
	downloadAndInstallUpdate: (options) => ipcRenderer.invoke("app:downloadAndInstallUpdate", options),

	getNotchPreferences: () => ipcRenderer.invoke("notch:getPreferences"),
	setNotchPreferences: (preferences) => ipcRenderer.invoke("notch:setPreferences", preferences),

	getDashboardLayout: () => ipcRenderer.invoke("dashboard:getLayout"),
	setDashboardLayout: (preferences) => ipcRenderer.invoke("dashboard:setLayout", preferences),
	onDashboardLayoutChanged: (callback) => {
		const listener = (_event, preferences) => callback(preferences);
		ipcRenderer.on("dashboard:layout-changed", listener);
		return () => ipcRenderer.removeListener("dashboard:layout-changed", listener);
	},
	resizeNotch: (width, height) => ipcRenderer.invoke("notch:resize", width, height),
	onNotchPreferencesChanged: (callback) => {
		const listener = (_event, preferences) => callback(preferences);
		ipcRenderer.on("notch:preferences-changed", listener);
		return () => ipcRenderer.removeListener("notch:preferences-changed", listener);
	},
	onNotchBlur: (callback) => {
		const listener = () => callback();
		ipcRenderer.on("notch:blur", listener);
		return () => ipcRenderer.removeListener("notch:blur", listener);
	},
	listDisplays: () => ipcRenderer.invoke("screen:listDisplays"),

	windowMinimize: () => ipcRenderer.invoke("window:minimize"),
	openMiniWindow: () => ipcRenderer.invoke("window:openMini"),
	openSettingsWindow: () => ipcRenderer.invoke("window:openSettings"),
	openActionEditorWindow: () => ipcRenderer.invoke("window:openActionEditor"),
	pickAppFile: () => ipcRenderer.invoke("app:pickFile"),
	getFileIcon: (filePath) => ipcRenderer.invoke("app:getFileIcon", filePath),
	listOpenApps: () => ipcRenderer.invoke("system:listOpenApps"),
	getSystemStats: () => ipcRenderer.invoke("system:getStats"),
	resizeMiniWindow: (width, height) => ipcRenderer.invoke("window:resizeMini", width, height),
	showMainWindow: () => ipcRenderer.invoke("window:showMain"),
	focusMainIfOpen: () => ipcRenderer.invoke("window:focusMainIfOpen"),
	requestNavigate: (view) => ipcRenderer.invoke("window:navigate", view),
	onNavigate: (callback) => {
		const listener = (_event, view) => callback(view);
		ipcRenderer.on("window:navigate-changed", listener);
		return () => ipcRenderer.removeListener("window:navigate-changed", listener);
	},
	closeMiniWindow: () => ipcRenderer.invoke("window:closeMini"),
	windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
	windowClose: () => ipcRenderer.invoke("window:close"),
});
