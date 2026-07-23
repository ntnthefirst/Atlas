// Migration 014 (WP-3.6) -- the ONE new column `findings` needs for the
// "edit" operation in the vision's full control surface (accept, reject,
// delete, pause, convert, move between environments, edit).
//
// -- Why only a label, and why it's nullable --------------------------------
// A finding's own statistics (occurrences/trials/confidence/baseline_probability/
// lift/p_value) and its identity (trigger_type/trigger_subject/follow_type/
// follow_subject) are MINED FACTS, not user input -- letting a user hand-edit
// any of those would be falsifying the very evidence this whole engine exists
// to surface honestly. `label` is the one field with no bearing on any
// statistic: a free-text override for the auto-generated description
// (electron/services/pattern-miner/finding-translator.cjs#buildFindingRuleLabel),
// exactly like a smart function's own `label` is already freely renameable
// post-accept (see finding-lifecycle-service.cjs's own "editable exactly like
// a hand-made rule" precedent). NULL (every pre-existing row, and any finding
// that has never been edited) means "use the auto-generated description" --
// never a placeholder that needs backfilling.
//
// `ALTER TABLE ... ADD COLUMN`, never a table rebuild -- migration 013's own
// precedent for why that's safe here too.
"use strict";

module.exports = {
	version: 14,
	name: "014_finding_label",

	up(db) {
		if (!db.columnExists("findings", "label")) {
			db.run(`ALTER TABLE findings ADD COLUMN label TEXT`);
		}
	},
};
