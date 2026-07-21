import type { Environment, IsolationAllowlistEntry, IsolationMode } from "../types";

// ---------------------------------------------------------------------------
// Isolation-mode copy and the mode-switch call path (WP-1.2).
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the list of what a CONNECTED
// environment shares is never hand-written here, or anywhere in the
// components that use it. It always comes from the allowlist entries the
// main process serves over `isolation:getAllowlist` (electron/data/
// isolation.cjs's CROSS_ENVIRONMENT_ALLOWLIST, paired with its
// CROSS_ENVIRONMENT_SIGNAL_LABELS). `buildConnectedSharedItems` below is
// intentionally a thin pass-through — widen the allowlist in isolation.cjs,
// and every caller of this function (and everything that renders its result)
// tells the truth on the very next IPC round trip, with nothing else to
// remember to update. See src/utils/isolationMode.test.ts for the test that
// pins this down against the real backend constant.
//
// `ENCLOSED_STAYS_ISOLATED_ITEMS` has no equivalent backend constant to
// derive from: WP-0.8 enforces enclosure by BLOCKING every cross-environment
// read path outright, not by naming an allowlist of what's hidden (there is
// nothing to widen or drift). This list is the plain-language mirror of
// PRODUCT-VISION.md's "Environment Intelligence" section instead.
// ---------------------------------------------------------------------------

export const ENCLOSED_STAYS_ISOLATED_ITEMS: readonly string[] = Object.freeze([
	"AI memory",
	"Findings",
	"Indexed data",
	"Connected accounts",
	"Documents",
	"Activity history",
]);

// Never hand-written: this is exactly (and only) the allowlist entries the
// main process reports, in order, mapped down to their labels. Do not add,
// remove, or reorder anything here beyond what `allowlist` itself contains.
export function buildConnectedSharedItems(allowlist: IsolationAllowlistEntry[]): string[] {
	return allowlist.map((entry) => entry.label);
}

function formatList(items: string[]): string {
	if (items.length === 0) {
		// Should not happen in practice (the allowlist is never empty today),
		// but a warning dialog must never claim something is shared when the
		// list it was handed is empty.
		return "nothing beyond what's already true today";
	}
	if (items.length === 1) {
		return items[0];
	}
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// enclosed → connected WIDENS exposure. Warn, plainly, before it happens —
// this is the one direction the WP calls out as needing a warning rather
// than just a confirmation, because it is the direction that gives this
// environment (and every other connected one) new access it didn't have a
// moment ago.
export function buildEnclosedToConnectedWarning(environmentName: string, allowlist: IsolationAllowlistEntry[]): string {
	const shared = formatList(buildConnectedSharedItems(allowlist));
	return (
		`Make "${environmentName}" connected?\n\n` +
		`This widens what it can reach. Once connected, it will read and contribute, with your other ` +
		`connected environments:\n\n` +
		`  • ${shared}\n\n` +
		`Nothing else crosses -- no task, note, file, or activity content, ever. Any environment you keep ` +
		`enclosed stays completely out of this in both directions.`
	);
}

// connected → enclosed makes cross-environment features go quiet. Confirm,
// and say exactly what stops.
export function buildConnectedToEnclosedWarning(environmentName: string): string {
	return (
		`Make "${environmentName}" enclosed?\n\n` +
		`This fully separates it. Cross-environment suggestions and shared behavioural signals stop working for ` +
		`it immediately: it will no longer read anything derived from your other environments, and none of its ` +
		`own activity will contribute to theirs.\n\n` +
		`${ENCLOSED_STAYS_ISOLATED_ITEMS.join(", ")} all stay fully isolated -- exactly as they already are for ` +
		`every enclosed environment.`
	);
}

export function buildIsolationModeWarning(
	environmentName: string,
	nextMode: IsolationMode,
	allowlist: IsolationAllowlistEntry[],
): string {
	return nextMode === "connected"
		? buildEnclosedToConnectedWarning(environmentName, allowlist)
		: buildConnectedToEnclosedWarning(environmentName);
}

export type SwitchIsolationModeArgs = {
	environmentId: string;
	environmentName: string;
	currentMode: IsolationMode;
	nextMode: IsolationMode;
	allowlist: IsolationAllowlistEntry[];
	// Injected rather than reached for directly (`window.confirm`), so this
	// call path is testable without a DOM.
	confirm: (message: string) => boolean;
	// Injected rather than `window.atlas.setEnvironmentIsolationMode` directly,
	// for the same reason.
	setIsolationMode: (environmentId: string, mode: IsolationMode) => Promise<Environment>;
};

// The one call path both transition directions go through: pick the right
// warning copy for the direction actually being taken, ask before doing
// anything, and only then reach for the IPC call that flips the stored mode.
// Returns null (no IPC call made, nothing to update in local state) when the
// user cancels or the requested mode isn't actually a change.
export async function switchIsolationMode({
	environmentId,
	environmentName,
	currentMode,
	nextMode,
	allowlist,
	confirm,
	setIsolationMode,
}: SwitchIsolationModeArgs): Promise<Environment | null> {
	if (currentMode === nextMode) {
		return null;
	}

	const message = buildIsolationModeWarning(environmentName, nextMode, allowlist);
	if (!confirm(message)) {
		return null;
	}

	return setIsolationMode(environmentId, nextMode);
}
