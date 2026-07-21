"use strict";

// ---------------------------------------------------------------------------
// Atomic environment switching (WP-1.4).
//
// main.cjs's `setActiveEnvironment` (called from the `environment:switch` IPC
// handler -- environments.cjs -- on every switch, from the Notch, the main
// app's own switcher, and the global hotkey's switcher alike) is what makes a
// switch ATOMIC: theme, accent, Notch layout and AI config must change
// together, with no visible half-switched state. This module is the pure
// half of that story; main.cjs still owns the actual application (native
// theme, re-rendering the Notch windows, broadcasting to renderers) because
// that needs the live window/db handles this module deliberately does not
// hold.
//
// The ordering that makes this atomic: RESOLVE EVERYTHING FIRST, from the
// target environment id alone, THEN apply every piece, all synchronously, in
// one function call with no `await` in between. JavaScript's main process is
// single-threaded, so nothing else in Electron's main process can ever
// observe an intermediate state where (say) the Notch has repainted but the
// accent/theme/AI provider haven't -- the only way to introduce a visible
// half-switched state would be to `await` something between two of these
// steps, which main.cjs's setActiveEnvironment deliberately never does.
// `resolveEnvironmentBundle` below is what supplies the "resolve everything
// first" half: it is a pure function of `environmentId` alone, so calling it
// for environment B can never observe anything left over from whichever
// environment (A) was active a moment ago -- there is no shared mutable
// state here for a leftover value to hide in.
//
// `startupBehaviour` (autoStartSession / launchApps) is handled separately,
// by `applyStartupBehaviour` below, and is NEVER awaited by the switch path:
// both sub-features are opt-in and off by default (see
// electron/config/environment-config.cjs's defaultStartupBehaviour()), and
// even when configured they must not add latency to the perceived switch --
// least of all launching external programs, which is inherently slow and
// asynchronous. main.cjs fires this after everything else has already been
// applied and returned.
// ---------------------------------------------------------------------------

// Resolves the appearance/AI/startup-behaviour bundle for `environmentId`
// from ONE database read. Notch layout resolution is deliberately NOT
// duplicated here -- main.cjs already has `refreshActiveNotchPreferences`
// (WP-1.3) for that, reading from the same `environments.config` document;
// this only covers the fields WP-1.4 adds to what changes on a switch.
//
// Pure given `db`: no window, no timers, no module-level state. A missing
// `environmentId` (nothing active, e.g. at boot before any switch) or a
// missing `db` resolves to the same neutral defaults
// `defaultEnvironmentConfig()` would produce for a brand-new environment,
// never to `undefined`/a thrown error.
function resolveEnvironmentBundle(db, environmentId) {
	const config = environmentId && db ? db.getEnvironmentConfig(environmentId) : null;
	return {
		environmentId: environmentId || null,
		appearance: config ? config.appearance : { accent: null, theme: "system" },
		ai: config ? config.ai : { defaultProvider: null, systemPrompt: "" },
		startupBehaviour: config ? config.startupBehaviour : { autoStartSession: false, launchApps: [] },
	};
}

// The environment's own theme wins whenever it has one; "system" is this
// environment deliberately having NO opinion, in which case the user's own
// last-chosen global theme applies -- NEVER whatever the native theme
// currently happens to be, which could just be a leftover override from the
// environment being switched OUT of. Both inputs are independent arguments,
// so two consecutive calls can never leak state between each other; that is
// what "atomic -- resolves from the target environment, none from the
// previous" means for theme specifically.
function resolveEffectiveTheme(environmentTheme, globalTheme) {
	const fallback = globalTheme === "light" || globalTheme === "dark" ? globalTheme : "system";
	return environmentTheme === "light" || environmentTheme === "dark" ? environmentTheme : fallback;
}

// autoStartSession: starts a session in `environmentId`, but only when
// nothing is already active anywhere. db.startSession() already refuses a
// second concurrent session (there is exactly one active session in the
// whole app at a time); the correct response here is to skip quietly, never
// to stop the user's existing timer just because they switched environments
// -- that would be a far worse surprise than the feature simply not firing
// this one time.
function startAutoSession({ db, environmentId, getTracker, getEventLog }) {
	if (!db || !environmentId || db.getActiveSession()) {
		return null;
	}
	try {
		const session = db.startSession(environmentId);
		getTracker?.()?.setCurrentSession?.(session.id);
		getEventLog?.()?.record?.("session.start", { environmentId, sessionId: session.id });
		return session;
	} catch (error) {
		// Automatic, unattended action: surface failures to the console for
		// debugging, never as a dialog/crash the user didn't ask for.
		console.error("[Atlas] startupBehaviour.autoStartSession failed:", error);
		return null;
	}
}

// launchApps: fires every configured command through the platform adapter
// (WP-0.6). One failed command must never stop the rest -- each is its own
// try/catch -- and `platform.launch()` itself is fire-and-forget by design
// (resolves once the process has been asked to start, not once it's
// actually running), so this whole function is inherently slow-ish and
// asynchronous, which is exactly why the caller (applyStartupBehaviour, and
// in turn main.cjs) never awaits it on the perceived-switch path.
async function launchStartupApps({ platform, launchApps }) {
	if (!platform || !Array.isArray(launchApps)) {
		return;
	}
	for (const command of launchApps) {
		if (!command) {
			continue;
		}
		try {
			await platform.launch(command);
		} catch (error) {
			console.error(`[Atlas] startupBehaviour.launchApps failed for "${command}":`, error);
		}
	}
}

// Applies `startupBehaviour` for the environment just switched into. Both
// sub-features are opt-in (defaultEnvironmentConfig() ships both off), so a
// user who has never touched either setting -- which today is EVERY user,
// since there is no UI for it yet -- sees this function do nothing at all:
// no session start, no process launched, zero behaviour change.
//
// Returns a promise so callers that want to (tests; a future "did startup
// actions finish" indicator) can await it, but main.cjs's setActiveEnvironment
// deliberately does not -- see this module's header for why.
function applyStartupBehaviour({ db, environmentId, startupBehaviour, getTracker, getEventLog, platform }) {
	if (!startupBehaviour || !environmentId) {
		return Promise.resolve([]);
	}

	const jobs = [];
	if (startupBehaviour.autoStartSession) {
		jobs.push(Promise.resolve(startAutoSession({ db, environmentId, getTracker, getEventLog })));
	}
	if (Array.isArray(startupBehaviour.launchApps) && startupBehaviour.launchApps.length > 0) {
		jobs.push(launchStartupApps({ platform, launchApps: startupBehaviour.launchApps }));
	}
	return Promise.allSettled(jobs);
}

module.exports = {
	resolveEnvironmentBundle,
	resolveEffectiveTheme,
	startAutoSession,
	launchStartupApps,
	applyStartupBehaviour,
};
