// Thin wrapper around a raw node-sqlite3-wasm `Database` connection.
//
// This exists as a standalone module (rather than living on the
// AtlasDatabase class) because the legacy sql.js import flow
// (see legacy-import.cjs) needs to run schema migrations against a bare
// connection *before* an AtlasDatabase wrapper exists for it — requiring
// db.cjs from here would create a circular dependency (db.cjs already
// requires the migrations package). AtlasDatabase composes this same helper
// internally, so both paths share one implementation of these primitives.
"use strict";

function wrapDatabase(rawDb) {
	const core = {
		raw: rawDb,

		run(sql, params = []) {
			rawDb.run(sql, params);
		},

		all(sql, params = []) {
			return rawDb.all(sql, params);
		},

		first(sql, params = []) {
			const rows = core.all(sql, params);
			return rows[0] ?? null;
		},

		tableExists(tableName) {
			const row = core.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
			return Boolean(row);
		},

		columnExists(tableName, columnName) {
			if (!core.tableExists(tableName)) {
				return false;
			}
			const cols = core.all(`PRAGMA table_info(${tableName})`);
			return cols.some((col) => col.name === columnName);
		},

		// Runs `fn` inside a transaction, committing on success and rolling
		// back on any thrown error. Safe to call from within another
		// transaction (it detects that one is already open and just runs
		// `fn` inline, letting the outer transaction own commit/rollback).
		transaction(fn) {
			if (rawDb.inTransaction) {
				return fn();
			}
			rawDb.exec("BEGIN");
			try {
				const result = fn();
				rawDb.exec("COMMIT");
				return result;
			} catch (err) {
				if (rawDb.inTransaction) {
					rawDb.exec("ROLLBACK");
				}
				throw err;
			}
		},
	};

	return core;
}

module.exports = { wrapDatabase };
