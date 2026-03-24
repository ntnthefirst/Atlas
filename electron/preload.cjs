const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
	listMaps: () => ipcRenderer.invoke("map:list"),
	createMap: (name) => ipcRenderer.invoke("map:create", name),
	renameMap: (mapId, name) => ipcRenderer.invoke("map:rename", mapId, name),
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

	launchApp: (command) => ipcRenderer.invoke("app:launch", command),
	getPlatform: () => ipcRenderer.invoke("app:platform"),
	setNativeTheme: (theme) => ipcRenderer.invoke("window:setTheme", theme),
	getAppVersion: () => ipcRenderer.invoke("app:version"),
	checkForUpdates: () => ipcRenderer.invoke("app:checkUpdates"),

	windowMinimize: () => ipcRenderer.invoke("window:minimize"),
	openMiniWindow: () => ipcRenderer.invoke("window:openMini"),
	resizeMiniWindow: (width, height) => ipcRenderer.invoke("window:resizeMini", width, height),
	showMainWindow: () => ipcRenderer.invoke("window:showMain"),
	closeMiniWindow: () => ipcRenderer.invoke("window:closeMini"),
	windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
	windowClose: () => ipcRenderer.invoke("window:close"),
});
