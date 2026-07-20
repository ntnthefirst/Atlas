const path = require("node:path");
const https = require("node:https");
const fs = require("node:fs");
const { app } = require("electron");

// ---------------------------------------------------------------------------
// AI provider integrations (Claude / Gemini / OpenAI-compatible).
//
// All calls go through the main process so the user's API keys never touch the
// renderer: the renderer sends a prompt + which provider to use, the key is read
// from local storage here, and only the resulting text is handed back. Keys are
// stored on-device in the app's userData folder and are only sent to the single
// provider the user picked for a given request.
// ---------------------------------------------------------------------------

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

// Shown in the model picker before a key is set, and whenever listing models
// from the provider fails — so the dropdown is never empty.
const FALLBACK_MODELS = {
	anthropic: [
		{ id: "claude-opus-4-8", label: "Claude Opus 4.8" },
		{ id: "claude-sonnet-5", label: "Claude Sonnet 5" },
		{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
	],
	google: [
		{ id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
		{ id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
	],
	openai: [
		{ id: "gpt-4o", label: "GPT-4o" },
		{ id: "gpt-4o-mini", label: "GPT-4o mini" },
	],
};

const emptyProvider = (provider) => ({ apiKey: "", model: DEFAULT_MODELS[provider] });

const defaultAiPreferences = () => ({
	defaultProvider: "anthropic",
	providers: {
		anthropic: emptyProvider("anthropic"),
		google: emptyProvider("google"),
		openai: emptyProvider("openai"),
	},
});

let aiPreferences = defaultAiPreferences();

function normalizeAiPreferences(raw) {
	const base = defaultAiPreferences();
	if (!raw || typeof raw !== "object") return base;
	if (AI_PROVIDERS.includes(raw.defaultProvider)) base.defaultProvider = raw.defaultProvider;
	const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
	for (const provider of AI_PROVIDERS) {
		const entry = providers[provider];
		if (entry && typeof entry === "object") {
			base.providers[provider] = {
				apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
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

function loadAiPreferences() {
	try {
		aiPreferences = normalizeAiPreferences(JSON.parse(fs.readFileSync(aiPrefsPath(), "utf8")));
	} catch {
		aiPreferences = defaultAiPreferences();
	}
	return aiPreferences;
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
			hasKey: Boolean(aiPreferences.providers[provider].apiKey),
			model: aiPreferences.providers[provider].model,
			label: AI_PROVIDER_LABELS[provider],
		};
	}
	return { defaultProvider: aiPreferences.defaultProvider, providers };
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
				aiPreferences.providers[provider].apiKey = entry.apiKey.trim();
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
	const provider = AI_PROVIDERS.includes(request.provider) ? request.provider : aiPreferences.defaultProvider;
	const config = aiPreferences.providers[provider];
	if (!config || !config.apiKey) {
		throw new Error(`No API key set for ${AI_PROVIDER_LABELS[provider]}. Add it in Settings → Integrations.`);
	}
	const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : config.model;
	const system = typeof request.system === "string" ? request.system : "";
	const prompt = typeof request.prompt === "string" ? request.prompt : "";
	if (!prompt.trim()) throw new Error("Prompt is empty.");
	const maxTokens = Math.min(4096, Math.max(1, Math.round(Number(request.maxTokens) || 1024)));

	let text = "";
	if (provider === "anthropic") text = await completeAnthropic(config.apiKey, model, system, prompt, maxTokens);
	else if (provider === "google") text = await completeGoogle(config.apiKey, model, system, prompt);
	else text = await completeOpenai(config.apiKey, model, system, prompt);

	return { text, provider, model };
}

// Lists the models the configured key can actually use, so the picker offers
// real choices instead of a free-text box. Falls back to a curated list when
// there's no key yet or the provider can't be reached — the dropdown is never
// empty, and the caller is told which source it got.
async function listAiModels(providerName) {
	const provider = AI_PROVIDERS.includes(providerName) ? providerName : aiPreferences.defaultProvider;
	const config = aiPreferences.providers[provider];
	const fallback = FALLBACK_MODELS[provider];

	if (!config || !config.apiKey) {
		return { ok: true, provider, models: fallback, source: "fallback" };
	}

	try {
		let models = [];
		if (provider === "anthropic") {
			const json = await httpsJson("https://api.anthropic.com/v1/models?limit=100", {
				method: "GET",
				headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
			});
			models = (json.data || []).map((entry) => ({
				id: entry.id,
				label: entry.display_name || entry.id,
			}));
		} else if (provider === "google") {
			const json = await httpsJson(
				`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(config.apiKey)}`,
				{ method: "GET" },
			);
			models = (json.models || [])
				// Only models that can actually answer a prompt.
				.filter(
					(entry) =>
						Array.isArray(entry.supportedGenerationMethods) &&
						entry.supportedGenerationMethods.includes("generateContent"),
				)
				.map((entry) => ({
					id: String(entry.name || "").replace(/^models\//, ""),
					label: entry.displayName || entry.name,
				}));
		} else {
			const json = await httpsJson("https://api.openai.com/v1/models", {
				method: "GET",
				headers: { Authorization: `Bearer ${config.apiKey}` },
			});
			models = (json.data || [])
				.map((entry) => ({ id: entry.id, label: entry.id }))
				// The models endpoint also returns embeddings/audio/image models.
				.filter((entry) => /^(gpt|o\d)/i.test(entry.id) && !/embed|audio|realtime|image|tts|whisper/i.test(entry.id));
		}

		models = models.filter((entry) => entry.id).sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) {
			return { ok: true, provider, models: fallback, source: "fallback" };
		}
		return { ok: true, provider, models, source: "live" };
	} catch (error) {
		return {
			ok: false,
			provider,
			models: fallback,
			source: "fallback",
			error: error instanceof Error ? error.message : "Could not list models.",
		};
	}
}

module.exports = {
	AI_PROVIDERS,
	loadAiPreferences,
	getPublicAiConfig,
	setAiConfig,
	aiComplete,
	listAiModels,
};
