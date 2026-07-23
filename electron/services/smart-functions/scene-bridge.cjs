"use strict";

// ---------------------------------------------------------------------------
// The one path a Notch scene button runs through.
//
// -- What this fixes ---------------------------------------------------------
// WP-3.1's goal was "scenes become a special case of [the engine]". Its
// migration (./migrate-scenes.cjs) copied every scene into a `smart_functions`
// row, but nothing ever invoked those rows: the Notch button kept calling a
// SECOND, complete implementation of the same five actions living in the
// renderer (src/components/notch/NotchApp.tsx#runScene). Atlas therefore had
// two engines for one action vocabulary, and they could not agree:
//
//   - editing a scene in the Notch editor changed the button but not the rule;
//   - editing the rule in the Smart Functions panel changed neither the button
//     nor the scene;
//   - a bug fixed in one stayed broken in the other;
//   - a sixth action type added to ./model.cjs could never reach a scene
//     button at all.
//
// That is exactly the "half-migrated state spanning a gap" binding decision D5
// forbids. This module closes it: the renderer no longer executes anything,
// and `runManually` is the single execution path.
//
// -- The scene config stays the source of truth ------------------------------
// A migrated rule is DERIVED (`source: "migrated-scene"`), not authored. The
// scene inside `notch_layouts` is what the user actually edits, so
// `resolveSceneRule` re-syncs the rule's label and actions from that config on
// every run rather than trusting a copy taken at boot. Without this, editing a
// scene after migration would leave the button running the pre-edit version --
// which is the same divergence in a new place.
//
// Only `label` and `actions` are re-synced. `enabled` and `environmentId` are
// deliberately left alone after creation: those are decisions the user makes
// about the RULE (in the Smart Functions panel), not facts about the scene,
// and silently reverting them on the next button press would be its own bug.
// A rule the user has turned off therefore does not fire, and `runManually`
// reports `disabled` rather than the button silently doing nothing.
//
// -- Still never writes to notch_layouts -------------------------------------
// Same guarantee ./migrate-scenes.cjs makes and for the same reason: this
// module READS the layout and writes only `smart_functions`. A scene is never
// mutated or deleted by anything here, so the original config remains intact
// and recoverable even if the engine misbehaves.
// ---------------------------------------------------------------------------

const store = require("./store.cjs");
const {
	parseSceneConfigForMigration,
	sceneHasActions,
	sceneToActions,
	buildLayoutOwnerMap,
} = require("./migrate-scenes.cjs");

// The same `<notch_layouts row id>:<placement id>` key migrate-scenes.cjs
// writes, spelled once so the two can never drift into keying differently and
// producing a duplicate rule for one scene.
function sceneKeyFor(layoutId, placementId) {
	return `${layoutId}:${placementId}`;
}

// Finds one scene placement inside a resolved layout. Returns null for a
// placement that no longer exists (deleted from the layout while the Notch was
// still showing it) or that is not a scene at all.
function findScenePlacement(preferences, placementId) {
	const tabs = Array.isArray(preferences?.tabs) ? preferences.tabs : [];
	for (const tab of tabs) {
		const placements = Array.isArray(tab?.placements) ? tab.placements : [];
		for (const placement of placements) {
			if (placement && placement.id === placementId && placement.widget === "scene") {
				return placement;
			}
		}
	}
	return null;
}

/**
 * Resolves the smart function for one scene button, creating it if the boot
 * migration never saw it (a scene added since) and re-syncing it if the scene
 * has been edited since. `environmentId` is the ACTIVE environment, which is
 * what decides whose layout is showing -- the layout id is resolved here from
 * the database rather than passed in, so the renderer never has to know it.
 */
function resolveSceneRule(db, { placementId, environmentId } = {}) {
	if (!db) {
		return { ok: false, reason: "not_ready", error: "Database not ready." };
	}
	if (!placementId) {
		return { ok: false, reason: "not_found", error: "No scene given." };
	}

	const resolution = db.getEffectiveNotchPreferences(environmentId || null);
	const placement = findScenePlacement(resolution?.preferences, placementId);
	if (!placement) {
		return { ok: false, reason: "not_found", error: "That scene is no longer on the notch." };
	}

	const scene = parseSceneConfigForMigration(placement.config);
	if (!sceneHasActions(scene)) {
		// Same rule the migration applies -- an empty scene is never stored as a
		// rule that does nothing.
		return { ok: false, reason: "empty_scene", error: "This scene has no actions set up yet." };
	}

	const migratedFrom = sceneKeyFor(resolution.layoutId, placementId);
	const actions = sceneToActions(scene);
	const existing = store.findByMigratedFrom(db, migratedFrom);

	if (!existing) {
		const rule = store.createRule(db, {
			label: scene.label,
			// Only meaningful at creation -- see this file's header on why the
			// owner is not re-derived on every run.
			environmentId: buildLayoutOwnerMap(db).get(resolution.layoutId) ?? null,
			enabled: true,
			trigger: { type: "manual" },
			conditions: [],
			actions,
			source: "migrated-scene",
			migratedFrom,
		});
		return { ok: true, rule, created: true };
	}

	return { ok: true, rule: store.updateRule(db, existing.id, { label: scene.label, actions }), created: false };
}

module.exports = { sceneKeyFor, findScenePlacement, resolveSceneRule };
