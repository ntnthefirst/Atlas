// ---------------------------------------------------------------------------
// Work-context IPC handlers (context:*) -- WP-2.8.
//
// A thin wrapper around electron/services/context-service.cjs, exactly like
// file-index.cjs is around the crawler and watcher. `contextService` is a
// plain value rather than a getter for the same reason `crawler`/`watcher`
// are: main.cjs builds it ONCE via createContextService() into a `const` that
// is never reassigned.
//
// `context:startDetection` / `stopDetection` control this service's OWN
// polling only. The activity tracker feeds observations in whenever a session
// is running regardless (see context-service.cjs's header) -- that path costs
// nothing extra and needs no switch.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { contextService } = deps;

	ipcMain.handle("context:getStatus", () => ({
		...contextService.getStatus(),
		layoutId: contextService.resolveLayoutId(),
	}));

	ipcMain.handle("context:pin", (_event, context) => contextService.pin(context));

	ipcMain.handle("context:unpin", () => contextService.unpin());

	ipcMain.handle("context:startDetection", () => contextService.start());

	ipcMain.handle("context:stopDetection", () => contextService.stop());
}

module.exports = { register };
