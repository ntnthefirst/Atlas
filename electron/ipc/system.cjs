// ---------------------------------------------------------------------------
// System + dashboard-layout IPC handlers (system:*, dashboard:getLayout,
// dashboard:setLayout).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change.
// `dashboard:getLayout`/`dashboard:setLayout` are grouped here rather than
// with insights.cjs's `dashboard:overview` because they're preference
// handlers backed by `dashboardPreferences` (a file on disk), not the
// database -- see insights.cjs's file header for the same distinction from
// the other side.
//
// `getSystemStats` and `listOpenApps` are required directly from
// `../system-info.cjs`, the same way sessions.cjs requires `scoped`
// directly, rather than threaded through `deps` -- they're plain imported
// functions main.cjs never reassigns, so there's nothing getter-shaped about
// them.
//
// `getDashboardPreferences` IS a getter: `dashboardPreferences` is a `let`
// main.cjs reassigns every time preferences load or save (see
// `loadDashboardPreferences`/`saveDashboardPreferences` there) -- a value
// capture here would freeze this module onto whatever `dashboardPreferences`
// was at require time, before any prefs file is ever read.
//
// `saveDashboardPreferences` is passed as a plain value: it's a `function`
// declaration in main.cjs that is never reassigned, so (unlike
// `dashboardPreferences` itself) there's no stale-capture risk in holding
// onto it directly. It stays defined in main.cjs (including the broadcast of
// `dashboard:layout-changed` to every window) -- only the IPC handler
// registrations that call it moved here.
// ---------------------------------------------------------------------------

const { getSystemStats, listOpenApps } = require("../system-info.cjs");

function register(ipcMain, deps) {
	const { getDashboardPreferences, saveDashboardPreferences } = deps;

	ipcMain.handle("dashboard:getLayout", () => getDashboardPreferences());

	ipcMain.handle("dashboard:setLayout", (_event, prefs) =>
		saveDashboardPreferences({ ...getDashboardPreferences(), ...(prefs || {}) }),
	);

	ipcMain.handle("system:listOpenApps", () => listOpenApps());

	ipcMain.handle("system:getStats", () => getSystemStats());
}

module.exports = { register };
