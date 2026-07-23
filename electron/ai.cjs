const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

// ---------------------------------------------------------------------------
// AI provider integrations (Claude / Gemini / OpenAI-compatible).
//
// All calls go through the main process so the user's API keys never touch the
// renderer: the renderer sends a prompt + which provider to use, the key is read
// here, and only the resulting text is handed back. Keys are only ever sent to
// the single provider the user picked for a given request.
//
// Keys live in the encrypted vault (services/secrets.cjs), not in
// ai-preferences.json — that file now holds only the chosen provider and model
// names. Older installs wrote keys into it in plaintext; those are migrated
// into the vault on first load and stripped from the file (WP-0.4).
//
// -- WP-4.1: this file no longer knows any provider by name -------------------
// Every provider-specific detail (endpoint, auth header, request body, how to
// read an answer, how to read a stream) moved into its own module under
// services/ai/providers/, discovered by services/ai/registry.cjs. What is left
// here is preferences, the vault, and precedence — the things that are about
// the USER's configuration rather than about any particular vendor.
//
// That is what makes "adding a provider requires no changes outside its own
// module" true: the lists below are derived from the registry, so a new
// provider file appears in the preferences shape, the public config, and
// aiComplete's dispatch without a line changing here.
// ---------------------------------------------------------------------------

const secrets = require("./services/secrets.cjs");
const registry = require("./services/ai/registry.cjs");
const { supports } = require("./services/ai/contract.cjs");

const AI_PREFS_FILE = "ai-preferences.json";

// Derived, never declared. `listProviderIds()` is the registry's scan of
// services/ai/providers/.
const AI_PROVIDERS = registry.listProviderIds();
const labelFor = (provider) => registry.getProvider(provider)?.label ?? provider;
const defaultModelFor = (provider) => registry.getProvider(provider)?.defaultModel ?? "";

const emptyProvider = (provider) => ({ model: defaultModelFor(provider) });

// Vault key for a provider's API key. Namespaced so the vault can hold
// unrelated secrets (integration tokens, later) without collision.
const secretKeyFor = (provider) => `ai.${provider}.apiKey`;

// Plaintext keys read from a legacy ai-preferences.json that could NOT be
// migrated because the OS keystore was unavailable. Kept in memory only, so the
// app keeps working for that session without ever writing plaintext again.
// Migration is retried on the next load.
let legacyPlaintextKeys = {};

const defaultAiPreferences = () => ({
	// "anthropic" when it is registered (it is, and it is the shipped default),
	// otherwise whatever the scan found first -- so a build with a different set
	// of provider modules still boots with a usable default instead of naming
	// one that isn't there.
	defaultProvider: AI_PROVIDERS.includes("anthropic") ? "anthropic" : (AI_PROVIDERS[0] ?? null),
	providers: Object.fromEntries(AI_PROVIDERS.map((provider) => [provider, emptyProvider(provider)])),
});

let aiPreferences = defaultAiPreferences();

// WP-1.4: which provider "wins" when a caller doesn't name one explicitly.
// Set on every environment switch (main.cjs's setActiveEnvironment) to that
// environment's own `ai.defaultProvider` override, or null when it has none
// -- see environment-config.cjs's defaultEnvironmentConfig(), which ships
// every environment with `null` until a future package adds a UI to set it.
// `null` here means exactly what it means there: "no opinion, fall through
// to the app-wide default", never "no provider at all". In-memory only,
// same as `currentEnvironmentId`/`notchPreferences` in main.cjs -- it is
// re-derived on every switch, never persisted, and never survives a
// restart on its own.
//
// Pure and side-effect free (no vault/network access) on purpose: unlike
// nearly everything else in this file, that makes it testable without a
// running Electron process. See resolveRequestedProvider below.
let activeEnvironmentProvider = null;

function setActiveEnvironmentProvider(provider) {
	activeEnvironmentProvider = AI_PROVIDERS.includes(provider) ? provider : null;
	return activeEnvironmentProvider;
}

function getActiveEnvironmentProvider() {
	return activeEnvironmentProvider;
}

// The actual precedence: an explicit request always wins (e.g. Settings'
// "test connection" button always names a provider); failing that, the
// active environment's own override; failing that, the app-wide default.
// Exported on its own (rather than inlined into aiComplete) so the
// precedence itself is unit-testable without touching the vault or network.
function resolveRequestedProvider(requestedProvider) {
	if (AI_PROVIDERS.includes(requestedProvider)) {
		return requestedProvider;
	}
	return activeEnvironmentProvider || aiPreferences.defaultProvider;
}

function normalizeAiPreferences(raw) {
	const base = defaultAiPreferences();
	if (!raw || typeof raw !== "object") return base;
	if (AI_PROVIDERS.includes(raw.defaultProvider)) base.defaultProvider = raw.defaultProvider;
	const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
	for (const provider of AI_PROVIDERS) {
		const entry = providers[provider];
		if (entry && typeof entry === "object") {
			base.providers[provider] = {
				model:
					typeof entry.model === "string" && entry.model.trim()
						? entry.model.trim()
						: defaultModelFor(provider),
			};
		}
	}
	return base;
}

function aiPrefsPath() {
	return path.join(app.getPath("userData"), AI_PREFS_FILE);
}

// Lifts any plaintext keys out of a legacy preferences file and into the vault.
// Returns true when at least one key moved, meaning the file must be rewritten
// without them.
//
// If the keystore is unavailable we deliberately do NOT touch the file: that
// plaintext is the user's only copy of the key, and destroying it to satisfy a
// security rule would be a worse outcome than leaving it one more session.
// Those keys are held in memory for this run and migration is retried on the
// next load.
function migrateLegacyKeys(raw) {
	legacyPlaintextKeys = {};

	const providers = raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object"
		? raw.providers
		: {};

	let moved = false;
	for (const provider of AI_PROVIDERS) {
		const entry = providers[provider];
		const key = entry && typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
		if (!key) {
			continue;
		}

		try {
			secrets.set(secretKeyFor(provider), key);
			moved = true;
		} catch {
			legacyPlaintextKeys[provider] = key;
		}
	}

	return moved;
}

function loadAiPreferences() {
	let raw = null;
	try {
		raw = JSON.parse(fs.readFileSync(aiPrefsPath(), "utf8"));
	} catch {
		raw = null;
	}

	const moved = migrateLegacyKeys(raw);
	aiPreferences = normalizeAiPreferences(raw);

	// Rewrites the file in the new shape, which no longer carries apiKey.
	if (moved) {
		persistAiPreferences();
	}

	return aiPreferences;
}

// The usable key for a provider: the vault first, then any legacy plaintext we
// could not migrate this session.
function resolveKey(provider) {
	return secrets.get(secretKeyFor(provider)) || legacyPlaintextKeys[provider] || "";
}

function persistAiPreferences() {
	try {
		fs.writeFileSync(aiPrefsPath(), JSON.stringify(aiPreferences, null, 2), "utf8");
	} catch {
		// Non-blocking: AI still works from in-memory config this session.
	}
}

// The renderer only ever sees whether a key is set (never the key itself) plus
// the chosen model and default provider.
function getPublicAiConfig() {
	const providers = {};
	for (const provider of AI_PROVIDERS) {
		providers[provider] = {
			hasKey: Boolean(resolveKey(provider)),
			model: aiPreferences.providers[provider].model,
			label: labelFor(provider),
			// WP-4.1: what this provider can do, so the renderer can offer (or
			// hide) streaming and tool-backed features per provider instead of
			// assuming they all behave the same. Still no key, no endpoint.
			capabilities: registry.describeProvider(registry.getProvider(provider))?.capabilities ?? {},
		};
	}
	return {
		defaultProvider: aiPreferences.defaultProvider,
		providers,
		// Surfaced so the UI can explain why saving a key fails on this device
		// rather than appearing to silently ignore it.
		secretsAvailable: secrets.isAvailable(),
	};
}

// Merge a patch: an omitted apiKey keeps the stored one, an empty string clears
// it, a non-empty string replaces it. Model is set when a non-empty string is
// provided.
function setAiConfig(patch) {
	if (patch && typeof patch === "object") {
		if (AI_PROVIDERS.includes(patch.defaultProvider)) {
			aiPreferences.defaultProvider = patch.defaultProvider;
		}
		const providers = patch.providers && typeof patch.providers === "object" ? patch.providers : {};
		for (const provider of AI_PROVIDERS) {
			const entry = providers[provider];
			if (!entry || typeof entry !== "object") continue;
			if (typeof entry.apiKey === "string") {
				// Throws when the OS keystore is unavailable, which the caller
				// surfaces to the user — never a silent plaintext fallback.
				secrets.set(secretKeyFor(provider), entry.apiKey.trim());
				// A key that has just been stored properly supersedes any
				// legacy plaintext we were holding for this session.
				delete legacyPlaintextKeys[provider];
			}
			if (typeof entry.model === "string" && entry.model.trim()) {
				aiPreferences.providers[provider].model = entry.model.trim();
			}
		}
		persistAiPreferences();
	}
	return getPublicAiConfig();
}

// Everything a provider call needs, resolved once from the request, the stored
// preferences and the vault. Throws the same friendly errors both aiComplete
// and aiStream would otherwise each have to raise for themselves.
function prepareRequest(args) {
	const request = args && typeof args === "object" ? args : {};
	const providerId = resolveRequestedProvider(request.provider);
	const provider = registry.getProvider(providerId);
	if (!provider) {
		throw new Error("No AI provider is available.");
	}
	const config = aiPreferences.providers[providerId];
	const key = resolveKey(providerId);
	if (!config || !key) {
		throw new Error(`No API key set for ${labelFor(providerId)}. Add it in Settings → Integrations.`);
	}
	const prompt = typeof request.prompt === "string" ? request.prompt : "";
	if (!prompt.trim()) {
		throw new Error("Prompt is empty.");
	}
	return {
		provider,
		key,
		model: typeof request.model === "string" && request.model.trim() ? request.model.trim() : config.model,
		system: typeof request.system === "string" ? request.system : "",
		prompt,
		maxTokens: Math.min(4096, Math.max(1, Math.round(Number(request.maxTokens) || 1024))),
		// Passed through untouched; each provider translates the canonical spec
		// into its own wire format (see services/ai/contract.cjs).
		tools: Array.isArray(request.tools) ? request.tools : [],
	};
}

// Runs a single prompt against the requested (or default) provider using the
// locally stored key. The result is the normalized shape every provider
// resolves to -- `text` plus any `toolCalls` -- so callers never branch on
// which provider answered.
async function aiComplete(args) {
	const { provider, key, model, system, prompt, maxTokens, tools } = prepareRequest(args);
	if (tools.length > 0 && !supports(provider, "tools")) {
		throw new Error(`${provider.label} does not support tool calling.`);
	}
	const result = await provider.complete({ key, model, system, prompt, maxTokens, tools });
	return { ...result, provider: provider.id, model };
}

// The streaming counterpart. `onChunk(text)` is called with each fragment as
// it arrives; the resolved value is the same normalized shape aiComplete
// returns, so a caller that only wants the final answer can ignore the
// callback entirely.
//
// Degrades rather than refusing: a provider without the `streaming` capability
// runs the ordinary completion and delivers its whole answer as one chunk. That
// is what makes the capability flag useful to check rather than mandatory --
// see contract.cjs's header.
async function aiStream(args, onChunk) {
	const { provider, key, model, system, prompt, maxTokens, tools } = prepareRequest(args);
	if (tools.length > 0 && !supports(provider, "tools")) {
		throw new Error(`${provider.label} does not support tool calling.`);
	}

	if (!supports(provider, "streaming")) {
		const result = await provider.complete({ key, model, system, prompt, maxTokens, tools });
		if (result.text && typeof onChunk === "function") {
			onChunk(result.text);
		}
		return { ...result, provider: provider.id, model, streamed: false };
	}

	const result = await provider.stream({ key, model, system, prompt, maxTokens, tools, onChunk });
	return { ...result, provider: provider.id, model, streamed: true };
}

module.exports = {
	AI_PROVIDERS,
	loadAiPreferences,
	getPublicAiConfig,
	setAiConfig,
	aiComplete,
	aiStream,
	setActiveEnvironmentProvider,
	getActiveEnvironmentProvider,
	resolveRequestedProvider,
	// WP-4.1: the renderer-safe provider descriptions (id, label, default
	// model, capabilities) -- never a key, never an endpoint.
	describeProviders: registry.describeAll,
};
