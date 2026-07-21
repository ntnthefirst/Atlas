// ---------------------------------------------------------------------------
// AI provider IPC handlers (ai:*).
//
// Extracted from main.cjs's wireIpc() (WP-0.2) with no behaviour change. AI
// provider keys stay in the main process (electron/ai.cjs); the renderer
// only ever gets masked config back and sends prompts to run.
//
// `getPublicAiConfig`, `setAiConfig`, and `aiComplete` are required directly
// from `../ai.cjs`, the same way sessions.cjs requires `scoped` directly,
// rather than threaded through `deps` -- they're plain imported functions
// main.cjs never reassigns, so there's nothing getter-shaped about them.
// `loadAiPreferences` (also exported by ai.cjs) is unrelated to these
// handlers -- it's called once during app.whenReady(), before any renderer
// could invoke a channel -- so it stays required directly in main.cjs and
// isn't needed here.
// ---------------------------------------------------------------------------

const { getPublicAiConfig, setAiConfig, aiComplete } = require("../ai.cjs");

function register(ipcMain) {
	ipcMain.handle("ai:getConfig", () => getPublicAiConfig());
	ipcMain.handle("ai:setConfig", (_event, patch) => setAiConfig(patch));
	ipcMain.handle("ai:complete", async (_event, args) => {
		try {
			const result = await aiComplete(args);
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : "AI request failed." };
		}
	});
}

module.exports = { register };
