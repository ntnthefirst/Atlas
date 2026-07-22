const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
	listEnvironments: () => ipcRenderer.invoke("environment:list"),
	createEnvironment: (name, options) => ipcRenderer.invoke("environment:create", name, options),
	renameEnvironment: (environmentId, name) => ipcRenderer.invoke("environment:rename", environmentId, name),
	updateEnvironment: (environmentId, fields) => ipcRenderer.invoke("environment:update", environmentId, fields),
	deleteEnvironment: (environmentId) => ipcRenderer.invoke("environment:delete", environmentId),
	// WP-1.5: the full environment lifecycle beyond create/rename/update/
	// delete above. Archiving hides an environment from switching surfaces
	// while keeping every row it owns untouched (never a soft delete) --
	// see electron/db.cjs#archiveEnvironment/unarchiveEnvironment for the
	// guards (an active session in it, or it being the last visible one).
	archiveEnvironment: (environmentId) => ipcRenderer.invoke("environment:archive", environmentId),
	unarchiveEnvironment: (environmentId) => ipcRenderer.invoke("environment:unarchive", environmentId),
	listArchivedEnvironments: () => ipcRenderer.invoke("environment:listArchived"),
	// Real per-category counts (tasks/sessions/notes/activity blocks/events/
	// whether it has its own Notch layout) for the delete confirmation dialog
	// -- see db.cjs#getEnvironmentContentCounts.
	getEnvironmentContentCounts: (environmentId) => ipcRenderer.invoke("environment:getContentCounts", environmentId),
	// Copies an environment's config + Notch layout (never its content) into
	// a brand new environment -- see db.cjs#duplicateEnvironment. `name` is
	// optional.
	duplicateEnvironment: (environmentId, name) => ipcRenderer.invoke("environment:duplicate", environmentId, name),
	// Tells the main process which environment the user is now working in.
	// Records `environment.switch` in the event log (WP-0.5) and, as of
	// WP-1.4, is also what makes the switch atomic and live everywhere: the
	// resolved promise carries the target environment's whole
	// appearance/AI/notch bundle, and main.cjs separately broadcasts the same
	// bundle to every window via `environment:activated` below.
	notifyEnvironmentSwitch: (environmentId) => ipcRenderer.invoke("environment:switch", environmentId),
	// WP-1.4: fires in every window whenever ANY surface (the Notch, the main
	// app's own switcher, or the global hotkey's switcher) switches the active
	// environment -- see main.cjs's setActiveEnvironment.
	onEnvironmentActivated: (callback) => {
		const listener = (_event, bundle) => callback(bundle);
		ipcRenderer.on("environment:activated", listener);
		return () => ipcRenderer.removeListener("environment:activated", listener);
	},
	// WP-1.4: the global hotkey opens the main window (creating/restoring it
	// like showMainWindow always has) and then fires this so it opens its
	// existing environment switcher (AtlasEnvironmentMenu.tsx) instead of a
	// second, standalone switcher UI.
	onOpenEnvironmentSwitcher: (callback) => {
		const listener = () => callback();
		ipcRenderer.on("environment:open-switcher", listener);
		return () => ipcRenderer.removeListener("environment:open-switcher", listener);
	},
	getEnvironmentConfig: (environmentId) => ipcRenderer.invoke("environment:getConfig", environmentId),
	setEnvironmentConfig: (environmentId, patch) => ipcRenderer.invoke("environment:setConfig", environmentId, patch),
	// WP-1.2: switch an environment's isolation mode. Takes effect immediately
	// -- electron/data/scoped.cjs reads `isolation_mode` fresh on every call, so
	// there is nothing here to invalidate or a restart to wait for.
	setEnvironmentIsolationMode: (environmentId, mode) =>
		ipcRenderer.invoke("environment:setIsolationMode", environmentId, mode),
	// The WP-0.8 allowlist, described in plain language -- what the
	// isolation-enforcement UI's "here's exactly what Connected mode shares"
	// list is rendered from. See electron/data/isolation.cjs's
	// describeAllowlist() for why this can never drift from enforcement.
	getIsolationAllowlist: () => ipcRenderer.invoke("isolation:getAllowlist"),

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
	// WP-1.4: the rebindable global hotkey that opens the environment switcher.
	// `setEnvironmentHotkey` resolves to `{ ok: false, error }` on a conflict
	// (the chosen combination is already held by another application) --
	// callers must show that inline rather than assuming success.
	getEnvironmentHotkey: () => ipcRenderer.invoke("hotkey:getBinding"),
	setEnvironmentHotkey: (accelerator) => ipcRenderer.invoke("hotkey:setBinding", accelerator),
	// WP-2.1: the launcher's own rebindable global hotkey -- a SEPARATE
	// binding from the environment-switcher hotkey above (see
	// electron/services/launcher-hotkey.cjs).
	getLauncherHotkey: () => ipcRenderer.invoke("launcher:getHotkeyBinding"),
	setLauncherHotkey: (accelerator) => ipcRenderer.invoke("launcher:setHotkeyBinding", accelerator),
	// Results/execution go through the provider registry (electron/services/
	// launcher-providers/index.cjs, WP-2.2) -- a fixed stub list filtered by
	// `query` in WP-2.1, a registry of real providers from WP-2.2 on, same
	// two channels either way.
	queryLauncher: (query) => ipcRenderer.invoke("launcher:query", query),
	executeLauncherResult: (resultId, modifier) => ipcRenderer.invoke("launcher:execute", resultId, modifier),
	hideLauncherWindow: () => ipcRenderer.invoke("launcher:hide"),
	// The renderer measures its own hotkey -> first-paint latency (see
	// LauncherWindowApp.tsx) and reports the number back here for
	// logging/event-log recording -- see ipc/launcher.cjs.
	reportLauncherOpenLatency: (latencyMs) => ipcRenderer.invoke("launcher:reportOpenLatency", latencyMs),
	// Fires every time the pre-created launcher window is shown (main.cjs's
	// openLauncher()) -- `firedAtMs` is when the hotkey callback ran, in the
	// main process.
	onLauncherShow: (callback) => {
		const listener = (_event, meta) => callback(meta);
		ipcRenderer.on("launcher:show", listener);
		return () => ipcRenderer.removeListener("launcher:show", listener);
	},
	getAppVersion: () => ipcRenderer.invoke("app:version"),
	checkForUpdates: (options) => ipcRenderer.invoke("app:checkUpdates", options),
	listReleaseHistory: (options) => ipcRenderer.invoke("app:releaseHistory", options),
	getUpdatePreferences: () => ipcRenderer.invoke("app:getUpdatePreferences"),
	setUpdatePreferences: (preferences) => ipcRenderer.invoke("app:setUpdatePreferences", preferences),
	downloadAndInstallUpdate: (options) => ipcRenderer.invoke("app:downloadAndInstallUpdate", options),

	getNotchPreferences: () => ipcRenderer.invoke("notch:getPreferences"),
	setNotchPreferences: (preferences) => ipcRenderer.invoke("notch:setPreferences", preferences),
	// WP-1.3: per-environment Notch layouts. Unlike the ambient pair above
	// (which always target "whatever's currently active"), each of these
	// names its target explicitly -- used by the Settings-window/Action-
	// editor tabs+grid editors, never by the live notch itself.
	getNotchLayoutForEnvironment: (environmentId) =>
		ipcRenderer.invoke("notch:getLayoutForEnvironment", environmentId),
	setDefaultNotchLayout: (patch) => ipcRenderer.invoke("notch:setDefaultLayout", patch),
	setEnvironmentNotchLayout: (environmentId, patch) =>
		ipcRenderer.invoke("notch:setEnvironmentLayout", environmentId, patch),
	clearEnvironmentNotchLayout: (environmentId) =>
		ipcRenderer.invoke("notch:clearEnvironmentLayout", environmentId),

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

	// WP-2.5: file index crawl/store -- the Settings surface's "Files" tab.
	getFileIndexPreferences: () => ipcRenderer.invoke("fileIndex:getPreferences"),
	setFileIndexPreferences: (patch) => ipcRenderer.invoke("fileIndex:setPreferences", patch),
	startFileIndexCrawl: () => ipcRenderer.invoke("fileIndex:startCrawl"),
	cancelFileIndexCrawl: () => ipcRenderer.invoke("fileIndex:cancelCrawl"),
	getFileIndexStatus: () => ipcRenderer.invoke("fileIndex:getStatus"),
	getFileIndexStats: () => ipcRenderer.invoke("fileIndex:getStats"),
	pickFileIndexFolder: () => ipcRenderer.invoke("fileIndex:pickFolder"),
	// Fires on every progress tick AND on start/finish/cancel -- see
	// electron/services/file-index/crawler.cjs's broadcast().
	onFileIndexProgress: (callback) => {
		const listener = (_event, status) => callback(status);
		ipcRenderer.on("fileIndex:progress", listener);
		return () => ipcRenderer.removeListener("fileIndex:progress", listener);
	},
});
