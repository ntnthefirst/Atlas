const path = require("node:path");
const https = require("node:https");
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
// ---------------------------------------------------------------------------

const secrets = require("./services/secrets.cjs");

const AI_PREFS_FILE = "ai-preferences.json";
const AI_PROVIDERS = ["anthropic", "google", "openai"];
const AI_PROVIDER_LABELS = {
	anthropic: "Claude (Anthropic)",
	google: "Gemini (Google)",
	openai: "OpenAI",
};
const DEFAULT_MODELS = {
	anthropic: "claude-sonnet-5",
	google: "gemini-1.5-flash",
	openai: "gpt-4o-mini",
};

const emptyProvider = (provider) => ({ model: DEFAULT_MODELS[provider] });

// Vault key for a provider's API key. Namespaced so the vault can hold
// unrelated secrets (integration tokens, later) without collision.
const secretKeyFor = (provider) => `ai.${provider}.apiKey`;

// Plaintext keys read from a legacy ai-preferences.json that could NOT be
// migrated because the OS keystore was unavailable. Kept in memory only, so the
// app keeps working for that session without ever writing plaintext again.
// Migration is retried on the next load.
let legacyPlaintextKeys = {};

const defaultAiPreferences = () => ({
	defaultProvider: "anthropic",
	providers: {
		anthropic: emptyProvider("anthropic"),
		google: emptyProvider("google"),
		openai: emptyProvider("openai"),
	},
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
						: DEFAULT_MODELS[provider],
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
			label: AI_PROVIDER_LABELS[provider],
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

function httpsJson(url, { method = "POST", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const data = body ? JSON.stringify(body) : null;
		const request = https.request(
			{
				method,
				hostname: target.hostname,
				path: target.pathname + target.search,
				headers: {
					"Content-Type": "application/json",
					...headers,
					...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
				},
				timeout: 60000,
			},
			(response) => {
				let payload = "";
				response.on("data", (chunk) => {
					payload += chunk;
				});
				response.on("end", () => {
					const status = response.statusCode || 0;
					let json = null;
					try {
						json = payload ? JSON.parse(payload) : null;
					} catch {
						// Non-JSON error body; surfaced via the raw payload below.
					}
					if (status < 200 || status >= 300) {
						const message =
							(json && json.error && (json.error.message || json.error)) ||
							(payload && payload.slice(0, 300)) ||
							`HTTP ${status}`;
						reject(new Error(typeof message === "string" ? message : `HTTP ${status}`));
						return;
					}
					resolve(json ?? {});
				});
			},
		);
		request.on("timeout", () => request.destroy(new Error("The request timed out.")));
		request.on("error", reject);
		if (data) request.write(data);
		request.end();
	});
}

async function completeAnthropic(key, model, system, prompt, maxTokens) {
	const json = await httpsJson("https://api.anthropic.com/v1/messages", {
		headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
		body: {
			model,
			max_tokens: maxTokens,
			...(system ? { system } : {}),
			messages: [{ role: "user", content: prompt }],
		},
	});
	return Array.isArray(json.content)
		? json.content.filter((block) => block.type === "text").map((block) => block.text).join("")
		: "";
}

async function completeGoogle(key, model, system, prompt) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
	const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
	if (system) body.systemInstruction = { parts: [{ text: system }] };
	const json = await httpsJson(url, { body });
	const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content?.parts;
	return Array.isArray(parts) ? parts.map((part) => part.text || "").join("") : "";
}

async function completeOpenai(key, model, system, prompt) {
	const messages = [];
	if (system) messages.push({ role: "system", content: system });
	messages.push({ role: "user", content: prompt });
	const json = await httpsJson("https://api.openai.com/v1/chat/completions", {
		headers: { Authorization: `Bearer ${key}` },
		body: { model, messages },
	});
	return (json && json.choices && json.choices[0] && json.choices[0].message?.content) || "";
}

// Runs a single prompt against the requested (or default) provider using the
// locally stored key. Throws a friendly error if no key is configured.
async function aiComplete(args) {
	const request = args && typeof args === "object" ? args : {};
	const provider = resolveRequestedProvider(request.provider);
	const config = aiPreferences.providers[provider];
	const apiKey = resolveKey(provider);
	if (!config || !apiKey) {
		throw new Error(`No API key set for ${AI_PROVIDER_LABELS[provider]}. Add it in Settings → Integrations.`);
	}
	const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : config.model;
	const system = typeof request.system === "string" ? request.system : "";
	const prompt = typeof request.prompt === "string" ? request.prompt : "";
	if (!prompt.trim()) throw new Error("Prompt is empty.");
	const maxTokens = Math.min(4096, Math.max(1, Math.round(Number(request.maxTokens) || 1024)));

	let text = "";
	if (provider === "anthropic") text = await completeAnthropic(apiKey, model, system, prompt, maxTokens);
	else if (provider === "google") text = await completeGoogle(apiKey, model, system, prompt);
	else text = await completeOpenai(apiKey, model, system, prompt);

	return { text, provider, model };
}

module.exports = {
	AI_PROVIDERS,
	loadAiPreferences,
	getPublicAiConfig,
	setAiConfig,
	aiComplete,
	setActiveEnvironmentProvider,
	getActiveEnvironmentProvider,
	resolveRequestedProvider,
};
