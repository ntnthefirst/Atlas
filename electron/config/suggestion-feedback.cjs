"use strict";

// ---------------------------------------------------------------------------
// The feedback loop's persisted STATE (WP-3.7) -- deliberately a separate file
// from electron/config/suggestion-prefs.cjs, because this is not a preference.
// It holds one thing: for each (environment, pattern type) category the user
// has explicitly reset, the moment they reset it.
//
// -- Why a watermark, and not deleting the events ---------------------------
// "Suppression is inspectable and resettable by the user" (this WP's own
// acceptance criterion) could be implemented by deleting the
// `suggestion.dismissed` rows behind a suppression. It must not be. Those rows
// are the user's own activity log -- the same table WP-3.3's miner reads, the
// same table the vision's "remove temporary learning data" step deliberately
// scopes AROUND -- and destroying real history to change a derived verdict is
// the wrong trade in every direction: it is irreversible, it silently corrupts
// anything else that reads those events, and it is not even necessary.
//
// A watermark says the same thing non-destructively: everything at or before
// this timestamp no longer counts toward this category's verdict.
// electron/services/suggestion-surfacing/feedback.cjs applies it while
// summarizing, the events stay exactly where they are, and a reset can be
// reasoned about (and, if it ever needed to be, undone) because nothing was
// thrown away.
//
// -- Shape -------------------------------------------------------------------
// {
//   resets: { "<environmentId>::<patternType>": "<ISO timestamp>", ... }
// }
//
// Pure -- no Electron, no filesystem -- exactly like every sibling config
// module: this file owns the shape and normalization, and
// suggestion-manager.cjs is the only place that reads or writes it on disk.
// ---------------------------------------------------------------------------

const SUGGESTION_FEEDBACK_FILE = "suggestion-feedback.json";

function defaultSuggestionFeedbackState() {
	return { resets: {} };
}

// Never throws. A corrupted file, a key that isn't a string, a value that
// isn't a parsable timestamp -- each is dropped individually rather than
// taking the whole state down with it, because the cost of one lost reset is
// a category coming back, while the cost of throwing here is the suggestion
// pipeline failing outright.
function normalizeSuggestionFeedbackState(raw) {
	const base = defaultSuggestionFeedbackState();
	if (!raw || typeof raw !== "object" || !raw.resets || typeof raw.resets !== "object") {
		return base;
	}
	for (const [key, value] of Object.entries(raw.resets)) {
		if (typeof key !== "string" || !key) {
			continue;
		}
		if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
			continue;
		}
		base.resets[key] = value;
	}
	return base;
}

module.exports = {
	SUGGESTION_FEEDBACK_FILE,
	defaultSuggestionFeedbackState,
	normalizeSuggestionFeedbackState,
};
