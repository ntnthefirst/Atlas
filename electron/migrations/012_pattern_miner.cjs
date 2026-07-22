// Migration 012 (WP-3.3) -- the pattern miner's own tables: one row per
// discovered sequential co-occurrence pattern ("B follows A"), plus the raw
// event ids that produced it, kept in a SEPARATE table on purpose.
//
// -- Two tables, not one, because the two halves have different lifetimes ---
// `findings` is a durable summary: the pattern itself (A, B, the window, the
// statistics that justified it), the kind of thing WP-3.4's lifecycle (accept
// / ignore / expire) and WP-3.6's management surface operate on. It must
// still exist after WP-3.4's purge step runs.
//
// `findings_evidence` is exactly the "temporary learning data" the product
// vision (see PRODUCT-VISION.md's seven-step flow, step 6: "Remove temporary
// learning data") and this WP's own brief describe: the individual event ids
// that made up a finding's supporting occurrences, needed by WP-3.6 ("the
// user can see the evidence behind a finding -- which events produced it")
// but explicitly meant to be PURGEABLE independently of the finding it
// belongs to. `DELETE FROM findings_evidence WHERE finding_id = ?` never
// touches `findings` itself -- the summary (occurrences/confidence/lift/
// pValue, already persisted as plain columns on `findings`) survives the
// purge; only the row-level trail of exactly which events contributed does
// not. Splitting these into two tables now, rather than storing evidence as
// a JSON blob column on `findings`, is what makes that purge a single
// indexed DELETE instead of a read-modify-write of the finding row itself.
//
// -- `environment_id` is NOT nullable here, unlike `files`/`smart_functions` -
// a finding is never "global": the whole point of WP-0.8's isolation model is
// that a pattern is mined from exactly one environment's own events (see
// electron/services/pattern-miner/mine-worker.cjs's header) and must never be
// presented as if it applies anywhere else. `NOT NULL` is a second, structural
// guard on top of that -- a finding with no environment could otherwise only
// mean a bug that skipped scoping when it was written.
//
// -- `status` exists now, even though WP-3.4 (finding lifecycle) is what
// actually drives it through accept/ignore/expire -- so that migration never
// has to ALTER this table (SQLite's ALTER TABLE is limited, and every other
// migration in this schema avoids needing it). Defaults to 'new'; WP-3.3
// itself never writes anything else.
"use strict";

module.exports = {
	version: 12,
	name: "012_pattern_miner",

	up(db) {
		db.run(`CREATE TABLE IF NOT EXISTS findings (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			pattern_type TEXT NOT NULL,
			trigger_type TEXT NOT NULL,
			trigger_subject TEXT,
			follow_type TEXT NOT NULL,
			follow_subject TEXT,
			window_minutes INTEGER NOT NULL,
			occurrences INTEGER NOT NULL,
			trials INTEGER NOT NULL,
			confidence REAL NOT NULL,
			baseline_probability REAL NOT NULL,
			lift REAL NOT NULL,
			p_value REAL NOT NULL,
			status TEXT NOT NULL DEFAULT 'new',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);

		// The miner's own "have I already surfaced this exact pair for this
		// environment" check (re-running mining must not create a duplicate row
		// every time the same real pattern is re-detected -- see store.cjs's
		// upsert-by-this-tuple logic) and the Settings surface's own "findings
		// for this environment" listing.
		db.run(
			"CREATE INDEX IF NOT EXISTS idx_findings_environment_pattern ON findings (environment_id, trigger_type, trigger_subject, follow_type, follow_subject)",
		);
		db.run("CREATE INDEX IF NOT EXISTS idx_findings_status ON findings (environment_id, status)");

		db.run(`CREATE TABLE IF NOT EXISTS findings_evidence (
			id INTEGER PRIMARY KEY,
			finding_id TEXT NOT NULL,
			trigger_event_id INTEGER NOT NULL,
			follow_event_id INTEGER NOT NULL
		)`);

		// The only two access patterns evidence ever needs: "every evidence row
		// for finding X" (WP-3.6's evidence view, and WP-3.4's purge -- both key
		// on finding_id alone) -- a single index on the FK column covers both,
		// including the purge's own DELETE.
		db.run("CREATE INDEX IF NOT EXISTS idx_findings_evidence_finding_id ON findings_evidence (finding_id)");
	},
};
