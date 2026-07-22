import type { LauncherResult } from "../../types";

// ---------------------------------------------------------------------------
// Stable-ordering logic for the launcher's result list (WP-2.1).
//
// The acceptance criterion this exists to satisfy: results must NEVER
// reorder/resort under an active selection. A debounced query still lands
// while the user is mid-arrow-key-navigation, and a naive "just render
// whatever the latest query returned" would yank the row the cursor is
// sitting on to a different position (or off the top entirely) the instant a
// keystroke lands -- exactly the kind of thing that makes a keyboard-first
// launcher feel broken.
//
// Kept here as plain, DOM-free functions (no React) so the ordering rule
// itself is unit-testable without mounting a component -- LauncherWindowApp
// is the only caller.
// ---------------------------------------------------------------------------

// Reconciles a new set of results with whatever is currently displayed.
//
// While `selectionActive` is true (the user has pressed Up/Down at least
// once since the list last reset), every row still present in `nextResults`
// keeps ITS EXISTING POSITION from `previousResults`; rows that disappeared
// are dropped in place (never leaving a gap); brand-new rows are appended at
// the end, never inserted above or around the cursor. Once selection is not
// active (a fresh query session -- the user hasn't arrowed into the list
// yet), the incoming order is used as-is, since there is no cursor position
// to protect.
export function reconcileLauncherResults(
	previousResults: LauncherResult[],
	nextResults: LauncherResult[],
	selectionActive: boolean,
): LauncherResult[] {
	if (!selectionActive || previousResults.length === 0) {
		return nextResults;
	}

	const nextById = new Map(nextResults.map((result) => [result.id, result]));
	const kept: LauncherResult[] = [];
	const seen = new Set<string>();

	// Existing rows first, in their CURRENT order, refreshed with whatever the
	// new payload says about them (title/subtitle may have changed even though
	// the id and position didn't).
	for (const previous of previousResults) {
		const match = nextById.get(previous.id);
		if (match) {
			kept.push(match);
			seen.add(match.id);
		}
	}

	// Then anything genuinely new, appended after -- never displacing a row
	// the cursor might currently be on.
	for (const result of nextResults) {
		if (!seen.has(result.id)) {
			kept.push(result);
		}
	}

	return kept;
}

// Keeps a selected index in range after the list changes size (e.g. the row
// the cursor was on disappeared from the new results) -- never negative,
// never past the end, and 0 for an empty list.
export function clampSelectedIndex(index: number, length: number): number {
	if (length <= 0) {
		return 0;
	}
	if (index < 0) {
		return 0;
	}
	if (index > length - 1) {
		return length - 1;
	}
	return index;
}

// Up/Down arrow-key math, wrapping at both ends (Down from the last row goes
// to the first; Up from the first goes to the last) -- standard launcher/
// combobox behaviour. Returns the unchanged index for an empty list.
export function moveSelection(index: number, length: number, direction: 1 | -1): number {
	if (length <= 0) {
		return 0;
	}
	return (index + direction + length) % length;
}
