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

// Normalizes a single tab's placements against its (already-clamped) grid
// size: drops entries with an unknown widget or duplicate id, clamps each
// placement's w/h to fit inside the grid and its x/y to fit alongside that
// size, so a placement can never end up partially or fully off-grid (e.g.
// after the user shrinks the grid from settings).

module.exports = {
	clampNumber,
};
