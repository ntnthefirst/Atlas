// ---------------------------------------------------------------------------
// Isolation IPC handlers (isolation:*) — WP-1.2 (isolation enforcement UI).
//
// A single, read-only bridge onto the WP-0.8 policy module
// (electron/data/isolation.cjs). `isolation:getAllowlist` is the one channel
// the isolation-enforcement UI needs to render "here's exactly what a
// Connected environment shares": it forwards describeAllowlist()'s output
// verbatim, never re-describing the allowlist itself. That is the whole
// point -- widen CROSS_ENVIRONMENT_ALLOWLIST (and its label) in isolation.cjs,
// and this channel (and therefore the UI) reports the new truth on the very
// next call, with no second copy anywhere in the renderer to remember to
// update.
//
// Deliberately its own small IPC domain rather than folded into
// electron/ipc/environments.cjs: this channel names no environment id and
// answers no per-environment question (it's the same global list for every
// environment), whereas everything in environments.cjs is either "about
// environment X" or "change environment X". Keeping them apart mirrors the
// isolation.cjs / scoped.cjs split this whole package is built on: policy
// data on one side, per-environment wiring on the other.
// ---------------------------------------------------------------------------

"use strict";

const { describeAllowlist } = require("../data/isolation.cjs");

function register(ipcMain) {
	ipcMain.handle("isolation:getAllowlist", () => describeAllowlist());
}

module.exports = { register };
