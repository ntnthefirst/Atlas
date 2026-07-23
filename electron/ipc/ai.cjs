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
const { buildEnvironmentContext } = require("../services/ai/ai-context.cjs");
const memoryStore = require("../services/ai/memory-store.cjs");

let nextStreamId = 0;

// WP-4.2: builds the environment's context and folds it into the system
// prompt. Returns BOTH the args to send and the context that was built, so
// every path that sends context can also report exactly what it sent -- which
// is the acceptance criterion, and is only trustworthy if the inspected value
// is the same object that was used rather than a second build.
function withEnvironmentContext(db, args) {
	const request = args && typeof args === "object" ? args : {};
	const environmentId = typeof request.environmentId === "string" ? request.environmentId : null;
	if (!db || !environmentId || request.includeContext === false) {
		return { args: request, context: null };
	}
	const environment = db.getEnvironment?.(environmentId) ?? null;
	const context = buildEnvironmentContext(db, environmentId, {
		environmentName: environment?.name ?? null,
		budget: request.contextBudget,
	});
	if (!context.text) {
		return { args: request, context };
	}
	// Prepended, not replacing: a caller's own system prompt still applies.
	const system = request.system ? `${context.text}\n\n${request.system}` : context.text;
	return { args: { ...request, system }, context };
}

function register(ipcMain, deps = {}) {
	const getDb = deps.getDb ?? (() => null);
	ipcMain.handle("ai:getConfig", () => getPublicAiConfig());
	ipcMain.handle("ai:setConfig", (_event, patch) => setAiConfig(patch));
	ipcMain.handle("ai:complete", async (_event, args) => {
		try {
			const { args: prepared, context } = withEnvironmentContext(getDb(), args);
			const result = await aiComplete(prepared);
			// The context is returned with the answer, so "what was sent" is
			// always answerable for the request that was actually made.
			return { ok: true, ...result, context };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : "AI request failed." };
		}
	});

	// -- WP-4.2: scoped context and memory -----------------------------------

	// The exact context that WOULD be sent for this environment, built the same
	// way ai:complete builds it. This is the inspection surface: it is the same
	// function, not a re-implementation, so it cannot drift from what is really
	// sent.
	ipcMain.handle("ai:getContext", (_event, environmentId, budget) => {
		const db = getDb();
		if (!db || !environmentId) {
			return { text: "", sections: [], truncated: false, chars: 0, environmentId: environmentId ?? null };
		}
		const environment = db.getEnvironment?.(environmentId) ?? null;
		return buildEnvironmentContext(db, environmentId, { environmentName: environment?.name ?? null, budget });
	});

	// Memory is environment-scoped in every channel: there is no "list all"
	// variant, because memory-store.cjs cannot express one.
	ipcMain.handle("ai:listMemories", (_event, environmentId) => memoryStore.listMemories(getDb(), environmentId));

	ipcMain.handle("ai:addMemory", (_event, environmentId, content) =>
		memoryStore.createMemory(getDb(), environmentId, content),
	);

	ipcMain.handle("ai:updateMemory", (_event, environmentId, id, content) =>
		memoryStore.updateMemory(getDb(), environmentId, id, content),
	);

	ipcMain.handle("ai:deleteMemory", (_event, environmentId, id) =>
		memoryStore.deleteMemory(getDb(), environmentId, id),
	);

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
			const { args: prepared, context } = withEnvironmentContext(getDb(), args);
			const result = await aiStream(prepared, (chunk) => {
				if (!sender.isDestroyed()) {
					sender.send("ai:streamChunk", { streamId, chunk });
				}
			});
			return { ok: true, streamId, ...result, context };
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
