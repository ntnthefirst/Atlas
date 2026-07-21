// ---------------------------------------------------------------------------
// Environment-switcher hotkey IPC handlers (hotkey:*) (WP-1.4).
//
// Thin passthrough to electron/services/environment-hotkey.cjs -- `getBinding`
// and `setBinding` are that module's own `getBinding`/`setAccelerator`,
// handed in directly rather than re-derived here, exactly like every other
// ipc/*.cjs module's relationship to its backing service. Kept as plain
// function values (not getters): the manager instance itself is created once
// in main.cjs and never reassigned, only its internal state changes.
//
// `hotkey:setBinding` returns whatever `setAccelerator` returns verbatim --
// `{ ok: false, error }` on a conflict included -- so the renderer can show
// the failure inline rather than the call silently resolving to nothing.
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { getBinding, setBinding } = deps;

	ipcMain.handle("hotkey:getBinding", () => getBinding());

	ipcMain.handle("hotkey:setBinding", (_event, accelerator) => setBinding(accelerator));
}

module.exports = { register };
