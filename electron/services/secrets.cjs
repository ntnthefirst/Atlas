// ---------------------------------------------------------------------------
// Encrypted secret storage (WP-0.4).
//
// Wraps Electron's safeStorage, which delegates to the OS keystore: DPAPI on
// Windows, Keychain on macOS, libsecret/kwallet on Linux. Secrets are written
// as base64 ciphertext into secrets.json in userData; the plaintext never
// touches disk.
//
// The one rule this module will not bend: if the OS cannot encrypt, we refuse
// to store rather than silently falling back to plaintext. A vault that
// quietly stops being a vault is worse than no vault, because the user has no
// way to tell the difference.
//
// Callers should treat `set` as throwing. The renderer never sees a secret
// value — only whether one is present.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const SECRETS_FILE = "secrets.json";
const FILE_VERSION = 1;

// Cached in memory so reads don't hit the disk (and the OS keystore) on every
// call. Written through on every mutation.
let cache = null;

function secretsPath() {
	return path.join(app.getPath("userData"), SECRETS_FILE);
}

function emptyStore() {
	return { version: FILE_VERSION, entries: {} };
}

function readStore() {
	if (cache) {
		return cache;
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(secretsPath(), "utf8"));
		const entries = parsed && typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {};
		// Only keep string values; anything else is corruption and is dropped
		// rather than allowed to throw later at decrypt time.
		const clean = {};
		for (const [key, value] of Object.entries(entries)) {
			if (typeof value === "string" && value) {
				clean[key] = value;
			}
		}
		cache = { version: FILE_VERSION, entries: clean };
	} catch {
		// Missing or unreadable file is the normal first-run case.
		cache = emptyStore();
	}

	return cache;
}

function writeStore(store) {
	cache = store;
	fs.writeFileSync(secretsPath(), JSON.stringify(store, null, 2), "utf8");
}

// True when the OS keystore is usable. False means every `set` will throw, and
// callers should surface that to the user rather than working around it.
function isAvailable() {
	try {
		return safeStorage.isEncryptionAvailable();
	} catch {
		return false;
	}
}

function has(key) {
	return Boolean(readStore().entries[key]);
}

function get(key) {
	const encoded = readStore().entries[key];
	if (!encoded) {
		return "";
	}

	try {
		return safeStorage.decryptString(Buffer.from(encoded, "base64"));
	} catch {
		// Wrong machine, wrong user profile, or a rotated OS key. The ciphertext
		// is unrecoverable — report it as absent so the caller can prompt for a
		// fresh value instead of crashing.
		return "";
	}
}

// Storing an empty value deletes the entry, so callers can clear a secret
// through the same path they set it.
function set(key, value) {
	if (typeof value !== "string" || !value) {
		remove(key);
		return;
	}

	if (!isAvailable()) {
		throw new Error(
			"This device cannot encrypt stored secrets, so Atlas will not save them. Your OS keychain may be unavailable.",
		);
	}

	const store = readStore();
	store.entries[key] = safeStorage.encryptString(value).toString("base64");
	writeStore(store);
}

function remove(key) {
	const store = readStore();
	if (!(key in store.entries)) {
		return;
	}
	delete store.entries[key];
	writeStore(store);
}

// Test seam: drops the in-memory cache so the next read comes off disk.
function resetCache() {
	cache = null;
}

module.exports = {
	SECRETS_FILE,
	isAvailable,
	has,
	get,
	set,
	remove,
	resetCache,
};
