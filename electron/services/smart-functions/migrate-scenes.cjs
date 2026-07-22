// ---------------------------------------------------------------------------
// Smart Functions (WP-3.1) -- migrates existing Notch scenes into smart
// functions. This is the WP's second acceptance criterion: "existing scenes
// migrate automatically and still work."
//
// -- Non-destructive by construction, not by discipline ----------------------
// This module NEVER writes to `notch_layouts` -- it only reads it. A scene
// lives inside a placement's `config` string exactly as it did before this
// package existed; migrating means COPYING its fields into a brand new
// `smart_functions` row, never touching or deleting the source. Even a total
// failure of the smart-functions engine (or of this migration itself) can
// therefore never lose a scene: the Notch button that runs it today keeps
// working unchanged, because nothing about how it works was touched.
//
// -- Idempotent: safe to call every boot -------------------------------------
// main.cjs calls this once, unconditionally, every time the app starts (see
// its own header comment there) -- that is what makes migration "automatic"
// rather than a one-off manual step. Each scene placement's migration key is
// `"<notch_layouts row id>:<placement id>"` (migration 011's `migrated_from`,
// UNIQUE); before inserting, this module checks store.findByMigratedFrom and
// skips anything already migrated. A placement whose `config` fails to parse
// -- or parses to a scene with no actions at all (see sceneHasActions below)
// -- is skipped, never migrated as an empty/broken rule and never mutated.
//
// -- Reimplementing parseSceneConfig, not importing it -----------------------
// src/scenes.ts is renderer-side TypeScript (ESM, bundled by Vite); nothing
// under electron/ requires anything from src/ anywhere in this codebase (main
// and renderer are two separate module worlds; see this WP's final report for
// the grep that confirmed it), so this is a small, deliberate CommonJS port of
// exactly the same tolerant parsing -- same defaults, same "never throw"
// guarantee -- kept here rather than force a cross-boundary import neither
// side's build supports.
// ---------------------------------------------------------------------------

"use strict";

const { parseEnvironmentConfig } = require("../../config/environment-config.cjs");
const store = require("./store.cjs");

const asString = (value) => (typeof value === "string" ? value : "");
const asStringList = (value) =>
	Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];

// Mirrors src/scenes.ts#parseSceneConfig exactly: malformed/missing input
// resolves to inert defaults, never throws.
function parseSceneConfigForMigration(config) {
	const base = { label: "New scene", icon: "RocketLaunchIcon", apps: [], urls: [], timer: "none", environmentId: "", tasks: [] };
	if (!config) {
		return base;
	}
	let raw;
	try {
		raw = JSON.parse(config);
	} catch {
		return base;
	}
	if (!raw || typeof raw !== "object") {
		return base;
	}
	const value = raw;
	const timer = value.timer === "start" || value.timer === "stop" ? value.timer : "none";
	const tasks = Array.isArray(value.tasks)
		? value.tasks
				.filter((entry) => Boolean(entry) && typeof entry === "object")
				.map((entry) => ({ title: asString(entry.title), column: asString(entry.column) || undefined }))
				.filter((task) => task.title.trim().length > 0)
		: [];
	return {
		label: asString(value.label) || base.label,
		icon: asString(value.icon) || base.icon,
		apps: asStringList(value.apps),
		urls: asStringList(value.urls),
		timer,
		environmentId: asString(value.environmentId),
		tasks,
	};
}

// Mirrors src/scenes.ts#sceneHasActions exactly.
function sceneHasActions(scene) {
	return (
		scene.apps.some((app) => app.trim()) ||
		scene.urls.some((url) => url.trim()) ||
		scene.tasks.some((task) => task.title.trim()) ||
		scene.timer !== "none" ||
		Boolean(scene.environmentId)
	);
}

// Converts a parsed scene into this package's action list, in the SAME order
// NotchApp.tsx#runScene applies them (environment switch, then timer, then
// tasks, then apps, then urls) so a migrated rule's behaviour matches the
// scene it came from as closely as this engine's vocabulary allows.
function sceneToActions(scene) {
	const actions = [];
	if (scene.environmentId) {
		actions.push({ type: "switchEnvironment", environmentId: scene.environmentId });
	}
	if (scene.timer === "start" || scene.timer === "stop") {
		actions.push({ type: "timer", mode: scene.timer });
	}
	for (const task of scene.tasks) {
		if (task.title.trim()) {
			actions.push({ type: "createTask", title: task.title.trim(), column: task.column || null });
		}
	}
	for (const app of scene.apps) {
		if (app.trim()) {
			actions.push({ type: "launchApp", command: app.trim() });
		}
	}
	for (const url of scene.urls) {
		if (url.trim()) {
			actions.push({ type: "openUrl", url: url.trim() });
		}
	}
	return actions;
}

// Reverse-maps notch_layouts.id -> the ONE environment whose own
// `config.notchLayoutId` points at it, or null when zero or several
// environments do (the shared global default, a context:* layout, or an
// orphaned override) -- see migration 011's header for why "several or zero
// owners" resolves to a global (environment_id = NULL) smart function rather
// than guessing.
function buildLayoutOwnerMap(db) {
	const environments = db.all("SELECT id, config FROM environments");
	const ownersByLayoutId = new Map();
	for (const environment of environments) {
		const config = parseEnvironmentConfig(environment.config, environment);
		if (!config.notchLayoutId) {
			continue;
		}
		const owners = ownersByLayoutId.get(config.notchLayoutId) ?? [];
		owners.push(environment.id);
		ownersByLayoutId.set(config.notchLayoutId, owners);
	}
	const singleOwnerByLayoutId = new Map();
	for (const [layoutId, owners] of ownersByLayoutId) {
		singleOwnerByLayoutId.set(layoutId, owners.length === 1 ? owners[0] : null);
	}
	return singleOwnerByLayoutId;
}

// The migration itself. Runs inside ONE transaction (D9/D10's "all bulk
// writes in db.transaction()") so a boot that gets interrupted partway
// through never leaves some scenes migrated and others not because of a
// crash mid-scan -- either this whole pass commits, or none of it does.
//
// Returns `{ migrated, alreadyMigrated, skipped, scenesSeen }` purely for
// main.cjs's own boot log and this module's tests -- never thrown, since a
// migration that can't run must never block the app from starting (a
// malformed notch_layouts.data row is caught per-row, exactly like every
// other reader of that column in this codebase).
function migrateScenes(db) {
	let migrated = 0;
	let alreadyMigrated = 0;
	let skipped = 0;

	db.transaction(() => {
		const layoutRows = db.all("SELECT id, data FROM notch_layouts");
		const ownerByLayoutId = buildLayoutOwnerMap(db);

		for (const layoutRow of layoutRows) {
			let layout;
			try {
				layout = JSON.parse(layoutRow.data);
			} catch {
				skipped += 1;
				continue;
			}
			const tabs = Array.isArray(layout?.tabs) ? layout.tabs : [];
			for (const tab of tabs) {
				const placements = Array.isArray(tab?.placements) ? tab.placements : [];
				for (const placement of placements) {
					if (!placement || placement.widget !== "scene") {
						continue;
					}
					const migratedFrom = `${layoutRow.id}:${placement.id}`;
					if (store.findByMigratedFrom(db, migratedFrom)) {
						alreadyMigrated += 1;
						continue;
					}
					const scene = parseSceneConfigForMigration(placement.config);
					if (!sceneHasActions(scene)) {
						skipped += 1;
						continue;
					}
					store.createRule(db, {
						label: scene.label,
						environmentId: ownerByLayoutId.get(layoutRow.id) ?? null,
						enabled: true,
						trigger: { type: "manual" },
						conditions: [],
						actions: sceneToActions(scene),
						source: "migrated-scene",
						migratedFrom,
					});
					migrated += 1;
				}
			}
		}
	});

	return { migrated, alreadyMigrated, skipped, scenesSeen: migrated + alreadyMigrated + skipped };
}

module.exports = {
	parseSceneConfigForMigration,
	sceneHasActions,
	sceneToActions,
	buildLayoutOwnerMap,
	migrateScenes,
};
