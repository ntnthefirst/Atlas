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

const { getPublicAiConfig, setAiConfig, aiComplete, aiStream, describeProviders } = require("../ai.cjs");

let nextStreamId = 0;

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

	// WP-4.1: which providers exist and what each can do. Built by
	// services/ai/registry.cjs from the modules it discovered, so a provider
	// added as a file shows up here with no change to this handler.
	ipcMain.handle("ai:listProviders", () => describeProviders());

	// WP-4.1: streaming. `invoke` cannot yield intermediate values, so chunks
	// are pushed back on `ai:streamChunk` tagged with the id, and the invoke
	// settles with the final normalized result.
	//
	// The CALLER supplies the id (see preload.cjs): chunks start arriving while
	// the invoke is still pending, so an id the renderer only learned from the
	// resolved value would arrive too late to filter with. A missing id still
	// gets one generated here, so the channel is usable directly in a test.
	//
	// Chunks go to the REQUESTING WebContents only (`event.sender`), never a
	// broadcast: another window has no business seeing a prompt's output, and a
	// destroyed window must not be written to at all.
	ipcMain.handle("ai:stream", async (event, args) => {
		const streamId =
			typeof args?.streamId === "string" && args.streamId ? args.streamId : `stream-${++nextStreamId}`;
		const sender = event.sender;
		try {
			const result = await aiStream(args, (chunk) => {
				if (!sender.isDestroyed()) {
					sender.send("ai:streamChunk", { streamId, chunk });
				}
			});
			return { ok: true, streamId, ...result };
		} catch (error) {
			return {
				ok: false,
				streamId,
				error: error instanceof Error ? error.message : "AI request failed.",
			};
		}
	});
}

module.exports = { register };
