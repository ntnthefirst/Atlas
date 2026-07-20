// ---------------------------------------------------------------------------
// Update preference schema, defaults and normalization.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Reading and
// writing the file stays in main.cjs, which owns the userData path.
// ---------------------------------------------------------------------------

const UPDATE_PREFS_FILE = "update-preferences.json";
const defaultUpdatePreferences = {
	autoCheck: true,
	includeBeta: false,
};

function normalizeUpdatePreferences(rawValue) {
	if (!rawValue || typeof rawValue !== "object") {
		return { ...defaultUpdatePreferences };
	}

	return {
		autoCheck:
			typeof rawValue.autoCheck === "boolean" ? rawValue.autoCheck : defaultUpdatePreferences.autoCheck,
		includeBeta:
			typeof rawValue.includeBeta === "boolean" ? rawValue.includeBeta : defaultUpdatePreferences.includeBeta,
	};
}

module.exports = {
	UPDATE_PREFS_FILE,
	defaultUpdatePreferences,
	normalizeUpdatePreferences,
};
