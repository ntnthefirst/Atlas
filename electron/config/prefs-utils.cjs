// ---------------------------------------------------------------------------
// Shared preference-normalization primitives.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. These are used by
// more than one preference domain (notch grids and dashboard grids both clamp
// widget geometry), so they live apart from either.
// ---------------------------------------------------------------------------

function clampNumber(value, fallback, min, max) {
	const n = Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

// Same contract as clampNumber, minus the Math.round -- for preference fields
// that are genuinely fractional (a confidence/lift/significance threshold in
// [0, 1] or similar), where rounding would silently collapse every value to
// 0/1/whole numbers. Added for electron/config/pattern-miner-prefs.cjs
// (WP-3.3); clampNumber itself is left untouched since its existing callers
// (grid dimensions, counts) all genuinely want integers.
function clampFloat(value, fallback, min, max) {
	const n = Number.isFinite(value) ? value : fallback;
	return Math.min(Math.max(n, min), max);
}

// Normalizes a single tab's placements against its (already-clamped) grid
// size: drops entries with an unknown widget or duplicate id, clamps each
// placement's w/h to fit inside the grid and its x/y to fit alongside that
// size, so a placement can never end up partially or fully off-grid (e.g.
// after the user shrinks the grid from settings).

module.exports = {
	clampNumber,
	clampFloat,
};
