"use strict";

// ---------------------------------------------------------------------------
// The provider registry (WP-4.1) -- discovery, not a list.
//
// -- Why a directory scan and not an array of requires -----------------------
// WP-4.1's fourth acceptance criterion is "adding a provider requires no
// changes outside its own module". An array of `require("./providers/x.cjs")`
// lines would miss that by exactly one line, every time, forever -- and that
// one line is precisely the thing someone adding a provider in six months
// forgets, producing a module that exists, passes its own tests, and is never
// reachable. So this scans ./providers/ and registers whatever it finds.
//
// The cost of a scan is a fragile-feeling indirection, paid for in two ways:
// ./contract.cjs#validateProviderModule refuses anything that does not meet
// the contract, and a module that throws while being required is skipped
// rather than taking the whole AI layer down with it. A broken provider costs
// you that provider, never the other three.
//
// `loadProviders(dir)` takes its directory as an argument so a test can point
// it at a fixture directory and prove the discovery itself works -- which is
// the only honest way to test "adding a file is enough".
//
// -- Nothing here ever sees a key --------------------------------------------
// The registry deals in modules and capabilities. Keys are read in
// electron/ai.cjs and passed straight to the one provider handling that one
// request; no key is stored here, cached here, or logged here.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const { validateProviderModule, normalizeCapabilities, supports } = require("./contract.cjs");

const PROVIDERS_DIR = path.join(__dirname, "providers");

/**
 * Requires every `.cjs` file in `dir` and keeps the ones that satisfy the
 * contract. Returns `{ providers, problems }` -- `problems` is never thrown,
 * so a caller (or a test) can surface a misbehaving module without any user
 * losing access to the providers that are fine.
 */
function loadProviders(dir = PROVIDERS_DIR) {
	const providers = new Map();
	const problems = [];

	let entries = [];
	try {
		entries = fs.readdirSync(dir);
	} catch (error) {
		// No providers directory at all is a broken install, not a crash: the
		// AI layer reports "no providers" and the rest of Atlas runs.
		return { providers, problems: [{ file: dir, error: error.message }] };
	}

	for (const entry of entries.filter((name) => name.endsWith(".cjs")).sort()) {
		const fullPath = path.join(dir, entry);
		let candidate;
		try {
			candidate = require(fullPath);
		} catch (error) {
			problems.push({ file: entry, error: `could not be loaded: ${error.message}` });
			continue;
		}
		const { ok, errors } = validateProviderModule(candidate);
		if (!ok) {
			problems.push({ file: entry, error: errors.join("; ") });
			continue;
		}
		if (providers.has(candidate.id)) {
			// Two modules claiming one id would make "which provider answered"
			// unanswerable. First wins (the scan is sorted, so it is stable).
			problems.push({ file: entry, error: `duplicate provider id "${candidate.id}"` });
			continue;
		}
		providers.set(candidate.id, {
			...candidate,
			capabilities: normalizeCapabilities(candidate.capabilities),
		});
	}

	return { providers, problems };
}

// Loaded once at require time. Providers are stateless module objects, so
// there is nothing to refresh -- and a scan on every request would mean the
// filesystem sitting in the path of every AI call.
const { providers: REGISTERED, problems: REGISTRATION_PROBLEMS } = loadProviders();

function getProvider(id) {
	return REGISTERED.get(id) ?? null;
}

function listProviders() {
	return [...REGISTERED.values()];
}

/** Just the ids, in a stable order -- what preference normalization keys off. */
function listProviderIds() {
	return [...REGISTERED.keys()];
}

/**
 * The renderer-safe description of one provider: what it is called, what model
 * it defaults to, and what it can do. Deliberately contains no key, no
 * endpoint and no header -- this is the shape that crosses the IPC boundary.
 */
function describeProvider(provider) {
	if (!provider) {
		return null;
	}
	return {
		id: provider.id,
		label: provider.label,
		defaultModel: provider.defaultModel,
		capabilities: { ...normalizeCapabilities(provider.capabilities) },
	};
}

function describeAll() {
	return listProviders().map(describeProvider);
}

module.exports = {
	PROVIDERS_DIR,
	loadProviders,
	getProvider,
	listProviders,
	listProviderIds,
	describeProvider,
	describeAll,
	supports,
	REGISTRATION_PROBLEMS,
};
