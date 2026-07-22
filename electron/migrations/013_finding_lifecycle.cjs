// Migration 013 (WP-3.4) -- the lifecycle columns `findings` needs to drive
// the product vision's seven-step flow (detect -> temporary finding ->
// suggestion -> accept/ignore -> smart function -> purge -> keep mining)
// beyond the bare `status` column migration 012 already shipped.
//
// Five nullable/defaulted columns, all added via `ALTER TABLE ... ADD COLUMN`
// (never a table rebuild) -- exactly migration 007's own precedent for why
// that's safe: every existing row gets the documented default/NULL, which is
// always the correct interpretation for a finding that predates this
// migration (see each column below).
//
//   ignore_count      INTEGER NOT NULL DEFAULT 0
//     How many times this finding has been ignored. Existing rows have never
//     been ignored, so 0 is exactly right, not a placeholder. This is the
//     input electron/services/pattern-miner/finding-lifecycle.cjs's
//     computeBackoffMs() uses to make each successive ignore's suppression
//     window longer than the last.
//
//   suppressed_until  TEXT (nullable)
//     The ISO timestamp before which an "ignored" finding must not resurface
//     -- NULL for every finding that isn't currently ignored (including every
//     pre-existing row, none of which are).
//
//   suggested_at      TEXT (nullable)
//     When this finding most recently entered the "suggested" state (see
//     finding-lifecycle-service.cjs#ensureSuggested) -- the reference point
//     isFindingExpired() counts forward from, falling back to `created_at`
//     for a finding that was never explicitly suggested. NULL for every
//     pre-existing row (WP-3.3 never wrote this column, and none of them have
//     been suggested through this WP's new flow yet).
//
//   decided_at        TEXT (nullable)
//     When this finding was last accepted, ignored, or expired -- purely a
//     timestamp for WP-3.6's own "when did this happen" display; nothing in
//     this WP's own logic reads it back. NULL until a decision is made.
//
//   accepted_rule_id  TEXT (nullable)
//     The `smart_functions.id` this finding became, once accepted -- lets a
//     caller jump straight from a finding to the rule it produced without a
//     second lookup by `migrated_from`. NULL until accepted; stays NULL
//     forever for anything ignored/expired.
//
// -- Why no CHECK constraint on `status` here --------------------------------
// Migration 012 already defined `status TEXT NOT NULL DEFAULT 'new'` with no
// CHECK constraint, on the same "SQLite's ALTER TABLE is limited" reasoning
// this migration's own header repeats -- adding one now would need a table
// rebuild, not an ADD COLUMN. The legal-transition guarantee
// (electron/services/pattern-miner/finding-lifecycle.cjs's canTransition())
// is enforced entirely in application code, exactly like every other
// "closed vocabulary in a TEXT column" in this schema (smart_functions.source,
// findings.pattern_type, ...).
"use strict";

module.exports = {
	version: 13,
	name: "013_finding_lifecycle",

	up(db) {
		if (!db.columnExists("findings", "ignore_count")) {
			db.run(`ALTER TABLE findings ADD COLUMN ignore_count INTEGER NOT NULL DEFAULT 0`);
		}
		if (!db.columnExists("findings", "suppressed_until")) {
			db.run(`ALTER TABLE findings ADD COLUMN suppressed_until TEXT`);
		}
		if (!db.columnExists("findings", "suggested_at")) {
			db.run(`ALTER TABLE findings ADD COLUMN suggested_at TEXT`);
		}
		if (!db.columnExists("findings", "decided_at")) {
			db.run(`ALTER TABLE findings ADD COLUMN decided_at TEXT`);
		}
		if (!db.columnExists("findings", "accepted_rule_id")) {
			db.run(`ALTER TABLE findings ADD COLUMN accepted_rule_id TEXT`);
		}

		// Backs finding-lifecycle-service.cjs's resurfaceDueFindings() sweep --
		// "every currently-ignored finding" is its own first filter, before it
		// even looks at suppressed_until, so the same (status, ...) shape
		// idx_findings_status (migration 012) already indexes covers this
		// exactly; no new index is needed for that query. accepted_rule_id gets
		// its own plain index (most rows are NULL, but this schema has no
		// precedent for a partial index, so this stays consistent with every
		// other index here) purely for the "jump from a smart function back to
		// the finding that produced it" direction (WP-3.6).
		db.run("CREATE INDEX IF NOT EXISTS idx_findings_accepted_rule_id ON findings (accepted_rule_id)");
	},
};
