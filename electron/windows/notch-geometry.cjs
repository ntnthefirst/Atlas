// ---------------------------------------------------------------------------
// Notch window positioning geometry.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Everything here is
// pure — no BrowserWindow, no screen module, no setBounds — so the placement
// maths (docked left/right/top, free-floating, and which displays a saved
// selection resolves to) can be tested without an Electron runtime. Calling
// screen.getAllDisplays()/getPrimaryDisplay() and notchWindow.setBounds() stays
// in main.cjs.
// ---------------------------------------------------------------------------

const FREE_POSITION_MARGIN = 10;

// Computes the { x, y, width, height } bounds a notch window should occupy on
// a single display, given that display's workArea and the current notch
// preferences (already resolved to plain values by the caller).
//
// - "free" on the primary display, with saved coordinates: use them as-is.
// - "left"/"right": flush against the edge, vertically centered.
// - "top": flush against the top edge, horizontally centered.
// - anything else (including "free" without saved coordinates): centered
//   near the top with a margin.
function computeNotchBounds({ workArea, width, height, position, isPrimary, freeX, freeY }) {
	let x;
	let y;

	if (isPrimary && position === "free" && typeof freeX === "number" && typeof freeY === "number") {
		x = freeX;
		y = freeY;
	} else if (position === "left") {
		// Docked flush against the left edge, vertically centered.
		x = workArea.x;
		y = workArea.y + Math.round((workArea.height - height) / 2);
	} else if (position === "right") {
		// Docked flush against the right edge, vertically centered.
		x = workArea.x + workArea.width - width;
		y = workArea.y + Math.round((workArea.height - height) / 2);
	} else if (position === "top") {
		// Docked flush against the top edge, horizontally centered.
		x = workArea.x + Math.round((workArea.width - width) / 2);
		y = workArea.y;
	} else {
		// "free" without saved coordinates: centered near the top with a margin.
		x = workArea.x + Math.round((workArea.width - width) / 2);
		y = workArea.y + FREE_POSITION_MARGIN;
	}

	return { x: Math.round(x), y: Math.round(y), width, height };
}

// Resolves which of the connected displays should show a notch, given the
// user's saved displayIds preference. Falls back to the primary display
// whenever the saved selection is empty or none of the saved ids are
// connected, so there's always at least one.
function selectTargetDisplays(displays, primaryDisplay, preferredDisplayIds) {
	const selectedIds =
		Array.isArray(preferredDisplayIds) && preferredDisplayIds.length > 0
			? preferredDisplayIds
			: [primaryDisplay.id];
	const matched = displays.filter((display) => selectedIds.includes(display.id));
	return matched.length > 0 ? matched : [primaryDisplay];
}

module.exports = {
	FREE_POSITION_MARGIN,
	computeNotchBounds,
	selectTargetDisplays,
};
