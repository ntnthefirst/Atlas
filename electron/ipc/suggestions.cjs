"use strict";

// ---------------------------------------------------------------------------
// Suggestion surfacing IPC handlers (suggestions:*) -- WP-3.5.
//
// Accept/dismiss are deliberately NOT here -- see electron/services/
// suggestion-surfacing/suggestion-manager.cjs's own header. They reuse the
// EXACT SAME findings:accept / findings:ignore handlers WP-3.4 already
// registered in electron/ipc/findings.cjs, which already route through
// finding-lifecycle-service.cjs's acceptFinding()/ignoreFinding() -- one
// path, never a second parallel one. This module only owns "is surfacing on
// at all, and what (if anything) should the Notch show right now".
//
// `manager` is a plain value (never reassigned after main.cjs constructs it,
// exactly like `findingLifecycleManager`/`patternMiner`).
// ---------------------------------------------------------------------------

function register(ipcMain, deps) {
	const { manager } = deps;

	ipcMain.handle("suggestions:getPreferences", () => manager.getPreferences());

	ipcMain.handle("suggestions:setPreferences", (_event, patch) => manager.setPreferences(patch || {}));

	// The ONLY way a suggestion is ever chosen and marked "suggested" -- see
	// suggestion-manager.cjs#getSuggestionToSurface's own header for the full
	// disabled/no-environment/no-candidate/rate-limit short-circuit chain.
	// Called on a poll from the Notch (src/components/notch/NotchApp.tsx),
	// never on a timer main.cjs itself owns.
	ipcMain.handle("suggestions:getCurrent", (_event, environmentId) => manager.getSuggestionToSurface(environmentId));
}

module.exports = { register };
