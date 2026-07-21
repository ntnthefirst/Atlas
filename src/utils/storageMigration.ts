// One-time localStorage key migration for the map → environment rename
// (WP-0.7).
//
// Renaming these keys in place would have silently orphaned real settings on
// upgrade: the task board's custom columns and card ordering are stored here
// per environment, so an existing user would have opened Atlas to find their
// board reset to defaults with no explanation and no way back. The values are
// still on disk under the old names — this just carries them across.
//
// Safe to run on every launch: it is a no-op once migrated, and it never
// overwrites a value that already exists under the new name.

const LEGACY_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["atlas.taskOrderByMap", "atlas.taskOrderByEnvironment"],
	["atlas.taskColumnsByMap", "atlas.taskColumnsByEnvironment"],
	["atlas.settings.pinMapSwitcher", "atlas.settings.pinEnvironmentSwitcher"],
];

// `storage` is injectable so this can be tested without a DOM.
export const migrateLegacyStorageKeys = (storage: Storage = localStorage): number => {
	let migrated = 0;

	for (const [legacyKey, currentKey] of LEGACY_KEY_RENAMES) {
		try {
			// A value already under the new name wins — the user has used a
			// migrated build, so the legacy copy is stale.
			if (storage.getItem(currentKey) !== null) {
				storage.removeItem(legacyKey);
				continue;
			}

			const legacyValue = storage.getItem(legacyKey);
			if (legacyValue === null) {
				continue;
			}

			storage.setItem(currentKey, legacyValue);
			storage.removeItem(legacyKey);
			migrated += 1;
		} catch {
			// Storage can throw (private mode, quota, disabled). Losing a
			// preference is not worth crashing a window over.
		}
	}

	return migrated;
};

export const LEGACY_STORAGE_KEY_RENAMES = LEGACY_KEY_RENAMES;
