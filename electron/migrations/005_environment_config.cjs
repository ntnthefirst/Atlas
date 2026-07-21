// Migration 005 — the environment configuration model (WP-1.1): adds a
// `config` TEXT column to `environments`, holding a JSON document of
// per-environment settings (appearance, Notch layout reference, AI
// defaults, integration enablement, startup behaviour — see
// electron/config/environment-config.cjs for the schema, defaults and the
// defensive parser every reader goes through).
//
// `isolation_mode` (migration 004, WP-0.8) stays exactly where it is — a
// first-class column, not folded into this document. Duplicating a
// security-relevant setting into two places is exactly the kind of drift a
// security promise can't survive, so this column deliberately does not
// carry it.
//
// No CHECK constraint here, unlike migration 004's two-value
// `isolation_mode` enum: this is an open-ended JSON document, not a closed
// set of values, so there is no single SQL expression that could validate
// it at the schema level. Validity is enforced in application code instead
// — electron/config/environment-config.cjs's parser never throws and always
// falls back per-field, so a malformed value here can never crash the app,
// only ever fall back to a default for whichever field is bad.
//
// `ADD COLUMN config TEXT` with no default, nullable: every existing row —
// every environment created before this migration ever ran — gets NULL,
// not a backfilled JSON blob. Per D3, this migration does not attempt to
// synthesize a config in SQL. The actual defaulting (deriving sensible
// values, in particular `appearance.accent`, from that row's own existing
// icon/accent/preset, so an existing user's accent is never silently reset)
// happens in application code the moment a NULL config is first read —
// see db.cjs#getEnvironmentConfig and parseEnvironmentConfig's `environment`
// seed parameter.
"use strict";

module.exports = {
	version: 5,
	name: "005_environment_config",

	up(db) {
		if (!db.columnExists("environments", "config")) {
			db.run(`ALTER TABLE environments ADD COLUMN config TEXT`);
		}
	},
};
