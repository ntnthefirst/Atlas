const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
	listEnvironments: () => ipcRenderer.invoke("environment:list"),
	createEnvironment: (name, options) => ipcRenderer.invoke("environment:create", name, options),
	renameEnvironment: (environmentId, name) => ipcRenderer.invoke("environment:rename", environmentId, name),
	updateEnvironment: (environmentId, fields) => ipcRenderer.invoke("environment:update", environmentId, fields),
	deleteEnvironment: (environmentId) => ipcRenderer.invoke("environment:delete", environmentId),
	// Fire-and-forget: tells the main process which environment the user is now
	// working in, purely so the event log (WP-0.5) can record `environment.switch`.
	notifyEnvironmentSwitch: (environmentId) => ipcRenderer.invoke("environment:switch", environmentId),
	getEnvironmentConfig: (environmentId) => ipcRenderer.invoke("environment:getConfig", environmentId),
	setEnvironmentConfig: (environmentId, patch) => ipcRenderer.invoke("environment:setConfig", environmentId, patch),

	getActiveSession: () => ipcRenderer.invoke("session:active"),
	startSession: (environmentId) => ipcRenderer.invoke("session:start", environmentId),
	pauseSession: (sessionId) => ipcRenderer.invoke("session:pause", sessionId),
	resumeSession: (sessionId) => ipcRenderer.invoke("session:resume", sessionId),
	stopSession: (sessionId) => ipcRenderer.invoke("session:stop", sessionId),
	deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
	listSessionsByEnvironment: (environmentId) => ipcRenderer.invoke("session:listByEnvironment", environmentId),

	listActivityBySession: (sessionId) => ipcRenderer.invoke("activity:listBySession", sessionId),
	getCurrentApp: () => ipcRenderer.invoke("activity:current-app"),

	listTasksByEnvironment: (environmentId) => ipcRenderer.invoke("task:listByEnvironment", environmentId),
	createTask: (environmentId, title, description, fields) =>
		ipcRenderer.invoke("task:create", environmentId, title, description, fields),
	updateTaskStatus: (taskId, status) => ipcRenderer.invoke("task:updateStatus", taskId, status),
	updateTask: (taskId, fields) => ipcRenderer.invoke("task:update", taskId, fields),
	deleteTask: (taskId) => ipcRenderer.invoke("task:delete", taskId),

	listNotesByEnvironment: (environmentId) => ipcRenderer.invoke("note:listByEnvironment", environmentId),
	createNote: (environmentId, content) => ipcRenderer.invoke("note:create", environmentId, content),
	updateNote: (noteId, content) => ipcRenderer.invoke("note:update", noteId, content),
	deleteNote: (noteId) => ipcRenderer.invoke("note:delete", noteId),
	getNotebookByEnvironment: (environmentId) => ipcRenderer.invoke("notebook:getByEnvironment", environmentId),
	updateNotebookByEnvironment: (environmentId, content) =>
		ipcRenderer.invoke("notebook:updateByEnvironment", environmentId, content),

	getDashboardOverview: (environmentId) => ipcRenderer.invoke("dashboard:overview", environmentId),
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
	getFocusState: () => ipcRenderer.invoke("focus:getState"),
	startFocus: (goal) => ipcRenderer.invoke("focus:start", goal),
	pauseFocus: () => ipcRenderer.invoke("focus:pause"),
	resumeFocus: () => ipcRenderer.invoke("focus:resume"),
	skipFocusPhase: () => ipcRenderer.invoke("focus:skip"),
	stopFocus: () => ipcRenderer.invoke("focus:stop"),
	setFocusGoal: (goal) => ipcRenderer.invoke("focus:setGoal", goal),
	setFocusConfig: (patch) => ipcRenderer.invoke("focus:setConfig", patch),
	onFocusStateChanged: (callback) => {
		const listener = (_event, state) => callback(state);
		ipcRenderer.on("focus:state-changed", listener);
		return () => ipcRenderer.removeListener("focus:state-changed", listener);
	},

	resizeNotch: (width, height) => ipcRenderer.invoke("notch:resize", width, height),
	setNotchIgnoreMouse: (ignore) => ipcRenderer.invoke("notch:setIgnoreMouse", ignore),
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
	openNotchInputWindow: (payload) => ipcRenderer.invoke("window:openNotchInput", payload),
	getNotchInputPayload: () => ipcRenderer.invoke("notchInput:getPayload"),
	onNotchInputPayload: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("notchInput:payload", listener);
		return () => ipcRenderer.removeListener("notchInput:payload", listener);
	},
	getAiConfig: () => ipcRenderer.invoke("ai:getConfig"),
	setAiConfig: (patch) => ipcRenderer.invoke("ai:setConfig", patch),
	aiComplete: (args) => ipcRenderer.invoke("ai:complete", args),

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
