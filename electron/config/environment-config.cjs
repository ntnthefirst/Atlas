// ---------------------------------------------------------------------------
// Per-environment configuration schema, defaults and defensive parsing (WP-1.1).
//
// An environment used to be just `{id, name, icon, accent, preset,
// isolation_mode}`. Every later phase (per-environment Notch layouts, AI
// behaviour, integrations) hangs off a real settings document instead, so
// this module defines that document: its shape, its defaults, a versioned
// upgrade path, and a parser that can never throw. Everything here is pure —
// no window, app, filesystem or database access — same discipline as
// electron/config/notch-prefs.cjs and focus-prefs.cjs, and for the same
// reason: it has to be loadable and testable under plain-node vitest, with
// no Electron runtime behind it. That is also why AI_PROVIDERS is a small
// hand-kept copy of electron/ai.cjs's list rather than a `require` of that
// module — ai.cjs pulls in `electron` (for `app.getPath`) at load time,
// which only resolves to a usable object inside a running Electron process.
//
// `isolation_mode` is deliberately NOT part of this document. It already is
// a first-class, CHECK-constrained `environments` column (migration 004,
// WP-0.8) that the whole scoped data layer reads directly. Folding it in
// here would give a security-relevant setting two sources of truth — the
// one kind of drift this schema must never introduce. Every other field
// below is genuinely new (nothing before this package tracked it anywhere),
// with one deliberate exception: `appearance.accent` mirrors the existing
// `environments.accent` column. That is intentional, not the same mistake —
// accent is not security-relevant, and WP-1.4 ("environment switching")
// needs theme, accent, Notch layout and AI config to travel together as one
// atomic bundle, which only works if they live in one document. `icon` and
// `preset` have no slot in this schema at all (nothing below duplicates
// them) — they stay exactly where they were.
//
// Persistence: the `environments.config` column (migration 005) holds this
// document as a JSON string, or NULL for any environment that predates this
// package. `parseEnvironmentConfig` is the one function every reader goes
// through; it never throws and never returns a partially-broken object —
// a bad field falls back to a default for that field alone, exactly the
// house pattern src/scenes.ts's `parseSceneConfig` already established for
// the Notch scene widget.
// ---------------------------------------------------------------------------

"use strict";

const CONFIG_VERSION = 1;

const THEME_PREFERENCES = ["light", "dark", "system"];

// Kept in sync by hand with electron/ai.cjs's AI_PROVIDERS — see the header
// comment above for why this module cannot require that one directly.
const AI_PROVIDERS = ["anthropic", "google", "openai"];

const defaultStartupBehaviour = () => ({
	autoStartSession: false,
	launchApps: [],
});

// The defaults for an environment that has no config document yet — either
// a brand-new environment, or one created before this package existed. Only
// `appearance.accent` is seeded from the caller's existing row data
// (`environment.accent`, if present); everything else has no prior value
// anywhere to inherit, so it gets a neutral, inert default. Accepting the
// whole environment-shaped object (rather than just `accent`) keeps this
// function's contract obvious to both call sites in db.cjs, which already
// have the full row in hand — even though only `accent` is read today.
function defaultEnvironmentConfig(environment = {}) {
	const seededAccent =
		typeof environment.accent === "string" && environment.accent.trim() ? environment.accent.trim() : null;

	return {
		version: CONFIG_VERSION,
		appearance: {
			accent: seededAccent,
			theme: "system",
		},
		notchLayoutId: null,
		ai: {
			defaultProvider: null,
			systemPrompt: "",
		},
		integrations: {},
		startupBehaviour: defaultStartupBehaviour(),
	};
}

function normalizeTheme(value, fallback) {
	return THEME_PREFERENCES.includes(value) ? value : fallback;
}

// `null` is a legitimate, explicit "no custom accent" value (distinct from
// the field being simply absent/malformed, which falls back to whatever the
// caller's default resolved to — the seeded environment accent, when there
// is one). Blank/whitespace-only strings are treated as malformed, not as a
// deliberate clear, matching how other config normalizers in this codebase
// treat an empty string as "unset".
function normalizeAccent(value, fallback) {
	if (value === null) return null;
	if (typeof value === "string" && value.trim()) return value.trim();
	return fallback;
}

function normalizeAppearance(raw, defaults) {
	const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	return {
		accent: normalizeAccent(source.accent, defaults.accent),
		theme: normalizeTheme(source.theme, defaults.theme),
	};
}

function normalizeNotchLayoutId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAi(raw, defaults) {
	const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	return {
		defaultProvider: AI_PROVIDERS.includes(source.defaultProvider) ? source.defaultProvider : defaults.defaultProvider,
		systemPrompt: typeof source.systemPrompt === "string" ? source.systemPrompt : defaults.systemPrompt,
	};
}

// An enablement map: `{ [integrationId]: boolean }`. No integration exists
// yet (WP-5.x introduces the first ones), so any key is accepted at this
// layer — only the value's type is validated. Non-boolean entries and
// non-string keys are dropped rather than coerced, so a corrupted entry
// simply disappears instead of poisoning the map with a truthy non-boolean.
function normalizeIntegrations(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const result = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof key === "string" && key.trim() && typeof value === "boolean") {
			result[key.trim()] = value;
		}
	}
	return result;
}

function normalizeStartupBehaviour(raw, defaults) {
	const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	return {
		autoStartSession: typeof source.autoStartSession === "boolean" ? source.autoStartSession : defaults.autoStartSession,
		launchApps: Array.isArray(source.launchApps)
			? source.launchApps.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
			: defaults.launchApps,
	};
}

function normalizeVersion(value) {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

// The upgrade path (D3: every schema change needs one, even when there is
// only one version today). Keyed by the version a document is coming FROM.
// A document with no `version` field at all — anything hand-edited, or
// written before this schema existed — is treated as version 0 and stamped
// up to version 1 with no other shape change, since version 1 IS the first
// shape. There is nothing to migrate FIELD-wise yet, but the mechanism
// itself has to exist and be exercised now: retrofitting it once a real
// version 2 shows up would mean guessing blind at what version-1 documents
// actually looked like in the wild.
const CONFIG_UPGRADES = {
	0: (raw) => ({ ...raw, version: 1 }),
};

// Walks `raw` forward through CONFIG_UPGRADES until it reaches
// CONFIG_VERSION. A document from a NEWER build than this one (a version
// this build has never heard of) cannot be upgraded backward; its
// unrecognized fields are simply dropped by the per-field normalization
// that follows, and its version is pinned down to what this build actually
// understands. The `guard` counter exists purely so a future upgrade step
// that forgets to advance the version can never spin this loop forever.
function upgradeEnvironmentConfig(raw) {
	let doc = { ...raw };
	let version = normalizeVersion(doc.version);
	let guard = 0;
	while (version < CONFIG_VERSION && guard <= CONFIG_VERSION) {
		const upgrade = CONFIG_UPGRADES[version];
		if (!upgrade) break;
		doc = upgrade(doc);
		version = normalizeVersion(doc.version);
		guard++;
	}
	doc.version = CONFIG_VERSION;
	return doc;
}

// Field-by-field normalization of an already-upgraded, plain-object
// document. Never throws, never omits a field — every key in the schema is
// always present in the result, falling back to `defaults` (built from the
// environment's own existing data, never a generic blank) per field rather
// than wholesale, so one malformed field can't take the rest of a
// perfectly good document down with it.
function normalizeEnvironmentConfig(raw, environment = {}) {
	const defaults = defaultEnvironmentConfig(environment);
	const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	return {
		version: CONFIG_VERSION,
		appearance: normalizeAppearance(source.appearance, defaults.appearance),
		notchLayoutId: normalizeNotchLayoutId(source.notchLayoutId),
		ai: normalizeAi(source.ai, defaults.ai),
		integrations: normalizeIntegrations(source.integrations),
		startupBehaviour: normalizeStartupBehaviour(source.startupBehaviour, defaults.startupBehaviour),
	};
}

// The one function every reader of `environments.config` goes through.
// `value` is whatever came out of the database column: NULL/undefined (no
// config saved yet), a JSON string (the normal case), or — defensively —
// anything else a hand-edit or a future bug might produce. Never throws;
// always returns a fully-populated, valid config object.
function parseEnvironmentConfig(value, environment = {}) {
	if (value === null || value === undefined) {
		return defaultEnvironmentConfig(environment);
	}

	let raw = value;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) {
			return defaultEnvironmentConfig(environment);
		}
		try {
			raw = JSON.parse(trimmed);
		} catch {
			return defaultEnvironmentConfig(environment);
		}
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return defaultEnvironmentConfig(environment);
	}

	const upgraded = upgradeEnvironmentConfig(raw);
	return normalizeEnvironmentConfig(upgraded, environment);
}

const serializeEnvironmentConfig = (config) => JSON.stringify(config);

// Applies a partial patch on top of an already-valid config (as returned by
// parseEnvironmentConfig), one section at a time, then re-normalizes the
// result. Re-normalizing is what stops a bad value inside the patch (an
// unknown theme string, a non-boolean integration flag, ...) from ever
// reaching storage — the merged document gets exactly the same defensive
// treatment a config loaded fresh from disk would get. Sections not present
// in `patch` are left completely untouched.
function applyConfigPatch(current, patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return current;
	}

	const mergeSection = (base, patchSection) =>
		patchSection && typeof patchSection === "object" && !Array.isArray(patchSection)
			? { ...base, ...patchSection }
			: { ...base };

	const merged = {
		version: CONFIG_VERSION,
		appearance: mergeSection(current.appearance, patch.appearance),
		notchLayoutId: Object.prototype.hasOwnProperty.call(patch, "notchLayoutId")
			? patch.notchLayoutId
			: current.notchLayoutId,
		ai: mergeSection(current.ai, patch.ai),
		integrations:
			patch.integrations && typeof patch.integrations === "object" && !Array.isArray(patch.integrations)
				? { ...current.integrations, ...patch.integrations }
				: { ...current.integrations },
		startupBehaviour: mergeSection(current.startupBehaviour, patch.startupBehaviour),
	};

	// Re-normalizing needs its own fallback source for `appearance.accent` in
	// the (rare) case a patch supplies an invalid value for it — falling back
	// to the environment's ORIGINAL accent (pre-patch), never to a blank
	// default, so an accent can't be silently reset via a malformed patch any
	// more than it can via a malformed stored document.
	return normalizeEnvironmentConfig(merged, { accent: current.appearance.accent });
}

module.exports = {
	CONFIG_VERSION,
	THEME_PREFERENCES,
	AI_PROVIDERS,
	defaultEnvironmentConfig,
	normalizeEnvironmentConfig,
	upgradeEnvironmentConfig,
	parseEnvironmentConfig,
	serializeEnvironmentConfig,
	applyConfigPatch,
};
